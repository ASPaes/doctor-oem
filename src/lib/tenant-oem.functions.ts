import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Cliente, Modulo, Licenca } from "@/lib/mock-data";

// ============================================================
// Mapper de linha clientes_oem (Cloud central) -> Cliente UI
// ============================================================
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

// ----- Avança a carga em lotes: chame em loop até concluido === true -----
export const avancarCargaTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tenantId: z.string().uuid(),
        origem: z.enum(["manual", "carga-inicial"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem disparar a sincronização.");
    const { avancarCargaViaEdgeFunction } = await import("@/lib/oem-carga.server");
    return avancarCargaViaEdgeFunction(data.tenantId, data.origem ?? "manual");
  });

// ============================================================================
// Chaves de integração — é por elas que o DoctorSaaS lê esta empresa.
//
// Guardamos só o SHA-256. A chave em claro é devolvida UMA vez, na criação, e
// nunca mais: não existe "ver de novo". Perdeu, gera outra e revoga a velha.
// ============================================================================

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const gerarChaveIntegracao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ tenantId: z.string().uuid(), nome: z.string().min(2).max(80) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem gerar chaves.");

    // 32 bytes de aleatoriedade do próprio runtime — sem depender de lib.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const chave =
      "oem_live_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("oem_api_chaves").insert({
      tenant_id: data.tenantId,
      nome: data.nome,
      token_hash: await sha256Hex(chave),
      prefixo: chave.slice(0, 17),
      criada_por: userId,
    });
    if (error) throw new Error(`oem_api_chaves: ${error.message}`);

    // Única vez que a chave em claro sai daqui.
    return { chave };
  });

export const revogarChaveIntegracao = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid(), id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem revogar chaves.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("oem_api_chaves")
      .update({ ativa: false, revogada_em: new Date().toISOString() })
      .eq("id", data.id)
      .eq("tenant_id", data.tenantId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

// ----- Cancela a carga em andamento (destrava o "um run ativo por empresa") -----
export const cancelarCargaTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) throw new Error("Apenas administradores podem cancelar a sincronização.");
    const { cancelarCargaOem } = await import("@/lib/oem-carga.server");
    return cancelarCargaOem(data.tenantId);
  });

// ----- Bloquear / Desbloquear licença no OEM (admin do tenant) -----
export const alterarStatusLicencaOem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tenantId: z.string().uuid(),
        clienteId: z.string().uuid(),
        bloquear: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) {
      throw new Error("Apenas administradores podem alterar o status da licença.");
    }
    // Busca codEmpresa/codFilial autoritativos da linha local
    const { data: row, error } = await supabase
      .from("clientes_oem")
      .select("empresa_codigo, filial_codigo")
      .eq("tenant_id", data.tenantId)
      .eq("id", data.clienteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Cliente não encontrado nesta empresa.");
    const codEmpresa = Number(row.empresa_codigo);
    const codFilial = Number(row.filial_codigo);
    if (!Number.isFinite(codEmpresa) || !Number.isFinite(codFilial)) {
      throw new Error("Cliente sem codEmpresa/codFilial válidos para chamar o OEM.");
    }
    const { atualizarFilialOem } = await import("@/lib/oem-escrita.server");
    const result = await atualizarFilialOem(data.tenantId, codEmpresa, codFilial, {
      bloquear: data.bloquear,
    });
    if (!result.ok) throw new Error(result.mensagem);
    return { ok: true as const, bloqueado: data.bloquear };
  });

// ----- Ativar / Desativar cliente no OEM (admin do tenant) -----
export const alterarStatusAtivacaoOem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tenantId: z.string().uuid(),
        clienteId: z.string().uuid(),
        ativar: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_tenant_admin", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!isAdmin) {
      throw new Error("Apenas administradores podem ativar/desativar clientes.");
    }
    const { data: row, error } = await supabase
      .from("clientes_oem")
      .select("empresa_codigo, filial_codigo")
      .eq("tenant_id", data.tenantId)
      .eq("id", data.clienteId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Cliente não encontrado nesta empresa.");
    const codEmpresa = Number(row.empresa_codigo);
    const codFilial = Number(row.filial_codigo);
    if (!Number.isFinite(codEmpresa) || !Number.isFinite(codFilial)) {
      throw new Error("Cliente sem codEmpresa/codFilial válidos para chamar o OEM.");
    }
    const { atualizarFilialOem } = await import("@/lib/oem-escrita.server");
    // A flag do OEM é "desativarLicenca" — o inverso de "ativar" da tela.
    const result = await atualizarFilialOem(data.tenantId, codEmpresa, codFilial, {
      desativar: !data.ativar,
    });
    if (!result.ok) throw new Error(result.mensagem);
    return { ok: true as const, ativo: data.ativar };
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

