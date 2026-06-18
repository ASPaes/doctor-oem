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
          const { runTenantOemSync } = await import("@/lib/tenant-oem.server");

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

          // 4) Loop sequencial — uma empresa por vez para não saturar a API OEM.
          const resultados: Array<{
            tenantId: string;
            tenantNome: string;
            status: string;
            total: number;
            inseridos: number;
            atualizados: number;
            falhas: number;
            mensagem: string;
          }> = [];

          for (const t of elegiveis) {
            try {
              const r = await runTenantOemSync(String(t.id), origem === "cron" ? "cron" : "manual");
              resultados.push({
                tenantId: String(t.id),
                tenantNome: String(t.nome ?? t.slug ?? t.id),
                status: r.status,
                total: r.total,
                inseridos: r.inseridos,
                atualizados: r.atualizados,
                falhas: r.falhas,
                mensagem: r.mensagem,
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[oem-sync] tenant ${t.id} falhou:`, msg);
              resultados.push({
                tenantId: String(t.id),
                tenantNome: String(t.nome ?? t.slug ?? t.id),
                status: "erro",
                total: 0,
                inseridos: 0,
                atualizados: 0,
                falhas: 0,
                mensagem: msg,
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