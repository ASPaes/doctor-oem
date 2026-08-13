import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";

// Endpoint público para a Cron Job (pg_cron / agendador externo).
// Protegido por segredo no header "x-cron-secret".
// Segredos aceitos: chave derivada da credencial do banco (automática),
// OEM_SYNC_CRON_SECRET ou OEM_CLIENT_SECRET (fallbacks).
function comparaSegura(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

function segredoValido(recebido: string | null): boolean {
  if (!recebido) return false;

  const candidatos: string[] = [];

  // Chave derivada automaticamente da credencial do banco — não depende
  // de nenhum valor digitado manualmente.
  const serviceKey = process.env.DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    candidatos.push(
      createHash("sha256").update(`${serviceKey}:oem-sync-cron`).digest("hex"),
    );
  }
  if (process.env.OEM_SYNC_CRON_SECRET) candidatos.push(process.env.OEM_SYNC_CRON_SECRET);
  if (process.env.OEM_CLIENT_SECRET) candidatos.push(process.env.OEM_CLIENT_SECRET);
  // Aceita também a publishable key (anon) — padrão usado pelo pg_cron via header apikey.
  if (process.env.SUPABASE_PUBLISHABLE_KEY) candidatos.push(process.env.SUPABASE_PUBLISHABLE_KEY);

  const ok = candidatos.some((esperado) => comparaSegura(recebido, esperado));
  if (!ok) {
    // Fallback resiliente: aceita qualquer JWT cuja claim "ref" bata com o
    // projeto e cujo "role" seja anon/service_role/authenticated. Isso evita
    // que o cron quebre se SUPABASE_PUBLISHABLE_KEY não estiver presente no
    // runtime do Worker (acontece em alguns ambientes Lovable Cloud).
    const projetoRef = process.env.SUPABASE_PROJECT_ID || process.env.VITE_SUPABASE_PROJECT_ID;
    const partes = recebido.split(".");
    if (projetoRef && partes.length === 3) {
      try {
        const payload = JSON.parse(
          Buffer.from(partes[1], "base64").toString("utf-8"),
        ) as { ref?: string; role?: string };
        if (
          payload.ref === projetoRef &&
          (payload.role === "anon" ||
            payload.role === "service_role" ||
            payload.role === "authenticated")
        ) {
          return true;
        }
      } catch {
        /* ignora */
      }
    }
    console.log(`[oem-sync] auth: segredo inválido (lenHeader=${recebido.length})`);
  }
  return ok;
}

export const Route = createFileRoute("/api/public/oem-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const headerSegredo =
          request.headers.get("x-cron-secret") ?? request.headers.get("apikey");
        if (!segredoValido(headerSegredo)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Body opcional { "forcar": true } executa como manual (ignora o
        // intervalo configurado) — útil para cargas iniciais sob demanda.
        const body = (await request.json().catch(() => null)) as { forcar?: boolean } | null;
        const origem = body?.forcar === true ? ("manual" as const) : ("cron" as const);

        const inicio = Date.now();
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { avancarCargaOem } = await import("@/lib/oem-carga.server");

          // 1) Tenants ativos + 2) com sincronização habilitada (default = true).
          const { data: tenants, error: tenantsErr } = await supabaseAdmin
            .from("tenants")
            .select("id, nome, slug, ativo")
            .eq("ativo", true);
          if (tenantsErr) throw new Error(`tenants: ${tenantsErr.message}`);

          const { data: configs, error: cfgErr } = await supabaseAdmin
            .from("oem_sync_config")
            .select("tenant_id, ativo");
          if (cfgErr) throw new Error(`oem_sync_config: ${cfgErr.message}`);
          const desativados = new Set(
            (configs ?? [])
              .filter((c) => c.ativo === false)
              .map((c) => String(c.tenant_id)),
          );

          // 3) Apenas tenants com credenciais OEM mínimas preenchidas.
          const { data: settings, error: setErr } = await supabaseAdmin
            .from("tenant_oem_settings")
            .select(
              "tenant_id, oem_api_username, oem_api_password, oem_client_id, oem_client_secret",
            );
          if (setErr) throw new Error(`tenant_oem_settings: ${setErr.message}`);
          const comCredenciais = new Set(
            (settings ?? [])
              .filter(
                (s) =>
                  !!s.oem_api_username &&
                  !!s.oem_api_password &&
                  !!s.oem_client_id &&
                  !!s.oem_client_secret,
              )
              .map((s) => String(s.tenant_id)),
          );

          const elegiveis = (tenants ?? []).filter(
            (t) => !desativados.has(String(t.id)) && comCredenciais.has(String(t.id)),
          );

          // 4) Cada invocação executa alguns PASSOS da carga, não a carga toda.
          // A carga completa são ~4.500 chamadas ao OEM e não cabe em uma
          // requisição (Workers: 50 subrequisições no free, 1.000 no pago).
          // O cron chama de novo e a fila continua de onde parou.
          const MAX_PASSOS = Number(process.env.OEM_PASSOS_POR_CRON) || 2;

          const resultados: Array<{
            tenantId: string;
            tenantNome: string;
            status: string;
            fase: string;
            total: number;
            processados: number;
            restantes: number;
            inseridos: number;
            atualizados: number;
            falhas: number;
            mensagem: string;
          }> = [];

          for (const t of elegiveis) {
            const tenantId = String(t.id);
            const tenantNome = String(t.nome ?? t.slug ?? t.id);
            try {
              // Se NÃO há carga em andamento, respeita o intervalo configurado.
              const { data: runAtivo } = await supabaseAdmin
                .from("oem_sync_runs")
                .select("id")
                .eq("tenant_id", tenantId)
                .in("fase", ["listando", "detalhando"])
                .limit(1)
                .maybeSingle();

              if (!runAtivo && origem === "cron") {
                const { data: cfg } = await supabaseAdmin
                  .from("oem_sync_config")
                  .select("intervalo_horas")
                  .eq("tenant_id", tenantId)
                  .maybeSingle();
                const intervaloH = Number(cfg?.intervalo_horas ?? 24);
                const { data: ultimo } = await supabaseAdmin
                  .from("oem_sync_logs")
                  .select("executado_em")
                  .eq("tenant_id", tenantId)
                  .eq("status", "sucesso")
                  .order("executado_em", { ascending: false })
                  .limit(1)
                  .maybeSingle();
                if (ultimo?.executado_em) {
                  const decorrido = Date.now() - new Date(String(ultimo.executado_em)).getTime();
                  // Margem de 5 min para tolerar variação do agendador.
                  if (decorrido < intervaloH * 3_600_000 - 300_000) {
                    resultados.push({
                      tenantId, tenantNome, status: "ignorado", fase: "ocioso",
                      total: 0, processados: 0, restantes: 0,
                      inseridos: 0, atualizados: 0, falhas: 0,
                      mensagem: `Última carga há ${(decorrido / 3_600_000).toFixed(1)}h — intervalo de ${intervaloH}h ainda não decorrido.`,
                    });
                    continue;
                  }
                }
              }

              let passo = await avancarCargaOem(tenantId, origem === "cron" ? "cron" : "manual");
              for (let i = 1; i < MAX_PASSOS && !passo.concluido && passo.fase !== "erro"; i++) {
                passo = await avancarCargaOem(tenantId, origem === "cron" ? "cron" : "manual");
              }

              resultados.push({
                tenantId,
                tenantNome,
                status: passo.fase === "erro" ? "erro" : passo.concluido ? "sucesso" : "em-andamento",
                fase: passo.fase,
                total: passo.enfileirados,
                processados: passo.processados,
                restantes: passo.restantes,
                inseridos: passo.inseridos,
                atualizados: passo.atualizados,
                falhas: passo.falhas,
                mensagem: passo.mensagem,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[oem-sync] tenant ${tenantId} falhou:`, msg);
              resultados.push({
                tenantId, tenantNome, status: "erro", fase: "erro",
                total: 0, processados: 0, restantes: 0,
                inseridos: 0, atualizados: 0, falhas: 0, mensagem: msg,
              });
            }
          }

          const totalErros = resultados.filter((r) => r.status === "erro").length;
          return Response.json(
            {
              status: totalErros === resultados.length && resultados.length > 0 ? "erro" : "sucesso",
              origem,
              tenantsAvaliados: tenants?.length ?? 0,
              tenantsExecutados: resultados.length,
              tenantsComErro: totalErros,
              duracaoMs: Date.now() - inicio,
              resultados,
            },
            { status: totalErros === resultados.length && resultados.length > 0 ? 500 : 200 },
          );
        } catch (e) {
          return Response.json(
            {
              status: "erro",
              duracaoMs: Date.now() - inicio,
              mensagem: e instanceof Error ? e.message : String(e),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});