import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { apiTokensMock, webhooksMock, webhookLogsMock } from "@/lib/mock-data";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  KeyRound, Plus, Webhook as WebhookIcon, Copy, CheckCircle2, XCircle,
  Zap, Activity,
} from "lucide-react";
import { useRole } from "@/lib/role-context";
import { toast } from "sonner";

export const Route = createFileRoute("/gateway")({
  head: () => ({
    meta: [
      { title: "Gateway de API · Nexus Hub" },
      { name: "description", content: "Gerencie tokens X-API-Key, webhooks e monitore logs de envio." },
    ],
  }),
  component: Gateway,
});

const eventos = ["cliente.ativado", "cliente.bloqueado", "cliente.desativado", "licenca.atualizada"];

function Gateway() {
  const { canAccessGateway } = useRole();
  const [tokens] = useState(apiTokensMock);
  const [hooks] = useState(webhooksMock);

  if (!canAccessGateway) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        Acesso restrito ao perfil Admin.
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Integrações</p>
        <h1 className="text-3xl font-semibold text-gradient">Gateway de API &amp; Webhooks</h1>
        <p className="text-sm text-muted-foreground mt-1">
          API aberta para parceiros. Gere tokens, configure webhooks e acompanhe entregas em tempo real.
        </p>
      </div>

      <section className="glass-panel rounded-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent" />
            <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Tokens X-API-Key</h2>
          </div>
          <Button
            onClick={() => toast.success("Novo token gerado (simulação)")}
            className="bg-[image:var(--gradient-primary)] text-primary-foreground"
          >
            <Plus className="mr-2 h-4 w-4" /> Gerar token
          </Button>
        </header>
        <ul className="divide-y divide-border">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.nome}</p>
                <code className="text-xs text-muted-foreground font-mono">{t.token}</code>
              </div>
              <Badge
                variant="outline"
                className={t.ativo ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}
              >
                {t.ativo ? "Ativo" : "Revogado"}
              </Badge>
              <span className="hidden md:inline text-xs text-muted-foreground">
                Último uso: {new Date(t.ultimoUso).toLocaleString("pt-BR")}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(t.token);
                  toast.success("Token copiado");
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass-panel rounded-2xl">
          <header className="flex items-center gap-2 border-b border-border px-5 py-4">
            <WebhookIcon className="h-4 w-4 text-accent" />
            <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Webhooks cadastrados</h2>
          </header>
          <div className="px-5 py-4 space-y-3">
            <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-3">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Nova URL</p>
              <Input placeholder="https://seu-endpoint.com/hooks" className="bg-background/40" />
              <div className="flex flex-wrap gap-2">
                {eventos.map((e) => (
                  <label key={e} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs cursor-pointer hover:border-accent/50">
                    <input type="checkbox" className="accent-[oklch(0.7_0.21_175)]" /> {e}
                  </label>
                ))}
              </div>
              <Button
                size="sm"
                className="bg-[image:var(--gradient-primary)] text-primary-foreground"
                onClick={() => toast.success("Webhook cadastrado (simulação)")}
              >
                <Zap className="mr-1.5 h-3.5 w-3.5" /> Cadastrar
              </Button>
            </div>
            <ul className="space-y-2">
              {hooks.map((h) => (
                <li key={h.id} className="rounded-xl border border-border bg-secondary/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <code className="truncate text-xs">{h.url}</code>
                    <Badge
                      variant="outline"
                      className={h.ativo ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}
                    >
                      {h.ativo ? "ativo" : "pausado"}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {h.eventos.map((e) => (
                      <span key={e} className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                        {e}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="glass-panel rounded-2xl">
          <header className="flex items-center gap-2 border-b border-border px-5 py-4">
            <Activity className="h-4 w-4 text-accent" />
            <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Logs de envio (últimas 24h)</h2>
          </header>
          <ul className="divide-y divide-border">
            {webhookLogsMock.map((l) => {
              const ok = l.status >= 200 && l.status < 300;
              return (
                <li key={l.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  {ok ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      <span className="font-medium">{l.evento}</span>
                      <span className="text-muted-foreground"> · {l.webhook}</span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(l.timestamp).toLocaleString("pt-BR")} · {l.duracaoMs}ms
                    </p>
                  </div>
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs font-mono tabular-nums ${
                      ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                    }`}
                  >
                    HTTP {l.status}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}