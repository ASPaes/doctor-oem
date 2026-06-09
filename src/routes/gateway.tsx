import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { webhookLogsMock } from "@/lib/mock-data";
import { listGateways, createGateway } from "@/lib/doctoroem.functions";
import { queryOptions, useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  KeyRound, Webhook as WebhookIcon, Copy, CheckCircle2, XCircle,
  Zap, Activity,
} from "lucide-react";
import { useRole } from "@/lib/role-context";
import { toast } from "sonner";

const gatewaysQueryOptions = queryOptions({
  queryKey: ["doctoroem", "gateways"],
  queryFn: () => listGateways(),
});

export const Route = createFileRoute("/gateway")({
  head: () => ({
    meta: [
      { title: "Gateway de API · Nexus Hub" },
      { name: "description", content: "Gerencie tokens X-API-Key, webhooks e monitore logs de envio." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(gatewaysQueryOptions),
  component: Gateway,
  pendingComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Carregando gateways…</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
});

const eventos = ["cliente.ativado", "cliente.bloqueado", "cliente.desativado", "licenca.atualizada"];

function Gateway() {
  const { canAccessGateway } = useRole();
  const { data: gateways } = useSuspenseQuery(gatewaysQueryOptions);
  const queryClient = useQueryClient();
  const [novoUrl, setNovoUrl] = useState("");
  const [novoEventos, setNovoEventos] = useState<string[]>([]);

  const createMut = useMutation({
    mutationFn: (input: { webhookUrl: string; eventos: string[] }) =>
      createGateway({ data: input }),
    onSuccess: ({ token }) => {
      navigator.clipboard?.writeText(token).catch(() => {});
      toast.success("Gateway criado", {
        description: `Token copiado: ${token.slice(0, 16)}… (visível apenas agora)`,
        duration: 8000,
      });
      setNovoUrl("");
      setNovoEventos([]);
      queryClient.invalidateQueries({ queryKey: ["doctoroem", "gateways"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
          <span className="text-[11px] text-muted-foreground">
            {gateways.length} {gateways.length === 1 ? "gateway" : "gateways"} ativos
          </span>
        </header>
        <ul className="divide-y divide-border">
          {gateways.length === 0 && (
            <li className="px-5 py-6 text-sm text-muted-foreground">
              Nenhum gateway cadastrado ainda. Crie um abaixo para gerar token e webhook.
            </li>
          )}
          {gateways.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {g.clientId ? `Cliente ${g.clientId.slice(0, 8)}…` : "Token global"}
                </p>
                <code className="text-xs text-muted-foreground font-mono">{g.tokenMask}</code>
              </div>
              <Badge variant="outline" className="border-success/40 text-success">
                Ativo
              </Badge>
              <span className="hidden md:inline text-xs text-muted-foreground">
                Criado em {new Date(g.criadoEm).toLocaleDateString("pt-BR")}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(g.tokenMask);
                  toast.message("Apenas a máscara é exibida", {
                    description: "Tokens brutos só são mostrados no momento da criação.",
                  });
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar máscara
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
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Novo gateway + webhook</p>
              <Input
                value={novoUrl}
                onChange={(e) => setNovoUrl(e.target.value)}
                placeholder="https://seu-endpoint.com/hooks"
                className="bg-background/40"
              />
              <div className="flex flex-wrap gap-2">
                {eventos.map((e) => (
                  <label key={e} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-3 py-1 text-xs cursor-pointer hover:border-accent/50">
                    <input
                      type="checkbox"
                      className="accent-[oklch(0.7_0.21_175)]"
                      checked={novoEventos.includes(e)}
                      onChange={(ev) =>
                        setNovoEventos((prev) =>
                          ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e),
                        )
                      }
                    />{" "}
                    {e}
                  </label>
                ))}
              </div>
              <Button
                size="sm"
                disabled={createMut.isPending || !novoUrl || novoEventos.length === 0}
                className="bg-[image:var(--gradient-primary)] text-primary-foreground"
                onClick={() =>
                  createMut.mutate({ webhookUrl: novoUrl, eventos: novoEventos })
                }
              >
                <Zap className="mr-1.5 h-3.5 w-3.5" />
                {createMut.isPending ? "Salvando..." : "Cadastrar"}
              </Button>
            </div>
            <ul className="space-y-2">
              {gateways
                .filter((g) => g.webhookUrl)
                .map((g) => (
                <li key={g.id} className="rounded-xl border border-border bg-secondary/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <code className="truncate text-xs">{g.webhookUrl}</code>
                    <Badge variant="outline" className="border-success/40 text-success">
                      ativo
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {g.eventos.map((e) => (
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
            <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Logs de envio (amostra · ainda não há tabela)
            </h2>
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