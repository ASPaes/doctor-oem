import { getDoctorOemAdmin } from "@/lib/doctoroem-admin.server";
import {
  fetchLicenciamentoOem,
  mapLicenciamentoToRow,
  obterTokenOem,
} from "@/lib/doctoroem.functions";

type TabletCloudFilialResumo = {
  ativo?: boolean;
  matriz?: boolean;
  codFilial?: number;
  nomeFilial?: string;
  cpfCnpj?: string;
  dataCadastro?: string;
  email?: string;
};

type TabletCloudGrupoResumo = {
  codGrupo?: number;
  ativo?: boolean;
  nomeGrupo?: string;
  cpfCnpj?: string;
  produto?: string;
  qtdLojasAtivas?: number;
  qtdLojasDesativadas?: number;
  dataCadastro?: string;
  filiais?: TabletCloudFilialResumo[];
};

type TabletCloudListagemResponse = {
  totalRegistros?: number;
  totalGruposNaPagina?: number;
  pagina?: number;
  data?: TabletCloudGrupoResumo[];
};

type ExistingClienteRow = {
  id: string;
  empresa_codigo: string | number | null;
  filial_codigo: string | number | null;
  cnpj_cpf?: string | null;
};

type Candidate = {
  key: string;
  codEmpresa: number;
  codFilial: number;
  resumo?: TabletCloudGrupoResumo;
  filial?: TabletCloudFilialResumo;
};

type PersistCandidate = {
  key: string;
  row: Record<string, unknown>;
};

export type OemImportResult = {
  inserted: number;
  updated: number;
  total: number;
  scanned: number;
  falhas: number;
  origem: "listagem" | "varredura";
};

const OEM_API_ORIGIN = "https://api.pdvlegal.com.br";
const OEM_LISTAGEM_BATCH = 20;
const OEM_LISTAGEM_PAUSA_MS = 0;
const OEM_VARREDURA_PAUSA_MS = 1000;
const OEM_SCAN_START = 30000;
const OEM_SCAN_END = 33000;
const OEM_OFFSET_FILIAL_PADRAO = 6633;
const OEM_DELTAS_FILIAL = [0, 1, -1, 2, -2];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseInt(value.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseEnvInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildKey(codEmpresa: number, codFilial: number): string {
  return `${codEmpresa}:${codFilial}`;
}

function buildResumoFallback(
  resumo: TabletCloudGrupoResumo,
  filial?: TabletCloudFilialResumo,
): Record<string, unknown> {
  return {
    codEmpresa: resumo.codGrupo,
    codFilial: filial?.codFilial,
    cnpjEmpresa: filial?.cpfCnpj ?? resumo.cpfCnpj,
    nomeEmpresa: filial?.nomeFilial ?? resumo.nomeGrupo,
    razaoSocial: filial?.nomeFilial ?? resumo.nomeGrupo,
    grupoEconomico: resumo.nomeGrupo,
    produto: resumo.produto,
    numeroFiliais: (resumo.qtdLojasAtivas ?? 0) + (resumo.qtdLojasDesativadas ?? 0),
    bloquearLicenca: !(filial?.ativo ?? resumo.ativo ?? true),
    filial: filial
      ? {
          codigo: filial.codFilial,
          nomeFilial: filial.nomeFilial,
          cpfCnpj: filial.cpfCnpj,
          ativo: filial.ativo,
          matriz: filial.matriz,
          dataCadastro: filial.dataCadastro,
          email: filial.email,
        }
      : undefined,
  };
}

async function fetchLicenciamentosPagina(
  accessToken: string,
  pagina: number,
): Promise<TabletCloudListagemResponse> {
  const url = `${OEM_API_ORIGIN}/v1/licenciamento?pagina=${pagina}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });

  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throw new Error(`OEM listagem: HTTP ${resp.status} em ${url} :: ${preview.slice(0, 180)}`);
  }

  const json = (await resp.json().catch(() => null)) as TabletCloudListagemResponse | null;
  if (!json || !Array.isArray(json.data)) {
    throw new Error("OEM listagem: resposta inválida do endpoint /v1/licenciamento.");
  }
  return json;
}

async function carregarExistentes() {
  const supabase = getDoctorOemAdmin();
  const { data, error } = await supabase
    .from("clientes_oem")
    .select("id, empresa_codigo, filial_codigo, cnpj_cpf");

  if (error) throw new Error(`clientes_oem (load): ${error.message}`);

  const existingByKey = new Map<string, string>();
  const existingByCnpj = new Map<string, string>();
  const offsets: number[] = [];

  for (const row of (data ?? []) as ExistingClienteRow[]) {
    const codEmpresa = toNumber(row.empresa_codigo);
    const codFilial = toNumber(row.filial_codigo);
    if (codEmpresa == null || codFilial == null) continue;
    existingByKey.set(buildKey(codEmpresa, codFilial), row.id);
    const cnpj = typeof row.cnpj_cpf === "string" ? row.cnpj_cpf.replace(/\D/g, "") : "";
    if (cnpj) existingByCnpj.set(cnpj, row.id);
    offsets.push(codFilial - codEmpresa);
  }

  return { supabase, existingByKey, existingByCnpj, offsets };
}

async function persistirLote(
  rows: PersistCandidate[],
  existingByKey: Map<string, string>,
  existingByCnpj: Map<string, string>,
): Promise<{ inserted: number; updated: number; falhas: number }> {
  if (!rows.length) return { inserted: 0, updated: 0, falhas: 0 };

  const supabase = getDoctorOemAdmin();
  const existingSnapshot = new Set(existingByKey.keys());
  const payload = rows.map(({ key, row }) => {
    const cnpj = typeof row.cnpj_cpf === "string" ? row.cnpj_cpf.replace(/\D/g, "") : "";
    const id = existingByKey.get(key) ?? (cnpj ? existingByCnpj.get(cnpj) : undefined);
    return id ? { ...row, id } : row;
  });

  const { data, error } = await supabase
    .from("clientes_oem")
    .upsert(payload)
    .select("id, empresa_codigo, filial_codigo, cnpj_cpf");

  if (!error) {
    for (const saved of (data ?? []) as ExistingClienteRow[]) {
      const codEmpresa = toNumber(saved.empresa_codigo);
      const codFilial = toNumber(saved.filial_codigo);
      if (codEmpresa != null && codFilial != null) {
        existingByKey.set(buildKey(codEmpresa, codFilial), saved.id);
      }
      const cnpj = typeof saved.cnpj_cpf === "string" ? saved.cnpj_cpf.replace(/\D/g, "") : "";
      if (cnpj) existingByCnpj.set(cnpj, saved.id);
    }

    let inserted = 0;
    let updated = 0;
    for (const { key } of rows) {
      if (existingSnapshot.has(key)) updated += 1;
      else inserted += 1;
    }
    return { inserted, updated, falhas: 0 };
  }

  console.warn("[OEM import] upsert em lote falhou, usando persistência individual:", error.message);

  let inserted = 0;
  let updated = 0;
  let falhas = 0;

  for (const { key, row } of rows) {
    const cnpj = typeof row.cnpj_cpf === "string" ? row.cnpj_cpf.replace(/\D/g, "") : "";
    const existingId = existingByKey.get(key) ?? (cnpj ? existingByCnpj.get(cnpj) : undefined);

    if (existingId) {
      const { error: updateError } = await supabase
        .from("clientes_oem")
        .update(row)
        .eq("id", existingId);

      if (updateError) {
        falhas += 1;
        console.error(`[OEM import] falha ao atualizar ${key}:`, updateError.message);
        continue;
      }
      updated += 1;
      continue;
    }

    const { data: insertedRow, error: insertError } = await supabase
      .from("clientes_oem")
      .insert(row)
      .select("id, empresa_codigo, filial_codigo, cnpj_cpf")
      .maybeSingle();

    if (insertError) {
      falhas += 1;
      console.error(`[OEM import] falha ao inserir ${key}:`, insertError.message);
      continue;
    }

    const codEmpresa = toNumber(insertedRow?.empresa_codigo);
    const codFilial = toNumber(insertedRow?.filial_codigo);
    if (insertedRow?.id && codEmpresa != null && codFilial != null) {
      existingByKey.set(buildKey(codEmpresa, codFilial), insertedRow.id as string);
    }
    if (insertedRow?.id) {
      const insertedCnpj = typeof insertedRow.cnpj_cpf === "string"
        ? insertedRow.cnpj_cpf.replace(/\D/g, "")
        : "";
      if (insertedCnpj) existingByCnpj.set(insertedCnpj, insertedRow.id as string);
    }
    inserted += 1;
  }

  return { inserted, updated, falhas };
}

async function carregarCandidatosDaListagem(accessToken: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let pagina = 1;
  let totalGruposLidos = 0;
  let totalRegistros = Number.POSITIVE_INFINITY;

  while (totalGruposLidos < totalRegistros) {
    const response = await fetchLicenciamentosPagina(accessToken, pagina);
    const grupos = response.data ?? [];
    totalRegistros = response.totalRegistros ?? totalRegistros;

    if (!grupos.length) break;

    totalGruposLidos += grupos.length;

    for (const grupo of grupos) {
      const codEmpresa = toNumber(grupo.codGrupo);
      if (codEmpresa == null) continue;

      const filiais = Array.isArray(grupo.filiais) && grupo.filiais.length ? grupo.filiais : [undefined];
      for (const filial of filiais) {
        const codFilial = toNumber(filial?.codFilial);
        if (codFilial == null) continue;

        const key = buildKey(codEmpresa, codFilial);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ key, codEmpresa, codFilial, resumo: grupo, filial });
      }
    }

    pagina += 1;
  }

  return candidates;
}

async function importarCandidatos(
  accessToken: string,
  candidates: Candidate[],
  existingByKey: Map<string, string>,
  existingByCnpj: Map<string, string>,
): Promise<{ inserted: number; updated: number; total: number; scanned: number; falhas: number }> {
  let inserted = 0;
  let updated = 0;
  let scanned = 0;
  let falhas = 0;

  for (let i = 0; i < candidates.length; i += OEM_LISTAGEM_BATCH) {
    const batch = candidates.slice(i, i + OEM_LISTAGEM_BATCH);
    const resolved = await Promise.all(
      batch.map(async (candidate): Promise<PersistCandidate | null> => {
        scanned += 1;

        const licDetalhada = await fetchLicenciamentoOem(
          accessToken,
          candidate.codEmpresa,
          candidate.codFilial,
        );

        const payload = licDetalhada ??
          (candidate.resumo
            ? buildResumoFallback(candidate.resumo, candidate.filial)
            : null);
        if (!payload) return null;

        const row = mapLicenciamentoToRow(payload, candidate.codEmpresa, candidate.codFilial);
        if (!row) return null;
        return { key: candidate.key, row };
      }),
    );

    const validRows = resolved.filter((item): item is PersistCandidate => item !== null);
    const saved = await persistirLote(validRows, existingByKey, existingByCnpj);

    inserted += saved.inserted;
    updated += saved.updated;
    falhas += batch.length - validRows.length + saved.falhas;

    console.log(
      `[OEM import] lote ${Math.floor(i / OEM_LISTAGEM_BATCH) + 1}/${Math.ceil(candidates.length / OEM_LISTAGEM_BATCH)} concluído (${inserted} novos, ${updated} atualizados, ${falhas} falhas).`,
    );

    if (OEM_LISTAGEM_PAUSA_MS > 0 && i + OEM_LISTAGEM_BATCH < candidates.length) {
      await sleep(OEM_LISTAGEM_PAUSA_MS);
    }
  }

  return { inserted, updated, total: candidates.length, scanned, falhas };
}

async function tentarListagemCompleta(
  accessToken: string,
  existingByKey: Map<string, string>,
  existingByCnpj: Map<string, string>,
): Promise<OemImportResult | null> {
  const candidates = await carregarCandidatosDaListagem(accessToken);
  if (!candidates.length) return null;

  console.log(`[OEM import] listagem geral detectada: ${candidates.length} filiais encontradas.`);
  const result = await importarCandidatos(accessToken, candidates, existingByKey, existingByCnpj);
  return { ...result, origem: "listagem" };
}

async function descobrirEmpresaPorVarredura(
  accessToken: string,
  codEmpresa: number,
  offsetFilial: number,
): Promise<{ row: PersistCandidate | null; consultas: number }> {
  let consultas = 0;

  for (const delta of OEM_DELTAS_FILIAL) {
    const codFilial = codEmpresa + offsetFilial + delta;
    if (codFilial <= 0) continue;

    consultas += 1;
    const lic = await fetchLicenciamentoOem(accessToken, codEmpresa, codFilial);
    if (!lic) continue;

    const row = mapLicenciamentoToRow(lic, codEmpresa, codFilial);
    if (!row) continue;

    return { row: { key: buildKey(codEmpresa, codFilial), row }, consultas };
  }

  return { row: null, consultas };
}

async function importarPorVarredura(
  accessToken: string,
  existingByKey: Map<string, string>,
  existingByCnpj: Map<string, string>,
  offsets: number[],
): Promise<OemImportResult> {
  const inicio = parseEnvInt("OEM_COD_EMPRESA_INICIO", OEM_SCAN_START);
  const fim = parseEnvInt("OEM_COD_EMPRESA_FIM", OEM_SCAN_END);
  const offsetFilial = offsets.length
    ? offsets.sort((a, b) => a - b)[Math.floor(offsets.length / 2)]
    : OEM_OFFSET_FILIAL_PADRAO;

  let inserted = 0;
  let updated = 0;
  let scanned = 0;
  let falhas = 0;
  let total = 0;

  const empresas = Array.from({ length: fim - inicio + 1 }, (_, index) => inicio + index);

  console.log(
    `[OEM import] listagem indisponível; iniciando varredura ${inicio}..${fim} com offset ${offsetFilial}.`,
  );

  for (let i = 0; i < empresas.length; i += OEM_LISTAGEM_BATCH) {
    const batchEmpresas = empresas.slice(i, i + OEM_LISTAGEM_BATCH);
    const batchResults = await Promise.all(
      batchEmpresas.map((codEmpresa) => descobrirEmpresaPorVarredura(accessToken, codEmpresa, offsetFilial)),
    );

    scanned += batchResults.reduce((sum, item) => sum + item.consultas, 0);
    const rows = batchResults
      .map((item) => item.row)
      .filter((item): item is PersistCandidate => item !== null);

    const dedupedRows = rows.filter(
      (item, index, arr) => arr.findIndex((entry) => entry.key === item.key) === index,
    );
    total += dedupedRows.length;

    const saved = await persistirLote(dedupedRows, existingByKey, existingByCnpj);
    inserted += saved.inserted;
    updated += saved.updated;
    falhas += saved.falhas;

    console.log(
      `[OEM import] lote de varredura ${Math.floor(i / OEM_LISTAGEM_BATCH) + 1}/${Math.ceil(empresas.length / OEM_LISTAGEM_BATCH)} concluído (${inserted} novos, ${updated} atualizados, ${falhas} falhas).`,
    );

    if (i + OEM_LISTAGEM_BATCH < empresas.length) {
      await sleep(OEM_VARREDURA_PAUSA_MS);
    }
  }

  return { inserted, updated, total, scanned, falhas, origem: "varredura" };
}

export async function runBulkImportOem(
  escopo: "bulkSync" | "scheduledSync" | "manualSync",
): Promise<OemImportResult> {
  const { existingByKey, existingByCnpj, offsets } = await carregarExistentes();
  const accessToken = await obterTokenOem(escopo);

  try {
    const listed = await tentarListagemCompleta(accessToken, existingByKey, existingByCnpj);
    if (listed) return listed;
  } catch (error) {
    console.warn(
      "[OEM import] falha ao usar listagem geral; ativando varredura por faixa:",
      error instanceof Error ? error.message : String(error),
    );
  }

  return importarPorVarredura(accessToken, existingByKey, existingByCnpj, offsets);
}