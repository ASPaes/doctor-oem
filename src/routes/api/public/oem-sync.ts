import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";

// Endpoint público para a Cron Job (pg_cron / agendador externo).
// Protegido por segredo no header "x-cron-secret".
// Segredo aceito: OEM_SYNC_CRON_SECRET (preferido) ou OEM_CLIENT_SECRET (fallback).
function segredoValido(recebido: string | null): boolean {
  const esperado = process.env.OEM_SYNC_CRON_SECRET || process.env.OEM_CLIENT_SECRET;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
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