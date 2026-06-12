import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Cliente, Modulo, Licenca } from "@/lib/mock-data";

// ============================================================
// Mapper de linha clientes_oem (Cloud central) -> Cliente UI
// ============================================================
type ClienteOemRow = {
  id: string;
  tenant_id: string;
  empresa_codigo: string | null;
  filial_codigo: string | null;
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

function toModulos(v: unknown): Modulo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => ({
      id: String(m.id ?? `mod-${i}`),
      nome: String(m.nome ?? m.descricao ?? `Módulo ${i + 1}`),
      descricao: String(m.descricao ?? m.description ?? ""),
      ativo: m.ativo == null ? true : Boolean(m.ativo),
      valor: Number(
        (m.total as number | undefined) ??
          (m.valorTotal as number | undefined) ??
          (m.valor as number | undefined) ??
          0,
      ),
    }));
}
function toLicencas(v: unknown): Licenca[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l, i) => ({
      id: String(l.id ?? `lic-${i}`),
      descricao: String(l.descricao ?? l.description ?? "Licença"),
      tipo: String(l.tipo ?? l.type ?? "core"),
      valor: Number(l.valor ?? l.value ?? 0),
    }));
}
function mapClienteOem(row: ClienteOemRow): Cliente {
  const ativacao = row.last_sync ?? new Date().toISOString();
  return {
    id: row.id,
    codigoEmpresa: row.empresa_codigo ?? "",
    codigoFilial: row.filial_codigo ?? "",
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
// Leitura tenant-scoped (RLS aplica + filtro explícito por tenant_id)
// ============================================================
export const listTenantClientes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<Cliente[]> => {
    const { supabase, userId } = context;
    const { data: hasAccess } = await supabase.rpc("has_tenant_access", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!hasAccess) throw new Error("Sem acesso a esta empresa.");
    const { data: rows, error } = await supabase
      .from("clientes_oem")
      .select("*")
      .eq("tenant_id", data.tenantId)
      .order("nome_fantasia", { ascending: true });
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => mapClienteOem(r as unknown as ClienteOemRow));
  });

export const getTenantCliente = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ tenantId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<Cliente | null> => {
    const { supabase, userId } = context;
    const { data: hasAccess } = await supabase.rpc("has_tenant_access", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!hasAccess) throw new Error("Sem acesso a esta empresa.");
    const { data: row, error } = await supabase
      .from("clientes_oem")
      .select("*")
      .eq("tenant_id", data.tenantId)
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row ? mapClienteOem(row as unknown as ClienteOemRow) : null;
  });

// ----- Verifica conexão OEM com as credenciais do tenant -----
export const testTenantOemConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: hasAccess } = await supabase.rpc("has_tenant_access", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!hasAccess) throw new Error("Sem acesso a esta empresa.");
    const { testTenantConnection } = await import("@/lib/tenant-oem.server");
    return testTenantConnection(data.tenantId);
  });

// ----- Dispara a carga inicial / sync manual para um tenant -----
export const runTenantInitialLoad = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ tenantId: z.string().uuid(), origem: z.enum(["manual", "carga-inicial"]).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem disparar a sincronização.");
    const { runTenantOemSync } = await import("@/lib/tenant-oem.server");
    // Fire-and-forget — a carga pode demorar; o log inicial já fica como "processando".
    void runTenantOemSync(data.tenantId, data.origem ?? "manual").catch((err) => {
      console.error("[runTenantInitialLoad] erro em background:", err);
    });
    return { ok: true, agendado: true };
  });

// ----- Settings de automação por tenant (intervalo + ativo) + logs -----
export type TenantSyncLog = {
  id: string;
  executadoEm: string;
  origem: string;
  status: string;
  clientesAtualizados: number;
  clientesFalha: number;
  totalClientes: number;
  duracaoMs: number | null;
  mensagem: string | null;
};

export type TenantSyncSettings = {
  intervaloHoras: number;
  ativo: boolean;
  logs: TenantSyncLog[];
};

export const getTenantSyncSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<TenantSyncSettings> => {
    const { supabase, userId } = context;
    const { data: hasAccess } = await supabase.rpc("has_tenant_access", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!hasAccess) throw new Error("Sem acesso a esta empresa.");

    const { data: cfg } = await supabase
      .from("oem_sync_config")
      .select("intervalo_horas, ativo")
      .eq("tenant_id", data.tenantId)
      .maybeSingle();

    const { data: logs } = await supabase
      .from("oem_sync_logs")
      .select("*")
      .eq("tenant_id", data.tenantId)
      .order("executado_em", { ascending: false })
      .limit(10);

    return {
      intervaloHoras: cfg?.intervalo_horas ?? 24,
      ativo: cfg?.ativo ?? true,
      logs: (logs ?? []).map((l) => ({
        id: String(l.id),
        executadoEm: String(l.executado_em),
        origem: String(l.origem),
        status: String(l.status),
        clientesAtualizados: Number(l.clientes_atualizados ?? 0),
        clientesFalha: Number(l.clientes_falha ?? 0),
        totalClientes: Number(l.total_clientes ?? 0),
        duracaoMs: l.duracao_ms == null ? null : Number(l.duracao_ms),
        mensagem: (l.mensagem as string | null) ?? null,
      })),
    };
  });

export const updateTenantSyncSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tenantId: z.string().uuid(),
        intervaloHoras: z.number().int().min(1).max(168),
        ativo: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem alterar a configuração.");
    const { error } = await supabase.from("oem_sync_config").upsert(
      {
        tenant_id: data.tenantId,
        intervalo_horas: data.intervaloHoras,
        ativo: data.ativo,
      },
      { onConflict: "tenant_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });