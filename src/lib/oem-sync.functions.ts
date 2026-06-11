import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type SyncLogEntry = {
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

export type SyncSettings = {
  tabelasProntas: boolean;
  intervaloHoras: number;
  ativo: boolean;
  logs: SyncLogEntry[];
};

function tabelaAusente(message: string | undefined): boolean {
  if (!message) return false;
  return /does not exist|could not find the table|schema cache/i.test(message);
}

export const getSyncSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<SyncSettings> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    const { data: cfg, error: cfgErr } = await supabase
      .from("oem_sync_config")
      .select("intervalo_horas, ativo")
      .eq("id", 1)
      .maybeSingle();

    if (cfgErr && tabelaAusente(cfgErr.message)) {
      return { tabelasProntas: false, intervaloHoras: 24, ativo: true, logs: [] };
    }
    if (cfgErr) throw new Error(`oem_sync_config: ${cfgErr.message}`);

    const { data: logs, error: logErr } = await supabase
      .from("oem_sync_logs")
      .select("*")
      .order("executado_em", { ascending: false })
      .limit(10);
    if (logErr && !tabelaAusente(logErr.message)) {
      throw new Error(`oem_sync_logs: ${logErr.message}`);
    }

    return {
      tabelasProntas: true,
      intervaloHoras: (cfg?.intervalo_horas as number | undefined) ?? 24,
      ativo: (cfg?.ativo as boolean | undefined) ?? true,
      logs: (logs ?? []).map((l) => ({
        id: String(l.id),
        executadoEm: String(l.executado_em),
        origem: String(l.origem ?? "cron"),
        status: String(l.status ?? "—"),
        clientesAtualizados: Number(l.clientes_atualizados ?? 0),
        clientesFalha: Number(l.clientes_falha ?? 0),
        totalClientes: Number(l.total_clientes ?? 0),
        duracaoMs: l.duracao_ms == null ? null : Number(l.duracao_ms),
        mensagem: (l.mensagem as string | null) ?? null,
      })),
    };
  },
);

export const updateSyncSettings = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        intervaloHoras: z.number().int().min(1).max(168),
        ativo: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getDoctorOemAdmin } = await import("@/lib/doctoroem-admin.server");
    const supabase = getDoctorOemAdmin();

    const { error } = await supabase.from("oem_sync_config").upsert({
      id: 1,
      intervalo_horas: data.intervaloHoras,
      ativo: data.ativo,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      if (/does not exist|could not find the table|schema cache/i.test(error.message)) {
        throw new Error(
          "Tabelas de controle ainda não criadas no banco. Rode o SQL exibido na tela de Configurações.",
        );
      }
      throw new Error(`oem_sync_config (save): ${error.message}`);
    }
    return { ok: true };
  });

/**
 * scheduledOemSync — disparo da sincronização completa em segundo plano.
 * Pensada para ser chamada pela Cron Job (via /api/public/oem-sync) ou
 * manualmente pelo botão "Executar agora" na tela de Configurações.
 */
export const scheduledOemSync = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true; agendado: true }> => {
    const { runScheduledOemSync } = await import("@/lib/oem-sync.server");
    // Fire-and-forget: a carga total leva vários minutos e estoura o
    // timeout do proxy se ficarmos aguardando. O motor já cria um log
    // "processando" no início e atualiza no fim, então o front consegue
    // acompanhar via auto-refresh.
    void runScheduledOemSync("manual").catch((err) => {
      console.error("[OEM scheduledOemSync] erro em background:", err);
    });
    return { ok: true, agendado: true };
  },
);