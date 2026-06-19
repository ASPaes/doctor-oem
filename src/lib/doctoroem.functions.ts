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

    // NÃO sobrescrevemos empresa_codigo/filial_codigo aqui: esses campos guardam
    // o codGrupo + codFilial vindos da LISTAGEM do OEM (o que o usuário enxerga).
    // O detalhe devolve códigos internos diferentes — usá-los corromperia a chave.
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
  const valorTotalFilial =
    toFiniteNumber(filialObj?.valorTotal ?? lic.valorTotal ?? lic.ValorTotal);

  // Fonte autoritativa: `modulos[]` do endpoint /v1/licenciamento/{emp}/{fil}
  // — cada item já vem com nome, quantidade e valor exatos.
  const rawModulos = getRawModulosFromLicenciamento(lic) ?? [];
  const modulos = rawModulos.map((modulo, index) => mapModuloApiToStorage(modulo, index));

  // PDV não vem em modulos[]. A API expõe a quantidade em `filial.pdvComandas`
  // e o custo do PDV é o resíduo de `filial.valorTotal` após descontar os
  // módulos complementares (Estoque, Mesa/Ficha, etc.) que somam à mesma fatura.
  // Isso NÃO é estimativa: são todos campos retornados pela API; o valor
  // unitário é apenas a divisão exata do total residual pela quantidade.
  const pdvQtd = toFiniteNumber(
    filialObj?.pdvComandas ?? lic.pdvComandas ?? lic.PdvComandas,
  ) ?? 0;
  if (pdvQtd > 0 && valorTotalFilial !== undefined) {
    const somaOutros = sumModuloTotals(modulos);
    const totalPdv = Math.max(0, round2(valorTotalFilial - somaOutros));
    const unitarioPdv = pdvQtd > 0 ? round2(totalPdv / pdvQtd) : 0;
    modulos.unshift(
      mapModuloApiToStorage(
        {
          codigo: "PDV",
          nome: "Licença PDV",
          quantidade: pdvQtd,
          valorUnitario: unitarioPdv,
          valorTotal: totalPdv,
          valor: totalPdv,
          ativo: true,
        },
        0,
      ),
    );
  }

  if (!modulos.length && valorTotalFilial === undefined) return {};

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

export function mapLicenciamentoToRow(
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

  const bloqueado =
    bool(lic.bloquearLicenca ?? lic.BloquearLicenca ?? filialObj?.bloqueado ?? lic.bloqueado ?? lic.Bloqueado) ?? false;
  // Status operacional do CLIENTE (independente do bloqueio de licença).
  // filial.status: "AT" = Ativo, "IN" = Inativo/Desativado.
  const filialStatusRaw = (() => {
    const s = filialObj?.status ?? lic.statusFilial ?? lic.status;
    return typeof s === "string" ? s.trim().toUpperCase() : undefined;
  })();
  const filialAtivoFlag =
    bool(filialObj?.ativo ?? lic.ativo) ?? (filialStatusRaw ? filialStatusRaw === "AT" : undefined);
  const clienteAtivo =
    filialStatusRaw === "AT" ? true : filialStatusRaw === "IN" ? false : (filialAtivoFlag ?? true);
  const pdvComandas = num(
    filialObj?.pdvComandas ?? lic.pdvComandas ?? lic.PdvComandas ?? lic.qtdPdvComandas ?? lic.QtdPdvComandas,
  );

  // IMPORTANTE: empresa_codigo = codGrupo (da LISTAGEM) e filial_codigo = codFilial
  // (da LISTAGEM). O detalhe `/v1/licenciamento` devolve outros códigos internos
  // (codEmpresa/codFilial diferentes), que NÃO são os códigos que o usuário vê
  // no OEM. Sempre preservamos os códigos da listagem (recebidos por parâmetro).
  const row: Record<string, unknown> = {
    empresa_codigo: String(codEmpresa),
    filial_codigo: String(codFilial),
    cnpj_cpf: cpfCnpj ?? `${codEmpresa}/${codFilial}`,
    nome_fantasia: nomeLoja ?? `Empresa ${codEmpresa}/${codFilial}`,
    bloqueado,
    // Dimensões independentes: status = Ativo/Desativado (operacional do cliente),
    // bloqueado = licença bloqueada/desbloqueada.
    status: clienteAtivo ? "Ativo" : "Desativado",
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
  const usuarios = num(filialObj?.usuarios ?? lic.usuarios ?? lic.Usuarios ?? lic.usuariosAdicionais ?? lic.UsuariosAdicionais);
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
  row.custo_total =
    custoModulos ??
    num(filialObj?.valorTotal ?? lic.custoTotal ?? lic.CustoTotal ?? lic.valorTotal ?? lic.ValorTotal) ??
    0;
  if (Array.isArray(lic.licencas ?? lic.Licencas ?? lic.licencasDetalhe ?? lic.LicencasDetalhe)) {
    row.licencas_detalhe = lic.licencas ?? lic.Licencas ?? lic.licencasDetalhe ?? lic.LicencasDetalhe;
  }

  return row;
}

const OEM_API_ORIGIN = "https://api.pdvlegal.com.br";

type TokenRequestOptions = {
  forceRefresh?: boolean;
};

type TokenRefreshReason = "startup" | "401" | "manual";

async function solicitarNovoTokenOem(
  escopo: string,
  options?: TokenRequestOptions,
): Promise<string> {
  const clientId = process.env.OEM_CLIENT_ID;
  const clientSecret = process.env.OEM_CLIENT_SECRET;
  const username = process.env.OEM_API_USERNAME;
  const password = process.env.OEM_API_PASSWORD;
  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "OEM API: secrets OEM_CLIENT_ID, OEM_CLIENT_SECRET, OEM_API_USERNAME e OEM_API_PASSWORD são obrigatórios.",
    );
  }

  const tokenBody = new URLSearchParams({
    username,
    password,
    grant_type: "password",
    client_id: clientId,
    client_secret: clientSecret,
  });

  console.log(
    `[OEM ${escopo}] OAuth2: solicitando token novo em ${OEM_API_ORIGIN}/token (forceRefresh=${options?.forceRefresh === true}).`,
  );
  const tokenResp = await fetch(`${OEM_API_ORIGIN}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: tokenBody.toString(),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => "");
    console.error(`[OEM ${escopo}] falha na autenticação:`, {
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
  return accessToken;
}

/** Autentica via OAuth2 (password grant) e retorna sempre um access_token novo. */
export async function obterTokenOem(escopo: string, options?: TokenRequestOptions): Promise<string> {
  return solicitarNovoTokenOem(escopo, options);
}

/**
 * GET /v1/licenciamento/{emp}/{fil}. Retorna o payload "desembrulhado" quando a
 * licença existe, ou null em 404/erros de cliente (empresa/filial inexistente).
 */
export async function fetchLicenciamentoOem(
  accessTokenOrHolder: string | TokenHolder,
  codEmpresa: number,
  codFilial: number,
): Promise<Record<string, unknown> | null> {
  const licUrl = `${OEM_API_ORIGIN}/v1/licenciamento/${codEmpresa}/${codFilial}`;
  const holder = isTokenHolder(accessTokenOrHolder)
    ? accessTokenOrHolder
    : staticHolder(accessTokenOrHolder);

  let licResp = await fetch(licUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
  });

  // Token vencido durante o loop longo: limpa o estado, aguarda 2s,
  // busca outro token novo e refaz a chamada uma única vez.
  if (licResp.status === 401 && holder.refresh) {
    console.warn(
      `[OEM] 401 em /v1/licenciamento/${codEmpresa}/${codFilial} — limpando token e renovando com nova autenticação.`,
    );
    await holder.refresh("401");
    licResp = await fetch(licUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
    });
  }

  if (!licResp.ok) {
    if (licResp.status >= 500) {
      console.error("[OEM bulkSync] erro de servidor na consulta:", {
        url: redactSensitiveUrl(licUrl),
        status: licResp.status,
      });
    }
    return null;
  }

  const raw = (await licResp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;
  return unwrapLicenciamentoPayload(raw);
}

/**
 * GET /v1/licenciamento/minhaslicencas/produtos
 * Devolve a lista de produtos licenciados para o OEM logado (codigo, nome).
 * Usado para resolver o codproduto que o endpoint /modulos exige.
 */
export async function fetchProdutosOem(
  accessTokenOrHolder: string | TokenHolder,
  baseUrl: string,
): Promise<Array<{ codigo: string; nome: string }>> {
  const url = `${baseUrl}/v1/licenciamento/minhaslicencas/produtos`;
  const holder = isTokenHolder(accessTokenOrHolder)
    ? accessTokenOrHolder
    : staticHolder(accessTokenOrHolder);
  const exec = async () =>
    fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
    });
  let resp = await exec();
  if (resp.status === 401 && holder.refresh) {
    await holder.refresh("401");
    resp = await exec();
  }
  if (!resp.ok) {
    console.error("[OEM] falha em /minhaslicencas/produtos:", resp.status);
    return [];
  }
  const json = (await resp.json().catch(() => [])) as unknown;
  if (!Array.isArray(json)) return [];
  return json
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      codigo: String(p.codigo ?? p.Codigo ?? ""),
      nome: String(p.nome ?? p.Nome ?? ""),
    }))
    .filter((p) => p.codigo && p.nome);
}

/**
 * GET /v1/licenciamento/minhaslicencas/modulos/{codproduto}/{codgrupo}/{codloja}
 * Endpoint OFICIAL com os módulos da loja contendo valorUnitario, valorTotal,
 * quantidade, ativo etc. — fonte autoritativa para o custo por módulo (não
 * precisamos mais sintetizar/calcular valores).
 */
export async function fetchModulosOem(
  accessTokenOrHolder: string | TokenHolder,
  baseUrl: string,
  codProduto: string | number,
  codGrupo: number,
  codFilial: number,
): Promise<unknown | null> {
  const url = `${baseUrl}/v1/licenciamento/minhaslicencas/modulos/${encodeURIComponent(
    String(codProduto),
  )}/${codGrupo}/${codFilial}`;
  const holder = isTokenHolder(accessTokenOrHolder)
    ? accessTokenOrHolder
    : staticHolder(accessTokenOrHolder);
  const exec = async () =>
    fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
    });
  let resp = await exec();
  if (resp.status === 401 && holder.refresh) {
    await holder.refresh("401");
    resp = await exec();
  }
  if (!resp.ok) {
    if (resp.status >= 500) {
      console.error("[OEM] erro em /minhaslicencas/modulos:", {
        url: redactSensitiveUrl(url),
        status: resp.status,
      });
    }
    return null;
  }
  const raw = (await resp.json().catch(() => null)) as unknown;
  if (raw === null || raw === undefined) return null;
  return raw;
}

/**
 * Normaliza a resposta de /minhaslicencas/modulos/{codproduto}/{codgrupo}/{codloja}
 * em uma lista de módulos no formato persistido em clientes_oem.modulos_ativos.
 * Esta é a FONTE AUTORITATIVA dos módulos e valores — inclui Gestão, PDV,
 * Estoque, Mesa/Ficha e qualquer outro módulo licenciado.
 */
export function parseModulosOficiais(raw: unknown): Record<string, unknown>[] {
  if (raw == null) return [];
  let lista: unknown[] = [];
  if (Array.isArray(raw)) {
    lista = raw;
  } else if (typeof raw === "object") {
    const obj = unwrapLicenciamentoPayload(raw as Record<string, unknown>);
    lista = getRawModulosFromLicenciamento(obj) ?? [];
  }
  return lista
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => mapModuloApiToStorage(m, i));
}

/** Soma exata dos valorTotal dos módulos retornados pela API oficial. */
export function somarTotalModulos(modulos: Record<string, unknown>[]): number {
  return sumModuloTotals(modulos);
}

/**
 * Container mutável de token compartilhado entre chamadas paralelas.
 * Permite renovar o access_token uma única vez quando a API responde 401.
 */
export type TokenHolder = {
  value: string;
  clear: () => void;
  refresh?: (reason?: TokenRefreshReason) => Promise<void>;
};

function isTokenHolder(v: unknown): v is TokenHolder {
  return !!v && typeof v === "object" && "value" in (v as Record<string, unknown>);
}

function staticHolder(token: string): TokenHolder {
  return { value: token, clear: () => undefined };
}

/** Cria um holder que renova o token via obterTokenOem (com de-dup de refresh concorrente). */
export function criarTokenHolder(escopo: string, initial = ""): TokenHolder {
  const holder: TokenHolder = {
    value: initial,
    clear: () => {
      holder.value = "";
    },
  };
  let pending: Promise<void> | null = null;
  holder.refresh = async (reason: TokenRefreshReason = "manual") => {
    if (pending) return pending;
    pending = (async () => {
      try {
        if (reason === "401") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        holder.clear();
        holder.value = await obterTokenOem(`${escopo}:refresh:${reason}`, { forceRefresh: true });
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return holder;
}

export const bulkSyncClientes = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ inserted: number; updated: number; total: number; scanned: number }> => {
    const { runBulkImportOem } = await import("@/lib/oem-import.server");
    const result = await runBulkImportOem("bulkSync");

    console.log(
      `[OEM bulkSync] concluído via ${result.origem}: ${result.updated} atualizados, ${result.inserted} novos, ${result.scanned} consultas, ${result.falhas} falhas.`,
    );

    return {
      inserted: result.inserted,
      updated: result.updated,
      total: result.total,
      scanned: result.scanned,
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