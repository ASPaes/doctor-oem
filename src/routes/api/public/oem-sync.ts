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
        if (!segredoValido(request.headers.get("x-cron-secret"))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { runScheduledOemSync } = await import("@/lib/oem-sync.server");
        try {
          const result = await runScheduledOemSync("cron");
          return Response.json(result, { status: result.status === "erro" ? 500 : 200 });
        } catch (e) {
          return Response.json(
            { status: "erro", mensagem: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});