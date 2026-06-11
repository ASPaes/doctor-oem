// ============================================================
// Motor de sincronização automática do OEM (server-only).
// Lê TODOS os clientes de public.clientes_oem e atualiza módulos
// e custos em lotes (chunks) de 20 para não sobrecarregar a
// API da TabletCloud. Cada execução grava um log em oem_sync_logs.
// ============================================================
import { getDoctorOemAdmin } from "@/lib/doctoroem-admin.server";
import { runBulkImportOem } from "@/lib/oem-import.server";

export type SyncRunResult = {
  status: "sucesso" | "erro" | "ignorado";
  atualizados: number;
  falhas: number;
  total: number;
  duracaoMs: number;
  mensagem: string;
};

function isTabelaAusente(message: string | undefined): boolean {
  if (!message) return false;
  return /does not exist|could not find the table|schema cache/i.test(message);
}

async function inserirLogProcessando(
  supabase: ReturnType<typeof getDoctorOemAdmin>,
  origem: "cron" | "manual",
): Promise<string | null> {
  const { data, error } = await supabase
    .from("oem_sync_logs")
    .insert({
      origem,
      status: "processando",
      clientes_atualizados: 0,
      clientes_falha: 0,
      total_clientes: 0,
      duracao_ms: null,
      mensagem: "Carga iniciada — aguardando conclusão em segundo plano.",
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[OEM scheduledSync] falha ao abrir log processando:", error.message);
    return null;
  }
  return data?.id ? String(data.id) : null;
}

async function finalizarLog(
  supabase: ReturnType<typeof getDoctorOemAdmin>,
  origem: "cron" | "manual",
  logId: string | null,
  result: SyncRunResult,
): Promise<void> {
  const payload = {
    status: result.status,
    clientes_atualizados: result.atualizados,
    clientes_falha: result.falhas,
    total_clientes: result.total,
    duracao_ms: result.duracaoMs,
    mensagem: result.mensagem,
  };
  if (logId) {
    const { error } = await supabase.from("oem_sync_logs").update(payload).eq("id", logId);
    if (error) console.error("[OEM scheduledSync] falha ao finalizar log:", error.message);
    return;
  }
  const { error } = await supabase.from("oem_sync_logs").insert({ origem, ...payload });
  if (error) console.error("[OEM scheduledSync] falha ao gravar log:", error.message);
}

export async function runScheduledOemSync(
  origem: "cron" | "manual",
): Promise<SyncRunResult> {
  const inicio = Date.now();
  const supabase = getDoctorOemAdmin();

  // 1) Lê a configuração de automação (singleton id=1).
  const { data: cfg, error: cfgErr } = await supabase
    .from("oem_sync_config")
    .select("intervalo_horas, ativo")
    .eq("id", 1)
    .maybeSingle();

  // Se as tabelas de controle ainda não existem, seguimos com os padrões
  // (24h, automação ativa) — a sincronização roda mesmo assim e os logs
  // passam a ser gravados quando as tabelas forem criadas.
  const tabelasProntas = !(cfgErr && isTabelaAusente(cfgErr.message));
  if (cfgErr && tabelasProntas) throw new Error(`oem_sync_config: ${cfgErr.message}`);

  const intervaloHoras = cfg?.intervalo_horas ?? 24;
  const ativo = cfg?.ativo ?? true;

  // 2) Disparo via cron respeita o toggle e o intervalo configurado.
  if (origem === "cron" && tabelasProntas) {
    if (!ativo) {
      const result: SyncRunResult = {
        status: "ignorado",
        atualizados: 0,
        falhas: 0,
        total: 0,
        duracaoMs: Date.now() - inicio,
        mensagem: "Sincronização em segundo plano desativada nas Configurações.",
      };
      await finalizarLog(supabase, origem, null, result);
      return result;
    }

    const { data: ultimo } = await supabase
      .from("oem_sync_logs")
      .select("executado_em")
      .eq("status", "sucesso")
      .order("executado_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimo?.executado_em) {
      const decorridoMs = Date.now() - new Date(ultimo.executado_em as string).getTime();
      // Margem de 5 min para tolerar variação do agendador.
      if (decorridoMs < intervaloHoras * 3_600_000 - 300_000) {
        const horas = (decorridoMs / 3_600_000).toFixed(1);
        return {
          status: "ignorado",
          atualizados: 0,
          falhas: 0,
          total: 0,
          duracaoMs: Date.now() - inicio,
          mensagem: `Última execução há ${horas}h — intervalo de ${intervaloHoras}h ainda não decorrido.`,
        };
      }
    }
  }

  // Abre IMEDIATAMENTE um log "processando" para que o front mostre o
  // status enquanto a carga roda — sem isso o usuário acha que travou.
  const logId = await inserirLogProcessando(supabase, origem);

  try {
    const importResult = await runBulkImportOem(origem === "cron" ? "scheduledSync" : "manualSync");

    const result: SyncRunResult = {
      status: "sucesso",
      atualizados: importResult.inserted + importResult.updated,
      falhas: importResult.falhas,
      total: importResult.total,
      duracaoMs: Date.now() - inicio,
      mensagem:
        `${importResult.inserted} novo(s), ${importResult.updated} atualizado(s), ` +
        `${importResult.falhas} falha(s), ${importResult.scanned} consulta(s) via ${importResult.origem}.`,
    };
    await finalizarLog(supabase, origem, logId, result);
    return result;
  } catch (e) {
    const result: SyncRunResult = {
      status: "erro",
      atualizados: 0,
      falhas: 0,
      total: 0,
      duracaoMs: Date.now() - inicio,
      mensagem: e instanceof Error ? e.message : String(e),
    };
    await finalizarLog(supabase, origem, logId, result);
    return result;
  }
}