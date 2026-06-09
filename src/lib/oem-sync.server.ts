// ============================================================
// Motor de sincronização automática do OEM (server-only).
// Lê TODOS os clientes de public.clientes_oem e atualiza módulos
// e custos em lotes (chunks) de 20 para não sobrecarregar a
// API da TabletCloud. Cada execução grava um log em oem_sync_logs.
// ============================================================
import { getDoctorOemAdmin } from "@/lib/doctoroem-admin.server";
import {
  obterTokenOem,
  fetchLicenciamentoOem,
  mapLicenciamentoToRow,
} from "@/lib/doctoroem.functions";

const CHUNK_SIZE = 20;

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

async function registrarLog(
  supabase: ReturnType<typeof getDoctorOemAdmin>,
  origem: "cron" | "manual",
  result: SyncRunResult,
): Promise<void> {
  const { error } = await supabase.from("oem_sync_logs").insert({
    origem,
    status: result.status,
    clientes_atualizados: result.atualizados,
    clientes_falha: result.falhas,
    total_clientes: result.total,
    duracao_ms: result.duracaoMs,
    mensagem: result.mensagem,
  });
  if (error) {
    console.error("[OEM scheduledSync] falha ao gravar log:", error.message);
  }
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
      await registrarLog(supabase, origem, result);
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

  try {
    // 3) Autentica uma única vez e carrega todos os clientes cadastrados.
    const accessToken = await obterTokenOem(origem === "cron" ? "scheduledSync" : "manualSync");

    const { data: clientes, error: selErr } = await supabase
      .from("clientes_oem")
      .select("id, empresa_codigo, filial_codigo");
    if (selErr) throw new Error(`clientes_oem (load): ${selErr.message}`);

    const lista = clientes ?? [];
    let atualizados = 0;
    let falhas = 0;

    // 4) Processa em chunks de 20 — requisições paralelas dentro do lote,
    //    lotes sequenciais para não estourar o servidor da TabletCloud.
    for (let i = 0; i < lista.length; i += CHUNK_SIZE) {
      const chunk = lista.slice(i, i + CHUNK_SIZE);
      await Promise.allSettled(
        chunk.map(async (cliente) => {
          const codEmpresa = parseInt(String(cliente.empresa_codigo).replace(/\D/g, ""), 10);
          const codFilial = parseInt(String(cliente.filial_codigo).replace(/\D/g, ""), 10);
          if (!Number.isFinite(codEmpresa) || !Number.isFinite(codFilial)) {
            falhas += 1;
            return;
          }

          const lic = await fetchLicenciamentoOem(accessToken, codEmpresa, codFilial);
          if (!lic) {
            falhas += 1;
            return;
          }

          const row = mapLicenciamentoToRow(lic, codEmpresa, codFilial);
          if (!row) {
            falhas += 1;
            return;
          }

          const { error: updErr } = await supabase
            .from("clientes_oem")
            .update(row)
            .eq("id", cliente.id as string);
          if (updErr) {
            console.error(
              `[OEM scheduledSync] falha ao atualizar ${codEmpresa}/${codFilial}:`,
              updErr.message,
            );
            falhas += 1;
          } else {
            atualizados += 1;
          }
        }),
      );
      console.log(
        `[OEM scheduledSync] lote ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(lista.length / CHUNK_SIZE)} concluído (${atualizados} ok, ${falhas} falhas).`,
      );
    }

    const result: SyncRunResult = {
      status: "sucesso",
      atualizados,
      falhas,
      total: lista.length,
      duracaoMs: Date.now() - inicio,
      mensagem: `${atualizados} cliente(s) atualizado(s) de ${lista.length}, ${falhas} falha(s).`,
    };
    await registrarLog(supabase, origem, result);
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
    await registrarLog(supabase, origem, result);
    return result;
  }
}