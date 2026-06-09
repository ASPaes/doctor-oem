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
  custo_total: number | string | null;
  modulos_ativos: unknown;
  licencas_detalhe: unknown;
  last_sync: string | null;
};

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
    qtdPdv: row.qtd_pdv_comandas ?? 0,
    qtdComandas: 0,
    usuariosAdicionais: row.usuarios_adicionais ?? 0,
    ativo: (row.status ?? "Ativo").toLowerCase() === "ativo",
    bloqueado: Boolean(row.bloqueado),
    motivoBloqueio: undefined,
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
    const { data: row, error } = await supabase
      .from("clientes_oem")
      .update({ last_sync: new Date().toISOString() })
      .eq("id", data.id)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`DoctorOEM forceSync: ${error.message}`);
    return row ? mapCliente(row as ClienteRow) : null;
  });

// ============================================================
// Profiles / Usuários (combina profiles + auth.users)
// ============================================================

export const listUsuarios = createServerFn({ method: "GET" }).handler(
  async (): Promise<UserAccount[]> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    const [{ data: profiles, error: pErr }, { data: usersResp, error: uErr }] =
      await Promise.all([
        supabase.from("profiles").select("id, full_name, role, updated_at"),
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
        ativo: true,
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