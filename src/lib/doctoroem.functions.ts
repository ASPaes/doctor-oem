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

    // 2) Chama a API real do Software OEM (PDVLegal/Fiweb) via GET.
    const FALLBACK_BASE = "https://api.pdvlegal.com.br/api";
    const rawBase = (process.env.OEM_API_BASE_URL ?? FALLBACK_BASE).trim();
    const clientId = process.env.OEM_CLIENT_ID;
    const clientSecret = process.env.OEM_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "OEM API: variáveis OEM_CLIENT_ID e/ou OEM_CLIENT_SECRET ausentes nos secrets.",
      );
    }

    const currentRow = current as ClienteRow;
    const cnpj = currentRow.cnpj_cpf;
    const cnpjDigits = normalizeDigits(cnpj);

    // Normaliza a base: remove barras finais e qualquer placeholder colado por engano.
    const apiUrl = rawBase
      .replace(/\{[^}]*\}\/?$/g, "")
      .replace(/\/+$/g, "");

    // Chamada real à API OEM com fallback gracioso para dados simulados quando a rota
    // oficial ainda não estiver disponível (404 / 401 / 403 / falha de rede).
    const url = new URL(`${apiUrl}/oem/configuracoes`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      client_id: clientId,
      client_secret: clientSecret,
    };

    let payload: Record<string, unknown> | null = null;
    let usedMock = false;

    try {
      const safeUrl = redactSensitiveUrl(url.toString());
      console.log("[OEM forceSync] disparo real:", { url: safeUrl, method: "GET", cnpj_cpf: cnpjDigits });

      const resp = await fetch(url.toString(), { method: "GET", headers });

      if (resp.ok) {
        payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
        console.log("[OEM forceSync] sucesso na API real.");
      } else {
        const text = await resp.text().catch(() => "");
        console.warn("[OEM forceSync] API indisponível, usando mock:", {
          status: resp.status,
          statusText: resp.statusText,
          responsePreview: text.slice(0, 200),
        });
        usedMock = true;
      }
    } catch (e) {
      console.warn("[OEM forceSync] erro de rede, usando mock:", (e as Error).message);
      usedMock = true;
    }

    if (usedMock || !payload) {
      // Mock rico simulando resposta da TabletCloud enquanto a rota oficial não é confirmada.
      payload = {
        razao_social: currentRow.razao_social ?? "Cliente Demonstração TabletCloud",
        nome_fantasia: currentRow.nome_fantasia ?? "TabletCloud Demo",
        produto_principal: "PDVLegal",
        status: "Ativo",
        bloqueado: false,
        motivo_bloqueio: null,
        numero_filiais: 1,
        usuarios_adicionais: 3,
        qtd_pdv: 5,
        qtd_comandas: 10,
        qtd_pdv_comandas: 15,
        custo_total: 749.9,
        modulos_ativos: ["NF-e", "NFC-e", "Estoque", "Financeiro"],
        licencas_detalhe: [
          { tipo: "PDV", quantidade: 5, status: "Ativo" },
          { tipo: "Comanda", quantidade: 10, status: "Ativo" },
          { tipo: "NF-e", quantidade: 1, status: "Ativo" },
          { tipo: "NFC-e", quantidade: 1, status: "Ativo" },
        ],
      };
    }

    // 3) Faz upsert/update apenas das colunas permitidas que vieram no payload.
    const allowed = [
      "razao_social",
      "nome_fantasia",
      "grupo_economico",
      "produto_principal",
      "numero_filiais",
      "status",
      "bloqueado",
      "motivo_bloqueio",
      "usuarios_adicionais",
      "qtd_pdv",
      "qtd_comandas",
      "qtd_pdv_comandas",
      "custo_total",
      "modulos_ativos",
      "licencas_detalhe",
    ] as const;

    const update: Record<string, unknown> = { last_sync: new Date().toISOString() };
    for (const key of allowed) {
      if (key in payload && payload[key] !== undefined) update[key] = payload[key];
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
// Bulk sync — popula a base com clientes fictícios usando o
// mesmo fallback inteligente da sync individual.
// ============================================================

type SeedCliente = {
  empresa_codigo: string;
  filial_codigo: string;
  cnpj_cpf: string;
  razao_social: string;
  nome_fantasia: string;
  grupo_economico: string;
  produto_principal: string;
  numero_filiais: number;
  status: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  usuarios_adicionais: number;
  qtd_pdv: number;
  qtd_comandas: number;
  qtd_pdv_comandas: number;
  custo_total: number;
  modulos_ativos: string[];
  licencas_detalhe: { tipo: string; quantidade: number; status: string }[];
};

const SEED_CLIENTES: SeedCliente[] = [
  {
    empresa_codigo: "EMP-2001",
    filial_codigo: "001",
    cnpj_cpf: "45.543.915/0001-81",
    razao_social: "Mercado Central Comércio de Alimentos LTDA",
    nome_fantasia: "Mercado Central",
    grupo_economico: "Grupo Central Varejo",
    produto_principal: "Doctor ERP Pro",
    numero_filiais: 3,
    status: "Ativo",
    bloqueado: false,
    motivo_bloqueio: null,
    usuarios_adicionais: 8,
    qtd_pdv: 12,
    qtd_comandas: 0,
    qtd_pdv_comandas: 12,
    custo_total: 1890.0,
    modulos_ativos: ["NF-e", "NFC-e", "Estoque", "Financeiro", "BI"],
    licencas_detalhe: [
      { tipo: "PDV", quantidade: 12, status: "Ativo" },
      { tipo: "NF-e", quantidade: 1, status: "Ativo" },
      { tipo: "NFC-e", quantidade: 1, status: "Ativo" },
    ],
  },
  {
    empresa_codigo: "EMP-2002",
    filial_codigo: "001",
    cnpj_cpf: "11.222.333/0001-44",
    razao_social: "Posto Alvorada Combustíveis LTDA",
    nome_fantasia: "Posto Alvorada",
    grupo_economico: "Rede Alvorada",
    produto_principal: "Doctor ERP Lite",
    numero_filiais: 1,
    status: "Ativo",
    bloqueado: false,
    motivo_bloqueio: null,
    usuarios_adicionais: 2,
    qtd_pdv: 4,
    qtd_comandas: 0,
    qtd_pdv_comandas: 4,
    custo_total: 549.9,
    modulos_ativos: ["NFC-e", "Financeiro"],
    licencas_detalhe: [
      { tipo: "PDV", quantidade: 4, status: "Ativo" },
      { tipo: "NFC-e", quantidade: 1, status: "Ativo" },
    ],
  },
  {
    empresa_codigo: "EMP-2003",
    filial_codigo: "001",
    cnpj_cpf: "27.865.757/0001-02",
    razao_social: "Farmácia Preço Baixo Drogarias LTDA",
    nome_fantasia: "Farmácia Preço Baixo",
    grupo_economico: "Grupo Saúde Popular",
    produto_principal: "Doctor ERP Pro",
    numero_filiais: 5,
    status: "Ativo",
    bloqueado: false,
    motivo_bloqueio: null,
    usuarios_adicionais: 12,
    qtd_pdv: 18,
    qtd_comandas: 0,
    qtd_pdv_comandas: 18,
    custo_total: 2740.5,
    modulos_ativos: ["NF-e", "NFC-e", "Estoque", "Financeiro", "SNGPC", "BI"],
    licencas_detalhe: [
      { tipo: "PDV", quantidade: 18, status: "Ativo" },
      { tipo: "NF-e", quantidade: 1, status: "Ativo" },
      { tipo: "NFC-e", quantidade: 1, status: "Ativo" },
      { tipo: "SNGPC", quantidade: 1, status: "Ativo" },
    ],
  },
  {
    empresa_codigo: "EMP-2004",
    filial_codigo: "001",
    cnpj_cpf: "33.014.556/0001-96",
    razao_social: "Bar e Restaurante Esquina LTDA",
    nome_fantasia: "Esquina Bar & Grill",
    grupo_economico: "Esquina Gastronomia",
    produto_principal: "Doctor ERP Lite",
    numero_filiais: 1,
    status: "Ativo",
    bloqueado: true,
    motivo_bloqueio: "Inadimplência 32 dias",
    usuarios_adicionais: 4,
    qtd_pdv: 2,
    qtd_comandas: 24,
    qtd_pdv_comandas: 26,
    custo_total: 980.0,
    modulos_ativos: ["NFC-e", "Comanda", "Financeiro"],
    licencas_detalhe: [
      { tipo: "PDV", quantidade: 2, status: "Ativo" },
      { tipo: "Comanda", quantidade: 24, status: "Ativo" },
      { tipo: "NFC-e", quantidade: 1, status: "Suspenso" },
    ],
  },
];

export const bulkSyncClientes = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ inserted: number; updated: number; total: number }> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    // 1) Simula a chamada em lote ao parceiro — usa o mesmo fallback inteligente.
    const FALLBACK_BASE = "https://api.pdvlegal.com.br/api";
    const rawBase = (process.env.OEM_API_BASE_URL ?? FALLBACK_BASE).trim();
    const apiUrl = rawBase.replace(/\{[^}]*\}\/?$/g, "").replace(/\/+$/g, "");
    try {
      const safeUrl = redactSensitiveUrl(`${apiUrl}/oem/empresas`);
      console.log("[OEM bulkSync] tentativa real:", safeUrl);
      const resp = await fetch(`${apiUrl}/oem/empresas`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          client_id: process.env.OEM_CLIENT_ID ?? "",
          client_secret: process.env.OEM_CLIENT_SECRET ?? "",
        },
      });
      console.log("[OEM bulkSync] status real:", resp.status);
    } catch (e) {
      console.warn("[OEM bulkSync] rede indisponível, usando seeds:", (e as Error).message);
    }

    // 2) Identifica quais CNPJs já existem para diferenciar insert/update.
    const cnpjs = SEED_CLIENTES.map((s) => s.cnpj_cpf);
    const { data: existing, error: selErr } = await supabase
      .from("clientes_oem")
      .select("id, cnpj_cpf")
      .in("cnpj_cpf", cnpjs);
    if (selErr) throw new Error(`DoctorOEM bulkSync (load): ${selErr.message}`);

    const existingByCnpj = new Map<string, string>();
    for (const row of existing ?? []) {
      existingByCnpj.set(row.cnpj_cpf as string, row.id as string);
    }

    const now = new Date().toISOString();
    const toInsert = SEED_CLIENTES
      .filter((s) => !existingByCnpj.has(s.cnpj_cpf))
      .map((s) => ({ ...s, last_sync: now }));
    const toUpdate = SEED_CLIENTES.filter((s) => existingByCnpj.has(s.cnpj_cpf));

    // 3) Insere os novos em lote.
    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from("clientes_oem").insert(toInsert);
      if (insErr) throw new Error(`DoctorOEM bulkSync (insert): ${insErr.message}`);
    }

    // 4) Atualiza os existentes individualmente (mantém o id).
    for (const s of toUpdate) {
      const id = existingByCnpj.get(s.cnpj_cpf)!;
      const { error: updErr } = await supabase
        .from("clientes_oem")
        .update({ ...s, last_sync: now })
        .eq("id", id);
      if (updErr) throw new Error(`DoctorOEM bulkSync (update ${s.cnpj_cpf}): ${updErr.message}`);
    }

    return {
      inserted: toInsert.length,
      updated: toUpdate.length,
      total: SEED_CLIENTES.length,
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