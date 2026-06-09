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

function toModulos(v: unknown): Modulo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => ({
      id: String(m.id ?? `m${i}`),
      nome: String(m.nome ?? m.name ?? "Módulo"),
      descricao: String(m.descricao ?? m.description ?? ""),
      ativo: Boolean(m.ativo ?? m.active ?? true),
      valor: Number(m.valor ?? m.value ?? 0),
    }));
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
    // Algumas APIs envelopam o objeto em "data".
    const lic = (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : raw) as Record<string, unknown>;

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

  const bloqueado = bool(lic.bloquearLicenca ?? lic.bloqueado);
  const pdvComandas = num(lic.pdvComandas ?? lic.qtdPdvComandas);

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
    const usuarios = num(lic.usuarios ?? lic.usuariosAdicionais);
    if (usuarios !== undefined) update.usuarios_adicionais = usuarios;
    // PDVs: se a API mandar 0/indefinido, aplica o fallback de pelo menos 1 PDV ativo.
    const qtdPdvApi = num(lic.qtdPdv ?? lic.pdvs) ?? pdvComandas;
    const qtdPdv = qtdPdvApi && qtdPdvApi > 0 ? qtdPdvApi : 1;
    update.qtd_pdv = qtdPdv;
    const qtdComandasApi = num(lic.qtdComandas ?? lic.comandas) ?? pdvComandas;
    update.qtd_comandas = qtdComandasApi && qtdComandasApi > 0 ? qtdComandasApi : qtdPdv;
    update.qtd_pdv_comandas = pdvComandas && pdvComandas > 0 ? pdvComandas : qtdPdv;
    update.bloqueado = bloqueado ?? false;
    update.status = bloqueado ? "Bloqueado" : "Ativo";
    const motivo = str(lic.motivoBloqueio);
    if (motivo) update.motivo_bloqueio = motivo;
    const { modulos: modulosNorm, custo: custoModulos } = extrairModulosECusto(
      lic,
      produto,
      qtdPdv,
    );
    if (modulosNorm) update.modulos_ativos = modulosNorm;
    // Custo: zero/indefinido da API NÃO pode vencer o valor calculado.
    const custoApi = num(lic.custoTotal ?? lic.valorTotal);
    let custo = custoApi && custoApi > 0 ? custoApi : custoModulos;
    if (!custo || custo <= 0) {
      custo = (produto ?? "").toUpperCase().includes("GESTAO LEGAL")
        ? Math.max(149.9, Math.round(qtdPdv * 29.9 * 100) / 100)
        : Math.round(qtdPdv * 29.9 * 100) / 100;
    }
    update.custo_total = custo;
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
 * Normaliza o array `data.modulos` da TabletCloud (codigo, ativo, quantidade,
 * valorUnitario, valorTotal) e calcula o custo somando o valorTotal dos ativos.
 * Sem o array, aplica a regra temporária: GESTAO LEGAL → R$ 29,90/PDV ou R$ 149,90.
 */
function extrairModulosECusto(
  lic: Record<string, unknown>,
  produto: string | undefined,
  pdvs: number | undefined,
): { modulos?: Record<string, unknown>[]; custo?: number } {
  const rawModulos = lic.modulos ?? lic.Modulos ?? lic.modulosAtivos ?? lic.ModulosAtivos;

  if (Array.isArray(rawModulos) && rawModulos.length > 0) {
    const modulos = rawModulos
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m, i) => {
        const ativoRaw = m.ativo ?? m.Ativo;
        const ativo =
          ativoRaw == null ? true : ativoRaw === true || ativoRaw === "true" || ativoRaw === 1;
        const quantidade = Number(m.quantidade ?? m.Quantidade ?? 1) || 1;
        const valorUnitario = Number(m.valorUnitario ?? m.ValorUnitario ?? 0) || 0;
        const valorTotal =
          Number(m.valorTotal ?? m.ValorTotal ?? 0) || quantidade * valorUnitario;
        return {
          id: String(m.codigo ?? m.Codigo ?? m.id ?? `m${i}`),
          nome: String(m.nome ?? m.Nome ?? m.descricao ?? `Módulo ${m.codigo ?? i + 1}`),
          descricao: `Qtde ${quantidade} × R$ ${valorUnitario.toFixed(2)} (unitário)`,
          ativo,
          valor: valorTotal,
          quantidade,
          valorUnitario,
        };
      });
    const custo = modulos
      .filter((m) => m.ativo)
      .reduce((acc, m) => acc + (Number(m.valor) || 0), 0);
    return { modulos, custo: Math.round(custo * 100) / 100 };
  }

  // Regra de negócios real para GESTAO LEGAL enquanto o GET não retorna `modulos`:
  // distribui os R$ 149,90 entre Estoque (1 × R$ 49,90) e Mesa/Ficha (3 × R$ 33,33 = R$ 100,00).
  if ((produto ?? "").toUpperCase().includes("GESTAO LEGAL")) {
    const modulos: Record<string, unknown>[] = [
      {
        id: "estoque",
        nome: "Estoque",
        descricao: "Qtde 1 × R$ 49,90 (unitário)",
        ativo: true,
        valor: 49.9,
        quantidade: 1,
        valorUnitario: 49.9,
      },
      {
        id: "mesa-ficha",
        nome: "Mesa/Ficha",
        descricao: "Qtde 3 × R$ 33,33 (unitário)",
        ativo: true,
        valor: 100.0,
        quantidade: 3,
        valorUnitario: 33.33,
      },
    ];
    return { modulos, custo: 149.9 };
  }

  return {};
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
  // PDVs: se a API mandar 0/indefinido, aplica o fallback de pelo menos 1 PDV ativo.
  const qtdPdvApi = num(lic.qtdPdv ?? lic.QtdPdv ?? lic.pdvs ?? lic.Pdvs) ?? pdvComandas;
  const qtdPdv = qtdPdvApi && qtdPdvApi > 0 ? qtdPdvApi : 1;
  row.qtd_pdv = qtdPdv;
  const qtdComandasApi =
    num(lic.qtdComandas ?? lic.QtdComandas ?? lic.comandas ?? lic.Comandas) ?? pdvComandas;
  row.qtd_comandas = qtdComandasApi && qtdComandasApi > 0 ? qtdComandasApi : qtdPdv;
  row.qtd_pdv_comandas = pdvComandas && pdvComandas > 0 ? pdvComandas : qtdPdv;
  const motivo = str(lic.motivoBloqueio ?? lic.MotivoBloqueio);
  if (motivo) row.motivo_bloqueio = motivo;
  const { modulos: modulosNorm, custo: custoModulos } = extrairModulosECusto(
    lic,
    produto,
    qtdPdv,
  );
  if (modulosNorm) row.modulos_ativos = modulosNorm;
  // Custo: zero/indefinido da API NÃO pode vencer o valor calculado.
  const custoApi = num(lic.custoTotal ?? lic.CustoTotal ?? lic.valorTotal ?? lic.ValorTotal);
  let custo = custoApi && custoApi > 0 ? custoApi : custoModulos;
  if (!custo || custo <= 0) {
    custo = (produto ?? "").toUpperCase().includes("GESTAO LEGAL")
      ? Math.max(149.9, Math.round(qtdPdv * 29.9 * 100) / 100)
      : Math.round(qtdPdv * 29.9 * 100) / 100;
  }
  row.custo_total = custo;
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
    const lic =
      raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? (raw.data as Record<string, unknown>)
        : raw;

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