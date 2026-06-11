// ============================================================
// Motor de sincronização OEM por tenant.
// Usa as credenciais salvas em tenant_oem_settings (Cloud central),
// autentica via OAuth2 (password grant) na API OEM da empresa e
// grava clientes/logs no Cloud central com tenant_id.
// ============================================================
import { mapLicenciamentoToRow } from "@/lib/doctoroem.functions";

type TenantCreds = {
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  method: string;
};

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

type ListagemResponse = {
  totalRegistros?: number;
  totalGruposNaPagina?: number;
  pagina?: number;
  data?: TabletCloudGrupoResumo[];
};

export type TenantSyncResult = {
  status: "sucesso" | "erro";
  total: number;
  inseridos: number;
  atualizados: number;
  falhas: number;
  duracaoMs: number;
  mensagem: string;
};

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
  };
}

async function loadTenantCreds(tenantId: string): Promise<TenantCreds> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("tenant_oem_settings")
    .select(
      "oem_api_base_url, oem_api_username, oem_api_password, oem_client_id, oem_client_secret, oem_api_method",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`tenant_oem_settings: ${error.message}`);
  if (!data) throw new Error("Credenciais OEM não cadastradas para esta empresa.");
  const missing: string[] = [];
  if (!data.oem_api_username) missing.push("usuário");
  if (!data.oem_api_password) missing.push("senha");
  if (!data.oem_client_id) missing.push("client_id");
  if (!data.oem_client_secret) missing.push("client_secret");
  if (missing.length) {
    throw new Error(
      `Credenciais OEM incompletas (faltam: ${missing.join(", ")}). Preencha em Configurações.`,
    );
  }
  return {
    baseUrl: (data.oem_api_base_url ?? "https://api.pdvlegal.com.br").replace(/\/+$/, ""),
    username: data.oem_api_username!,
    password: data.oem_api_password!,
    clientId: data.oem_client_id!,
    clientSecret: data.oem_client_secret!,
    method: data.oem_api_method ?? "password",
  };
}

export async function obterTokenTenant(creds: TenantCreds): Promise<string> {
  const body = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    grant_type: creds.method || "password",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const resp = await fetch(`${creds.baseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throw new Error(
      `Falha na autenticação OEM (HTTP ${resp.status}): ${preview.slice(0, 180)}`,
    );
  }
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof json.access_token === "string" ? json.access_token : null;
  if (!token) throw new Error("Resposta de token sem access_token.");
  return token;
}

export async function testTenantConnection(
  tenantId: string,
): Promise<{ ok: true; baseUrl: string } | { ok: false; mensagem: string }> {
  try {
    const creds = await loadTenantCreds(tenantId);
    await obterTokenTenant(creds);
    return { ok: true, baseUrl: creds.baseUrl };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchListagemPagina(
  creds: TenantCreds,
  token: string,
  pagina: number,
): Promise<ListagemResponse> {
  const url = `${creds.baseUrl}/v1/licenciamento?pagina=${pagina}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throw new Error(`Listagem OEM HTTP ${resp.status}: ${preview.slice(0, 180)}`);
  }
  const json = (await resp.json().catch(() => null)) as ListagemResponse | null;
  if (!json || !Array.isArray(json.data)) {
    throw new Error("Listagem OEM retornou payload inválido.");
  }
  return json;
}

async function inserirLog(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial",
  status: "processando" | "sucesso" | "erro",
  extras: Partial<TenantSyncResult> = {},
): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("oem_sync_logs")
    .insert({
      tenant_id: tenantId,
      origem,
      status,
      clientes_atualizados: extras.atualizados ?? 0,
      clientes_falha: extras.falhas ?? 0,
      total_clientes: extras.total ?? 0,
      duracao_ms: extras.duracaoMs ?? null,
      mensagem: extras.mensagem ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[tenant-oem] falha ao inserir log:", error.message);
    return null;
  }
  return (data?.id as string) ?? null;
}

async function finalizarLog(logId: string | null, result: TenantSyncResult): Promise<void> {
  if (!logId) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("oem_sync_logs")
    .update({
      status: result.status,
      clientes_atualizados: result.atualizados + result.inseridos,
      clientes_falha: result.falhas,
      total_clientes: result.total,
      duracao_ms: result.duracaoMs,
      mensagem: result.mensagem,
    })
    .eq("id", logId);
  if (error) console.error("[tenant-oem] falha ao finalizar log:", error.message);
}

/**
 * Carga inicial/sincronização do tenant: busca toda a listagem paginada
 * de /v1/licenciamento e gravar (upsert) no Cloud central com tenant_id.
 */
export async function runTenantOemSync(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial",
): Promise<TenantSyncResult> {
  const inicio = Date.now();
  const logId = await inserirLog(tenantId, origem, "processando", {
    mensagem: "Sincronização iniciada — em andamento.",
  });

  try {
    const creds = await loadTenantCreds(tenantId);
    const token = await obterTokenTenant(creds);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let pagina = 1;
    let totalLidos = 0;
    let totalRegistros = Number.POSITIVE_INFINITY;

    while (totalLidos < totalRegistros) {
      const resp = await fetchListagemPagina(creds, token, pagina);
      const grupos = resp.data ?? [];
      totalRegistros = resp.totalRegistros ?? totalRegistros;
      if (!grupos.length) break;
      totalLidos += grupos.length;

      for (const grupo of grupos) {
        const codEmpresa = toNumber(grupo.codGrupo);
        if (codEmpresa == null) continue;
        const filiais =
          Array.isArray(grupo.filiais) && grupo.filiais.length ? grupo.filiais : [undefined];
        for (const filial of filiais) {
          const codFilial = toNumber(filial?.codFilial);
          if (codFilial == null) continue;
          const key = `${codEmpresa}:${codFilial}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const payload = buildResumoFallback(grupo, filial);
          const row = mapLicenciamentoToRow(payload, codEmpresa, codFilial);
          if (row) {
            rows.push({ ...row, tenant_id: tenantId });
          }
        }
      }

      pagina += 1;
    }

    // Upsert em lotes de 100 para não estourar payload.
    let inseridos = 0;
    let atualizados = 0;
    let falhas = 0;

    // pré-carrega chaves existentes para distinguir insert/update
    const { data: existentes } = await supabaseAdmin
      .from("clientes_oem")
      .select("filial_codigo")
      .eq("tenant_id", tenantId);
    const existentesSet = new Set(
      (existentes ?? []).map((r) => String((r as { filial_codigo: string | null }).filial_codigo)),
    );

    for (let i = 0; i < rows.length; i += 100) {
      const lote = rows.slice(i, i + 100);
      const { error } = await supabaseAdmin
        .from("clientes_oem")
        // @ts-expect-error — payload dinâmico, validado em runtime
        .upsert(lote, { onConflict: "tenant_id,filial_codigo" });
      if (error) {
        console.error("[tenant-oem] falha no upsert do lote:", error.message);
        falhas += lote.length;
        continue;
      }
      for (const r of lote) {
        const fk = String(r.filial_codigo ?? "");
        if (existentesSet.has(fk)) atualizados += 1;
        else inseridos += 1;
      }
    }

    const result: TenantSyncResult = {
      status: "sucesso",
      total: rows.length,
      inseridos,
      atualizados,
      falhas,
      duracaoMs: Date.now() - inicio,
      mensagem: `${inseridos} novo(s), ${atualizados} atualizado(s), ${falhas} falha(s).`,
    };
    await finalizarLog(logId, result);
    return result;
  } catch (e) {
    const result: TenantSyncResult = {
      status: "erro",
      total: 0,
      inseridos: 0,
      atualizados: 0,
      falhas: 0,
      duracaoMs: Date.now() - inicio,
      mensagem: e instanceof Error ? e.message : String(e),
    };
    await finalizarLog(logId, result);
    return result;
  }
}