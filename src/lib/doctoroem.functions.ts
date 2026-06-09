import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Cliente, Modulo, Licenca, UserAccount, Role } from "@/lib/mock-data";

// ============================================================
// Mappers — adaptam o schema do DoctorOEM ao formato da UI.
// ============================================================

type ClienteRow = {
  id: string;
  empresa_codigo: string;
  filial_codigo: string;
  razao_social: string | null;
  nome_fantasia: string;
  grupo_economico: string | null;
  cnpj_cpf: string;
  produto_principal: string | null;
  numero_filiais: number | null;
  status: string | null;
  bloqueado: boolean | null;
  usuarios_adicionais: number | null;
  qtd_pdv_comandas: number | null;
  qtd_pdv: number | null;
  qtd_comandas: number | null;
  motivo_bloqueio: string | null;
  custo_total: number | string | null;
  modulos_ativos: unknown;
  licencas_detalhe: unknown;
  last_sync: string | null;
};

type TabletCloudLicenciamentoFilial = {
  ativo?: boolean;
  matriz?: boolean;
  codfilial?: number;
  nomefilial?: string;
  cpf_cnpj?: string;
  datacadastro?: string;
  email?: string;
};

type TabletCloudLicenciamentoItem = {
  codgrupo?: number;
  ativo?: boolean;
  nomegrupo?: string;
  cpf_cnpj?: string;
  produto?: string;
  qtdLojasAtivas?: number;
  qtdLojasDesativadas?: number;
  datacadastro?: string;
  filiais?: TabletCloudLicenciamentoFilial[];
};

type TabletCloudLicenciamentoResponse = {
  total_count?: number;
  total?: number;
  offset?: number;
  data?: TabletCloudLicenciamentoItem[];
};

function normalizeDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function getTabletCloudOrigin(rawBase: string): string {
  const trimmed = rawBase.trim().replace(/\/+$/g, "");

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).origin;
  } catch {
    return trimmed
      .replace(/\/+(oem_licenciamentos|token)$/i, "")
      .replace(/\/+(licenciamento\/.*)$/i, "");
  }
}

function redactSensitiveUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has("token")) url.searchParams.set("token", "***");
    if (url.searchParams.has("access_token")) url.searchParams.set("access_token", "***");
    return url.toString();
  } catch {
    return rawUrl
      .replace(/([?&]token=)[^&]+/gi, "$1***")
      .replace(/([?&]access_token=)[^&]+/gi, "$1***");
  }
}

function findTabletCloudLicenca(
  items: TabletCloudLicenciamentoItem[],
  cnpjCpf: string,
): { item: TabletCloudLicenciamentoItem; filial?: TabletCloudLicenciamentoFilial } | null {
  const target = normalizeDigits(cnpjCpf);

  for (const item of items) {
    if (normalizeDigits(item.cpf_cnpj) === target) {
      return { item };
    }

    const filial = Array.isArray(item.filiais)
      ? item.filiais.find((entry) => normalizeDigits(entry.cpf_cnpj) === target)
      : undefined;

    if (filial) {
      return { item, filial };
    }
  }

  return null;
}

function mapTabletCloudLicencaToUpdate(
  current: ClienteRow,
  item: TabletCloudLicenciamentoItem,
  filial?: TabletCloudLicenciamentoFilial,
): Record<string, unknown> {
  const totalFiliais = Array.isArray(item.filiais)
    ? item.filiais.length
    : (item.qtdLojasAtivas ?? 0) + (item.qtdLojasDesativadas ?? 0);
  const ativo = filial?.ativo ?? item.ativo ?? current.status?.toLowerCase() === "ativo";

  return {
    nome_fantasia: filial?.nomefilial ?? current.nome_fantasia,
    grupo_economico: item.nomegrupo ?? current.grupo_economico,
    produto_principal: item.produto ?? current.produto_principal,
    numero_filiais: totalFiliais || current.numero_filiais,
    status: ativo ? "Ativo" : "Inativo",
    bloqueado: !ativo,
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function isModuloAtivo(modulo: Record<string, unknown>): boolean {
  const raw = modulo.ativo ?? modulo.active ?? modulo.status ?? modulo.Status;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw > 0;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["ativo", "active", "true", "1", "sim"].includes(normalized)) return true;
    if (["inativo", "inactive", "false", "0", "não", "nao"].includes(normalized)) return false;
  }
  return true;
}

function buildModuloDescricao(
  modulo: Record<string, unknown>,
  quantidade: number,
  valorUnitario: number,
): string {
  const descricao = modulo.descricao ?? modulo.description;
  if (typeof descricao === "string" && descricao.trim() !== "") return descricao;
  return `Qtde ${quantidade} × R$ ${valorUnitario.toFixed(2)} (unitário)`;
}

function getModuloNome(modulo: Record<string, unknown>, fallback = "Módulo"): string {
  const nome =
    modulo.nome ??
    modulo.Nome ??
    modulo.descricao ??
    modulo.description ??
    modulo.modulo ??
    modulo.Modulo;
  return typeof nome === "string" && nome.trim() !== "" ? nome : fallback;
}

function getModuloQuantidade(modulo: Record<string, unknown>): number {
  return toFiniteNumber(modulo.quantidade ?? modulo.Quantidade ?? modulo.qtd ?? modulo.Qtd) ?? 0;
}

function getModuloValorUnitario(modulo: Record<string, unknown>): number {
  return (
    toFiniteNumber(
      modulo.valorUnitario ??
        modulo.valor_unitario ??
        modulo.ValorUnitario ??
        modulo.unitario ??
        modulo.Unitario,
    ) ?? 0
  );
}

function getModuloValorTotal(modulo: Record<string, unknown>): number {
  return (
    toFiniteNumber(
      modulo.total ??
        modulo.Total ??
        modulo.valorTotal ??
        modulo.valor_total ??
        modulo.ValorTotal ??
        modulo.valor ??
        modulo.value,
    ) ??
    getModuloQuantidade(modulo) * getModuloValorUnitario(modulo)
  );
}

function buildModuloId(modulo: Record<string, unknown>, index: number): string {
  const rawId = modulo.codigo ?? modulo.Codigo ?? modulo.id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== "") return String(rawId);
  return getModuloNome(modulo, `modulo-${index + 1}`)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `modulo-${index + 1}`;
}

function getRawModulosFromLicenciamento(
  lic: Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  const candidates = [
    lic.modulos,
    lic.Modulos,
    lic.modulosAtivos,
    lic.ModulosAtivos,
    lic.response,
    lic.Response,
    lic.data,
    lic.Data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      const nestedModulos = nested.modulos ?? nested.Modulos ?? nested.modulosAtivos ?? nested.ModulosAtivos;
      if (Array.isArray(nestedModulos)) {
        return nestedModulos.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
      }
    }
  }

  return undefined;
}

function unwrapLicenciamentoPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const response = raw.response && typeof raw.response === "object" && !Array.isArray(raw.response)
    ? (raw.response as Record<string, unknown>)
    : undefined;
  const responseData = response?.data && typeof response.data === "object" && !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : undefined;
  const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? (raw.data as Record<string, unknown>)
    : undefined;

  return {
    ...raw,
    ...(response ?? {}),
    ...(responseData ?? {}),
    ...(data ?? {}),
  };
}

function mapModuloApiToStorage(modulo: Record<string, unknown>, index: number): Record<string, unknown> {
  const quantidade = getModuloQuantidade(modulo);
  const valorTotal = getModuloValorTotal(modulo);
  let valorUnitario = getModuloValorUnitario(modulo);
  // Deriva o unitário quando a API só manda o total (ex.: Estoque: qtd 1, valor 3.00).
  if (valorUnitario === 0 && quantidade > 0 && valorTotal > 0) {
    valorUnitario = Math.round((valorTotal / quantidade) * 100) / 100;
  }
  const ativo = isModuloAtivo(modulo);
  let nome = getModuloNome(modulo, `Módulo ${index + 1}`);
  // Regra de negócio: módulo de PDV/Comandas aparece como "Licença PDV" na matriz.
  if (/PDV|COMANDA/i.test(nome)) nome = "Licença PDV";

  return {
    ...modulo,
    id: buildModuloId(modulo, index),
    nome,
    descricao: buildModuloDescricao(modulo, quantidade, valorUnitario),
    ativo,
    quantidade,
    valorUnitario,
    valor_unitario: valorUnitario,
    total: valorTotal,
    valorTotal: valorTotal,
    valor_total: valorTotal,
    valor: valorTotal,
    status:
      typeof (modulo.status ?? modulo.Status) === "string"
        ? String(modulo.status ?? modulo.Status)
        : ativo
          ? "Ativo"
          : "Inativo",
  };
}

function getQuantidadeModulo(
  modulos: Record<string, unknown>[] | undefined,
  matcher: RegExp,
): number | undefined {
  if (!Array.isArray(modulos)) return undefined;
  for (const modulo of modulos) {
    if (matcher.test(getModuloNome(modulo, "").toUpperCase())) {
      return isModuloAtivo(modulo) ? getModuloQuantidade(modulo) : 0;
    }
  }
  return undefined;
}

function sumModuloTotals(modulos: Record<string, unknown>[]): number {
  return Math.round(modulos.reduce((acc, modulo) => acc + getModuloValorTotal(modulo), 0) * 100) / 100;
}

function toModulos(v: unknown): Modulo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => {
      const quantidade = getModuloQuantidade(m);
      const valorUnitario = getModuloValorUnitario(m);
      const valor = getModuloValorTotal(m);

      return {
        id: String(m.id ?? buildModuloId(m, i)),
        nome: getModuloNome(m, "Módulo"),
        descricao: buildModuloDescricao(m, quantidade, valorUnitario),
        ativo: isModuloAtivo(m),
        valor,
      };
    });
}

function toLicencas(v: unknown): Licenca[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l, i) => ({
      id: String(l.id ?? `l${i}`),
      descricao: String(l.descricao ?? l.description ?? "Licença"),
      tipo: String(l.tipo ?? l.type ?? "core"),
      valor: Number(l.valor ?? l.value ?? 0),
    }));
}

function mapCliente(row: ClienteRow): Cliente {
  const ativacao = row.last_sync ?? new Date().toISOString();
  return {
    id: row.id,
    codigoEmpresa: row.empresa_codigo,
    codigoFilial: row.filial_codigo,
    cnpj: row.cnpj_cpf,
    grupoEconomico: row.grupo_economico ?? "—",
    nomeFantasia: row.nome_fantasia,
    produtoPrincipal: row.produto_principal ?? "—",
    filiaisAtivas: row.numero_filiais ?? 0,
    dataCadastro: ativacao.slice(0, 10),
    dataAtivacao: ativacao,
    qtdPdv: row.qtd_pdv ?? row.qtd_pdv_comandas ?? 0,
    qtdComandas: row.qtd_comandas ?? 0,
    usuariosAdicionais: row.usuarios_adicionais ?? 0,
    ativo: (row.status ?? "Ativo").toLowerCase() === "ativo",
    bloqueado: Boolean(row.bloqueado),
    motivoBloqueio: row.motivo_bloqueio ?? undefined,
    custoMensal: Number(row.custo_total ?? 0),
    modulos: toModulos(row.modulos_ativos),
    licencas: toLicencas(row.licencas_detalhe),
  };
}

// ============================================================
// Clientes
// ============================================================

export const listClientes = createServerFn({ method: "GET" }).handler(
  async (): Promise<Cliente[]> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();
    const { data, error } = await supabase
      .from("clientes_oem")
      .select("*")
      .order("nome_fantasia", { ascending: true });
    if (error) throw new Error(`DoctorOEM listClientes: ${error.message}`);
    return (data ?? []).map((r) => mapCliente(r as ClienteRow));
  },
);

export const getCliente = createServerFn({ method: "GET" })
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<Cliente | null> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();
    const { data: row, error } = await supabase
      .from("clientes_oem")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(`DoctorOEM getCliente: ${error.message}`);
    return row ? mapCliente(row as ClienteRow) : null;
  });

export const forceSyncCliente = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<Cliente | null> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    // 1) Carrega o cliente atual para obter cnpj_cpf e códigos.
    const { data: current, error: curErr } = await supabase
      .from("clientes_oem")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (curErr) throw new Error(`DoctorOEM forceSync (load): ${curErr.message}`);
    if (!current) return null;

    const currentRow = current as ClienteRow;

    // 2) Credenciais obrigatórias para o fluxo OAuth2.
    const clientId = process.env.OEM_CLIENT_ID;
    const clientSecret = process.env.OEM_CLIENT_SECRET;
    const username = process.env.OEM_API_USERNAME;
    const password = process.env.OEM_API_PASSWORD;
    if (!clientId || !clientSecret || !username || !password) {
      throw new Error(
        "OEM API: secrets OEM_CLIENT_ID, OEM_CLIENT_SECRET, OEM_API_USERNAME e OEM_API_PASSWORD são obrigatórios.",
      );
    }

    const API_ORIGIN = "https://api.pdvlegal.com.br";

    // 3) ETAPA 1 — Autenticação OAuth2 (password grant) para obter o access_token.
    const tokenBody = new URLSearchParams({
      username,
      password,
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
    });

    console.log("[OEM forceSync] OAuth2: solicitando token em", `${API_ORIGIN}/token`);
    const tokenResp = await fetch(`${API_ORIGIN}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => "");
      console.error("[OEM forceSync] falha na autenticação:", {
        status: tokenResp.status,
        preview: text.slice(0, 200),
      });
      throw new Error(
        `OEM API: falha na autenticação OAuth2 (HTTP ${tokenResp.status}). Verifique usuário/senha e credenciais do client.`,
      );
    }

    const tokenJson = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : null;
    if (!accessToken) {
      throw new Error("OEM API: resposta de token sem o campo access_token.");
    }
    console.log("[OEM forceSync] OAuth2: access_token obtido com sucesso.");

    // 4) ETAPA 2 — Consulta real de licenciamento usando o token.
    //    Extrai códigos numéricos: suporta "EMP-2004/001", "2004", 2004 etc.
    function extractCodigoEmpresa(v: unknown): number | null {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return null;
      const m = s.match(/EMP-(\d+)/i);
      if (m) return parseInt(m[1], 10);
      const n = parseInt(s.replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    }
    function extractCodigoFilial(v: unknown): number | null {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return null;
      const n = parseInt(s.replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    }

    const codEmpresa = extractCodigoEmpresa(currentRow.empresa_codigo);
    const codFilial = extractCodigoFilial(currentRow.filial_codigo);
    if (codEmpresa == null || codFilial == null) {
      throw new Error(
        `OEM API: não foi possível extrair códigos numéricos de empresa/filial a partir de "${currentRow.empresa_codigo}" / "${currentRow.filial_codigo}".`,
      );
    }

    const licUrl = `${API_ORIGIN}/v1/licenciamento/${codEmpresa}/${codFilial}`;

    console.log("[OEM forceSync] GET licenciamento:", redactSensitiveUrl(licUrl));
    const licResp = await fetch(licUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!licResp.ok) {
      const text = await licResp.text().catch(() => "");
      console.error("[OEM forceSync] falha na consulta de licenciamento:", {
        status: licResp.status,
        preview: text.slice(0, 200),
      });
      throw new Error(
        `OEM API: consulta de licenciamento falhou (HTTP ${licResp.status}) para empresa ${currentRow.empresa_codigo}/${currentRow.filial_codigo}.`,
      );
    }

    const raw = (await licResp.json().catch(() => ({}))) as Record<string, unknown>;
    const lic = unwrapLicenciamentoPayload(raw);

    console.log("[OEM forceSync] payload real recebido:", JSON.stringify(lic).slice(0, 400));

    // 5) Mapeia o retorno real (codEmpresa, codFilial, nomeLoja, cpfCnpj,
    //    bloquearLicenca, pdvComandas, ...) para as colunas de clientes_oem.
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() !== "" ? v : undefined;
    const num = (v: unknown): number | undefined => {
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    const bool = (v: unknown): boolean | undefined =>
      typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;

  const filialObjSync =
    lic.filial && typeof lic.filial === "object" && !Array.isArray(lic.filial)
      ? (lic.filial as Record<string, unknown>)
      : undefined;

  const bloqueado = bool(lic.bloquearLicenca ?? filialObjSync?.bloqueado ?? lic.bloqueado);
  const pdvComandas = num(filialObjSync?.pdvComandas ?? lic.pdvComandas ?? lic.qtdPdvComandas);

    const update: Record<string, unknown> = { last_sync: new Date().toISOString() };

    const empresaCodigo =
      num(lic.codEmpresa ?? lic.codeEmpresa)?.toString() ?? str(lic.codEmpresa ?? lic.codeEmpresa);
    const filialCodigo =
      num(lic.codFilial ?? filialObjSync?.codigo)?.toString() ??
      str(lic.codFilial ?? filialObjSync?.codigo);
    if (empresaCodigo) update.empresa_codigo = empresaCodigo;
    if (filialCodigo) update.filial_codigo = filialCodigo;
    const nomeLoja = str(lic.nomeEmpresa ?? lic.nomeLoja ?? lic.nomeFantasia);
    if (nomeLoja) update.nome_fantasia = nomeLoja;
    const razao = str(lic.razaoSocial ?? lic.razao_social ?? lic.nomeEmpresa);
    if (razao) update.razao_social = razao;
    const cpfCnpj = str(lic.cnpjEmpresa ?? lic.cpfCnpj ?? lic.cnpjCpf);
    if (cpfCnpj) update.cnpj_cpf = cpfCnpj;
    const grupo = str(lic.grupoEconomico ?? lic.nomegrupo);
    if (grupo) update.grupo_economico = grupo;
    const produto = str(lic.nomeProduto ?? lic.produto ?? lic.produtoPrincipal);
    if (produto) update.produto_principal = produto;
    const filiais = num(lic.numeroFiliais ?? lic.qtdFiliais);
    if (filiais !== undefined) update.numero_filiais = filiais;
    const usuarios = num(filialObjSync?.usuarios ?? lic.usuarios ?? lic.usuariosAdicionais);
    if (usuarios !== undefined) update.usuarios_adicionais = usuarios;
    const { modulos: modulosExtraidos, custo: custoModulos } = extrairModulosECusto(lic);
    const modulosNorm = modulosExtraidos;
    const qtdPdvApi = num(lic.qtdPdv ?? lic.pdvs) ?? pdvComandas;
    const qtdPdvModulo = getQuantidadeModulo(modulosNorm, /PDV/i);
    const qtdPdv = qtdPdvModulo ?? qtdPdvApi ?? 0;
    update.qtd_pdv = qtdPdv;
    update.qtd_pdv_comandas = qtdPdv;
    update.bloqueado = bloqueado ?? false;
    update.status = bloqueado ? "Bloqueado" : "Ativo";
    const motivo = str(lic.motivoBloqueio);
    if (motivo) update.motivo_bloqueio = motivo;
    console.log("[OEM forceSync] modulos finais:", JSON.stringify(modulosNorm ?? []).slice(0, 400));
    if (modulosNorm) update.modulos_ativos = modulosNorm;
    const qtdComandasApi = num(lic.qtdComandas ?? lic.comandas);
    update.qtd_comandas = calcularComandas(qtdComandasApi, modulosNorm);
    update.custo_total =
      custoModulos ?? num(filialObjSync?.valorTotal ?? lic.custoTotal ?? lic.valorTotal) ?? 0;
    if (Array.isArray(lic.licencas ?? lic.licencasDetalhe)) {
      update.licencas_detalhe = lic.licencas ?? lic.licencasDetalhe;
    }

    const { data: row, error } = await supabase
      .from("clientes_oem")
      .update(update)
      .eq("id", data.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`DoctorOEM forceSync (save): ${error.message}`);
    return row ? mapCliente(row as ClienteRow) : null;
  });

// ============================================================
// Bulk sync — carga inicial REAL via OAuth2 + varredura de
// licenciamentos na TabletCloud (/v1/licenciamento/{emp}/{fil}).
// ============================================================

/** Mapeia o payload real de /v1/licenciamento para colunas de clientes_oem. */
/**
 * Normaliza o array real de módulos da API, preservando os campos originais e
 * adicionando aliases usados pela interface.
 */
const VALOR_UNITARIO_PDV_PADRAO = 10.0;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeModuloSintetico(
  id: string,
  nome: string,
  quantidade: number,
  valorUnitario: number,
  total: number,
): Record<string, unknown> {
  return {
    id,
    nome,
    descricao: `Qtde ${quantidade} × R$ ${valorUnitario.toFixed(2)} (unitário)`,
    ativo: true,
    status: "Ativo",
    quantidade,
    valorUnitario,
    valor_unitario: valorUnitario,
    total,
    valorTotal: total,
    valor_total: total,
    valor: total,
  };
}

function getFilialObj(lic: Record<string, unknown>): Record<string, unknown> | undefined {
  return lic.filial && typeof lic.filial === "object" && !Array.isArray(lic.filial)
    ? (lic.filial as Record<string, unknown>)
    : undefined;
}

function extrairModulosECusto(
  lic: Record<string, unknown>,
): { modulos?: Record<string, unknown>[]; custo?: number } {
  const filialObj = getFilialObj(lic);
  const valorTotalFilial = toFiniteNumber(filialObj?.valorTotal ?? lic.valorTotal);
  const pdvComandas =
    toFiniteNumber(filialObj?.pdvComandas ?? lic.pdvComandas ?? lic.qtdPdvComandas) ?? 0;

  const rawModulos = getRawModulosFromLicenciamento(lic) ?? [];
  const modulosApi = rawModulos.map((modulo, index) => mapModuloApiToStorage(modulo, index));

  const nomeUpper = (m: Record<string, unknown>) => getModuloNome(m, "").toUpperCase();
  const temPdv = modulosApi.some((m) => /PDV|COMANDA/.test(nomeUpper(m)));
  const temGestao = modulosApi.some((m) => /GEST/.test(nomeUpper(m)));

  const extras: Record<string, unknown>[] = [];

  // "Licença PDV": a API não traz na lista de módulos — vem como filial.pdvComandas.
  if (!temPdv && pdvComandas > 0) {
    const unitPdv =
      toFiniteNumber(lic.valorPdv ?? filialObj?.valorPdv ?? lic.valorUnitarioPdv) ??
      VALOR_UNITARIO_PDV_PADRAO;
    extras.push(
      makeModuloSintetico("licenca-pdv", "Licença PDV", pdvComandas, unitPdv, round2(pdvComandas * unitPdv)),
    );
  }

  // "Gestao" (licença base do produto): o restante do valorTotal da filial
  // após descontar PDVs e demais módulos (ex.: 62.90 − 30.00 − 3.00 = 29.90).
  if (!temGestao && valorTotalFilial !== undefined) {
    const somaParcial = round2(sumModuloTotals(modulosApi) + sumModuloTotals(extras));
    const restante = round2(valorTotalFilial - somaParcial);
    if (restante > 0) {
      const nomeProduto =
        typeof lic.nomeProduto === "string" && lic.nomeProduto.trim() !== ""
          ? lic.nomeProduto
          : "Gestao";
      extras.unshift(makeModuloSintetico("gestao", nomeProduto, 1, restante, restante));
    }
  }

  const modulos = [...extras, ...modulosApi];
  if (!modulos.length) return {};

  const custo = valorTotalFilial ?? sumModuloTotals(modulos);
  return { modulos, custo: round2(custo) };
}

/**
 * Comandas/Mesas NÃO escalam: é 0 ou 1 (módulo ativo/inativo).
 * Lê o valor real da API; senão, 1 se houver módulo de mesa/comanda/ficha ativo.
 */
function calcularComandas(
  qtdComandasApi: number | undefined,
  modulos: Record<string, unknown>[] | undefined,
): number {
  const qtdMesaFicha = getQuantidadeModulo(modulos, /MESA|FICHA/i);
  if (qtdMesaFicha !== undefined) return qtdMesaFicha;
  return qtdComandasApi ?? 0;
}

function mapLicenciamentoToRow(
  lic: Record<string, unknown>,
  codEmpresa: number,
  codFilial: number,
): Record<string, unknown> | null {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v : undefined;
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (v: unknown): boolean | undefined =>
    typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;

  const filialObj =
    lic.filial && typeof lic.filial === "object" && !Array.isArray(lic.filial)
      ? (lic.filial as Record<string, unknown>)
      : undefined;

  const cpfCnpj = str(
    lic.cnpjEmpresa ?? lic.CnpjEmpresa ?? lic.cpfCnpj ?? lic.CpfCnpj ?? lic.cnpjCpf ?? lic.CnpjCpf ?? lic.cpf_cnpj ?? lic.cnpj ?? lic.Cnpj ?? lic.documento,
  );
  const nomeLoja = str(
    lic.nomeEmpresa ?? lic.NomeEmpresa ?? lic.nomeLoja ?? lic.NomeLoja ?? lic.nome ?? lic.Nome ?? lic.nomeFantasia ?? lic.NomeFantasia ?? lic.nomefilial ?? lic.NomeFilial,
  );
  // Sem CNPJ nem nome não há como identificar o cliente — descarta.
  if (!cpfCnpj && !nomeLoja) return null;

  const bloqueado = bool(lic.bloquearLicenca ?? lic.BloquearLicenca ?? lic.bloqueado ?? lic.Bloqueado) ?? false;
  const pdvComandas = num(lic.pdvComandas ?? lic.PdvComandas ?? lic.qtdPdvComandas ?? lic.QtdPdvComandas);

  const row: Record<string, unknown> = {
    empresa_codigo: String(num(lic.codEmpresa ?? lic.codeEmpresa ?? lic.CodEmpresa) ?? codEmpresa),
    filial_codigo: String(num(lic.codFilial ?? lic.CodFilial ?? filialObj?.codigo) ?? codFilial),
    cnpj_cpf: cpfCnpj ?? `${codEmpresa}/${codFilial}`,
    nome_fantasia: nomeLoja ?? `Empresa ${codEmpresa}/${codFilial}`,
    bloqueado,
    status: bloqueado ? "Bloqueado" : "Ativo",
    last_sync: new Date().toISOString(),
  };

  const razao = str(lic.razaoSocial ?? lic.RazaoSocial ?? lic.razao_social ?? lic.nomeEmpresa ?? lic.NomeEmpresa);
  if (razao) row.razao_social = razao;
  const grupo = str(lic.grupoEconomico ?? lic.GrupoEconomico ?? lic.nomegrupo ?? lic.NomeGrupo);
  if (grupo) row.grupo_economico = grupo;
  const produto = str(lic.nomeProduto ?? lic.NomeProduto ?? lic.produto ?? lic.Produto ?? lic.produtoPrincipal ?? lic.ProdutoPrincipal);
  if (produto) row.produto_principal = produto;
  const filiais = num(lic.numeroFiliais ?? lic.NumeroFiliais ?? lic.qtdFiliais ?? lic.QtdFiliais);
  if (filiais !== undefined) row.numero_filiais = filiais;
  const usuarios = num(lic.usuarios ?? lic.Usuarios ?? lic.usuariosAdicionais ?? lic.UsuariosAdicionais);
  if (usuarios !== undefined) row.usuarios_adicionais = usuarios;
  const qtdPdvApi = num(lic.qtdPdv ?? lic.QtdPdv ?? lic.pdvs ?? lic.Pdvs) ?? pdvComandas;
  const { modulos: modulosExtraidos, custo: custoModulos } = extrairModulosECusto(lic);
  const modulosNorm = modulosExtraidos;
  const qtdPdvModulo = getQuantidadeModulo(modulosNorm, /PDV/i);
  const qtdPdv = qtdPdvModulo ?? qtdPdvApi ?? 0;
  row.qtd_pdv = qtdPdv;
  row.qtd_pdv_comandas = qtdPdv;
  const motivo = str(lic.motivoBloqueio ?? lic.MotivoBloqueio);
  if (motivo) row.motivo_bloqueio = motivo;
  console.log("[OEM bulkSync] modulos finais:", JSON.stringify(modulosNorm ?? []).slice(0, 400));
  if (modulosNorm) row.modulos_ativos = modulosNorm;
  const qtdComandasApi = num(lic.qtdComandas ?? lic.QtdComandas ?? lic.comandas ?? lic.Comandas);
  row.qtd_comandas = calcularComandas(qtdComandasApi, modulosNorm);
  row.custo_total = custoModulos ?? num(lic.custoTotal ?? lic.CustoTotal ?? lic.valorTotal ?? lic.ValorTotal) ?? 0;
  if (Array.isArray(lic.licencas ?? lic.Licencas ?? lic.licencasDetalhe ?? lic.LicencasDetalhe)) {
    row.licencas_detalhe = lic.licencas ?? lic.Licencas ?? lic.licencasDetalhe ?? lic.LicencasDetalhe;
  }

  return row;
}

export const bulkSyncClientes = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ inserted: number; updated: number; total: number; scanned: number }> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    // Cliente real conhecido do painel OEM da TabletCloud.
    const COD_EMPRESA = 31626;
    const COD_FILIAL = 38259;

    // 1) Garante o registro inicial na tabela (upsert por empresa/filial).
    const { data: existente, error: selErr } = await supabase
      .from("clientes_oem")
      .select("id")
      .eq("empresa_codigo", String(COD_EMPRESA))
      .eq("filial_codigo", String(COD_FILIAL))
      .maybeSingle();
    if (selErr) throw new Error(`DoctorOEM bulkSync (load): ${selErr.message}`);

    let registroId = existente?.id as string | undefined;
    let inserted = 0;

    if (!registroId) {
      const { data: novo, error: insErr } = await supabase
        .from("clientes_oem")
        .insert({
          nome_fantasia: `Cliente Real TabletCloud (${COD_EMPRESA})`,
          cnpj_cpf: "00000000000000",
          empresa_codigo: String(COD_EMPRESA),
          filial_codigo: String(COD_FILIAL),
          status: "Pendente Sincronização",
          last_sync: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (insErr) throw new Error(`DoctorOEM bulkSync (insert): ${insErr.message}`);
      registroId = novo.id as string;
      inserted = 1;
      console.log("[OEM bulkSync] registro inicial criado:", registroId);
    } else {
      console.log("[OEM bulkSync] registro já existente, será atualizado:", registroId);
    }

    // 2) Credenciais obrigatórias do fluxo OAuth2.
    const clientId = process.env.OEM_CLIENT_ID;
    const clientSecret = process.env.OEM_CLIENT_SECRET;
    const username = process.env.OEM_API_USERNAME;
    const password = process.env.OEM_API_PASSWORD;
    if (!clientId || !clientSecret || !username || !password) {
      throw new Error(
        "OEM API: secrets OEM_CLIENT_ID, OEM_CLIENT_SECRET, OEM_API_USERNAME e OEM_API_PASSWORD são obrigatórios.",
      );
    }

    const API_ORIGIN = "https://api.pdvlegal.com.br";

    // 3) ETAPA 1 — POST /token (password grant), igual à sync individual.
    const tokenBody = new URLSearchParams({
      username,
      password,
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
    });

    console.log("[OEM bulkSync] OAuth2: solicitando token em", `${API_ORIGIN}/token`);
    const tokenResp = await fetch(`${API_ORIGIN}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => "");
      console.error("[OEM bulkSync] falha na autenticação:", {
        status: tokenResp.status,
        preview: text.slice(0, 200),
      });
      throw new Error(
        `OEM API: falha na autenticação OAuth2 (HTTP ${tokenResp.status}). Verifique usuário/senha e credenciais do client.`,
      );
    }

    const tokenJson = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : null;
    if (!accessToken) {
      throw new Error("OEM API: resposta de token sem o campo access_token.");
    }
    console.log("[OEM bulkSync] OAuth2: access_token obtido com sucesso.");

    // 4) ETAPA 2 — GET cirúrgico na rota de produção do cliente real.
    const licUrl = `${API_ORIGIN}/v1/licenciamento/${COD_EMPRESA}/${COD_FILIAL}`;
    console.log("[OEM bulkSync] GET licenciamento:", redactSensitiveUrl(licUrl));

    const licResp = await fetch(licUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!licResp.ok) {
      const text = await licResp.text().catch(() => "");
      console.error("[OEM bulkSync] falha na consulta de licenciamento:", {
        status: licResp.status,
        preview: text.slice(0, 200),
      });
      throw new Error(
        `OEM API: consulta de licenciamento falhou (HTTP ${licResp.status}) para ${COD_EMPRESA}/${COD_FILIAL}. O registro inicial ficou salvo como "Pendente Sincronização".`,
      );
    }

    const raw = (await licResp.json().catch(() => ({}))) as Record<string, unknown>;
    const lic = unwrapLicenciamentoPayload(raw);

    console.log("JSON RETORNADO:", JSON.stringify(raw));

    // 5) Mapeia o JSON real e atualiza por cima do registro.
    const row =
      mapLicenciamentoToRow(lic, COD_EMPRESA, COD_FILIAL) ?? {
        empresa_codigo: String(COD_EMPRESA),
        filial_codigo: String(COD_FILIAL),
        status: "Ativo",
        last_sync: new Date().toISOString(),
      };

    const { error: updErr } = await supabase
      .from("clientes_oem")
      .update(row)
      .eq("id", registroId);
    if (updErr) throw new Error(`DoctorOEM bulkSync (update): ${updErr.message}`);

    console.log("[OEM bulkSync] cliente real sincronizado com sucesso:", registroId);

    return {
      inserted,
      updated: inserted === 0 ? 1 : 0,
      total: 1,
      scanned: 1,
    };
  },
);

// ============================================================
// Profiles / Usuários (combina profiles + auth.users)
// ============================================================

export const listUsuarios = createServerFn({ method: "GET" }).handler(
  async (): Promise<UserAccount[]> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    const [{ data: profiles, error: pErr }, { data: usersResp, error: uErr }] =
      await Promise.all([
        supabase.from("profiles").select("id, full_name, role, updated_at, is_active"),
        supabase.auth.admin.listUsers({ page: 1, perPage: 200 }),
      ]);
    if (pErr) throw new Error(`DoctorOEM listProfiles: ${pErr.message}`);
    if (uErr) throw new Error(`DoctorOEM listAuthUsers: ${uErr.message}`);

    const byId = new Map<string, { email: string; lastSignIn: string | null }>();
    for (const u of usersResp.users ?? []) {
      byId.set(u.id, {
        email: u.email ?? "—",
        lastSignIn: u.last_sign_in_at ?? null,
      });
    }

    const validRoles: Role[] = ["admin", "financeiro", "suporte"];
    return (profiles ?? []).map((p) => {
      const auth = byId.get(p.id as string);
      const role = (validRoles as string[]).includes(p.role as string)
        ? (p.role as Role)
        : "suporte";
      return {
        id: p.id as string,
        nome: (p.full_name as string | null) ?? "Sem nome",
        email: auth?.email ?? "—",
        role,
        ativo: (p.is_active as boolean | null) ?? true,
        ultimoAcesso:
          auth?.lastSignIn ?? (p.updated_at as string | null) ?? new Date().toISOString(),
      };
    });
  },
);

// ============================================================
// Developer Gateways (tokens + webhooks unificados)
// ============================================================

export type GatewayEntry = {
  id: string;
  clientId: string | null;
  tokenMask: string;
  webhookUrl: string | null;
  eventos: string[];
  criadoEm: string;
};

export const listGateways = createServerFn({ method: "GET" }).handler(
  async (): Promise<GatewayEntry[]> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();
    const { data, error } = await supabase
      .from("developer_gateways")
      .select("id, client_id, api_token_hash, webhook_url, webhook_events, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`DoctorOEM listGateways: ${error.message}`);
    return (data ?? []).map((g) => {
      const hash = (g.api_token_hash as string | null) ?? "";
      const tail = hash.slice(-4) || "----";
      return {
        id: g.id as string,
        clientId: (g.client_id as string | null) ?? null,
        tokenMask: `xak_•••••••••••••${tail}`,
        webhookUrl: (g.webhook_url as string | null) ?? null,
        eventos: ((g.webhook_events as string[] | null) ?? []) as string[],
        criadoEm: (g.created_at as string | null) ?? new Date().toISOString(),
      };
    });
  },
);

export const createGateway = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        clientId: z.string().uuid().nullable().optional(),
        webhookUrl: z.string().url().max(2048),
        eventos: z.array(z.string().min(1).max(64)).min(1).max(20),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();
    // Token gerado server-side; armazenamos só um hash (simulado).
    const raw = `xak_live_${crypto.randomUUID().replace(/-/g, "")}`;
    const hash = await sha256Hex(raw);
    const { data: row, error } = await supabase
      .from("developer_gateways")
      .insert({
        client_id: data.clientId ?? null,
        api_token_hash: hash,
        webhook_url: data.webhookUrl,
        webhook_events: data.eventos,
      })
      .select("id")
      .single();
    if (error) throw new Error(`DoctorOEM createGateway: ${error.message}`);
    // Token bruto retornado UMA vez (usuário deve copiar agora).
    return { id: row.id as string, token: raw };
  });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// Webhook logs
// ============================================================

export type WebhookLogEntry = {
  id: string;
  gatewayId: string | null;
  webhook: string;
  evento: string;
  status: number | null;
  timestamp: string;
};

export const listWebhookLogs = createServerFn({ method: "GET" })
  .inputValidator((input) =>
    z
      .object({ gatewayId: z.string().uuid().optional(), limit: z.number().min(1).max(200).optional() })
      .optional()
      .parse(input),
  )
  .handler(async ({ data }): Promise<WebhookLogEntry[]> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();
    let query = supabase
      .from("webhook_logs")
      .select(
        "id, gateway_id, event_type, response_status, created_at, developer_gateways(webhook_url)",
      )
      .order("created_at", { ascending: false })
      .limit(data?.limit ?? 50);
    if (data?.gatewayId) query = query.eq("gateway_id", data.gatewayId);
    const { data: rows, error } = await query;
    if (error) throw new Error(`DoctorOEM listWebhookLogs: ${error.message}`);
    return (rows ?? []).map((r) => {
      const rel = r.developer_gateways as
        | { webhook_url: string | null }
        | { webhook_url: string | null }[]
        | null;
      const gw = Array.isArray(rel) ? rel[0] : rel;
      const url = gw?.webhook_url ?? "";
      let host = url;
      try {
        if (url) host = new URL(url).host;
      } catch {
        /* mantém url cru */
      }
      return {
        id: r.id as string,
        gatewayId: (r.gateway_id as string | null) ?? null,
        webhook: host || "—",
        evento: (r.event_type as string) ?? "—",
        status: (r.response_status as number | null) ?? null,
        timestamp: (r.created_at as string) ?? new Date().toISOString(),
      };
    });
  });