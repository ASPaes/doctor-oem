import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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