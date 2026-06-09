import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Building2, ShieldAlert, CircuitBoard, ArrowUpRight, TrendingUp } from "lucide-react";
import { clientesMock, formatBRL } from "@/lib/mock-data";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Visão Geral · Nexus Hub" },
      { name: "description", content: "Painel central com métricas de clientes, licenças OEM e status de integração em tempo real." },
      { property: "og:title", content: "Visão Geral · Nexus Hub" },
      { property: "og:description", content: "Painel central com métricas de clientes, licenças OEM e status de integração em tempo real." },
    ],
  }),
  component: Index,
});

function Index() {
  const totalClientes = clientesMock.length;
  const ativos = clientesMock.filter((c) => c.ativo).length;
  const bloqueados = clientesMock.filter((c) => c.bloqueado).length;
  const receita = clientesMock.reduce((acc, c) => acc + c.custoMensal, 0);

  const kpis = [
    { label: "Clientes Ativos", value: `${ativos}/${totalClientes}`, icon: Building2, accent: "text-primary", trend: "+12% MoM" },
    { label: "Receita Mensal", value: formatBRL(receita), icon: TrendingUp, accent: "text-accent", trend: "+4.8%" },
    { label: "Bloqueios Ativos", value: String(bloqueados), icon: ShieldAlert, accent: "text-destructive", trend: "1 crítico" },
    { label: "Sync OEM (24h)", value: "1.482", icon: CircuitBoard, accent: "text-success", trend: "99,8% ok" },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Command Center</p>
          <h1 className="text-3xl lg:text-4xl font-semibold text-gradient">Visão Geral do Hub</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitoramento consolidado de clientes, licenças OEM e gateways de integração.
          </p>
        </div>
        <Link
          to="/clientes"
          className="group inline-flex items-center gap-2 rounded-full border border-border glass-panel px-4 py-2 text-sm hover:glow-border transition"
        >
          Gerenciar clientes
          <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="glass-panel relative overflow-hidden rounded-2xl p-5">
            <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-[image:var(--gradient-primary)] opacity-10 blur-2xl" />
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{k.label}</p>
              <k.icon className={`h-4 w-4 ${k.accent}`} />
            </div>
            <p className="mt-3 text-2xl font-semibold tabular-nums">{k.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{k.trend}</p>
          </div>
        ))}
      </div>

      <section className="glass-panel rounded-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Clientes recentes</h2>
          </div>
          <Link to="/clientes" className="text-xs text-primary hover:underline">
            ver todos
          </Link>
        </header>
        <ul className="divide-y divide-border">
          {clientesMock.map((c) => (
            <li key={c.id}>
              <Link
                to="/clientes/$id"
                params={{ id: c.id }}
                className="flex items-center gap-4 px-5 py-4 transition hover:bg-secondary/40"
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-secondary text-sm font-semibold">
                  {c.nomeFantasia.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.nomeFantasia}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.grupoEconomico} · {c.cnpj}
                  </p>
                </div>
                <div className="hidden flex-col items-end md:flex">
                  <span className="text-sm tabular-nums">{formatBRL(c.custoMensal)}</span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">/mês</span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    variant="outline"
                    className={c.ativo ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}
                  >
                    <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${c.ativo ? "status-dot bg-success text-success" : "bg-muted-foreground"}`} />
                    {c.ativo ? "Ativo" : "Inativo"}
                  </Badge>
                  {c.bloqueado && (
                    <Badge variant="outline" className="border-destructive/50 text-destructive">
                      Bloqueado
                    </Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}