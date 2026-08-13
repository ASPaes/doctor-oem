import { createFileRoute, Link } from "@tanstack/react-router";
import { Building2, ShieldAlert, CircuitBoard, ArrowUpRight, TrendingUp, Store, Monitor, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { formatBRL } from "@/lib/mock-data";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listTenantClientes, getTenantSyncSettings } from "@/lib/tenant-oem.functions";
import { useRole } from "@/lib/role-context";
import { useTenant } from "@/lib/tenant-context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Visão Geral · Nexus Hub" },
      { name: "description", content: "Painel consolidado com clientes ativos, custo recorrente e status da sincronização com o OEM." },
      { property: "og:title", content: "Visão Geral · Nexus Hub" },
      { property: "og:description", content: "Painel consolidado com clientes ativos, custo recorrente e status da sincronização com o OEM." },
    ],
  }),
  component: Index,
  pendingComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Carregando visão geral…</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
});

function formatRelativo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} d`;
}

function Index() {
  const { canSeeFinance } = useRole();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantId = activeTenant?.id ?? null;
  const listFn = useServerFn(listTenantClientes);
  const syncFn = useServerFn(getTenantSyncSettings);

  const { data: clientes = [] } = useQuery({
    queryKey: ["tenant-clientes", tenantId],
    queryFn: () => listFn({ data: { tenantId: tenantId! } }),
    enabled: !!tenantId,
  });
  const { data: sync } = useQuery({
    queryKey: ["tenant-sync", tenantId],
    queryFn: () => syncFn({ data: { tenantId: tenantId! } }),
    enabled: !!tenantId,
  });

  if (tenantLoading || !tenantId) {
    return <div className="p-10 text-center text-muted-foreground">Selecione uma empresa no topo…</div>;
  }

  const total = clientes.length;
  // Regra do negócio (Alexandre, 12/08/2026): cliente DESATIVADO não é
  // cobrado; licença BLOQUEADA continua sendo. Portanto o custo recorrente
  // segue o status operacional, e não o bloqueio. Antes esta tela somava a
  // base inteira — inflava o KPI em mais de 100% com os desativados.
  const ativosList = clientes.filter((c) => c.ativo);
  const ativos = ativosList.length;
  const desativados = total - ativos;
  const bloqueados = clientes.filter((c) => c.bloqueado).length;
  const bloqueadosAtivos = ativosList.filter((c) => c.bloqueado).length;
  const receita = ativosList.reduce((a, c) => a + c.custoMensal, 0);
  // ATENÇÃO: `filiaisAtivas` é o total de filiais DO GRUPO, repetido em cada
  // linha do grupo. Somá-lo conta cada grupo várias vezes (dava 5.452 para
  // 2.561 filiais). Cada linha JÁ É uma filial — o total é a contagem.
  const totalFiliais = ativos;
  const totalGrupos = new Set(ativosList.map((c) => c.grupoEconomico || c.codigoEmpresa)).size;
  const totalPdvs = ativosList.reduce((a, c) => a + c.qtdPdv, 0);
  const totalComandas = ativosList.reduce((a, c) => a + c.qtdComandas, 0);

  // Grupos econômicos por custo — só clientes ATIVOS, pela mesma regra do KPI.
  // `filiais` conta as linhas do grupo (cada linha é uma filial), não soma o
  // campo numero_filiais, que multiplicaria o grupo por ele mesmo.
  const gruposMap = new Map<string, { custo: number; clientes: number; filiais: number }>();
  for (const c of ativosList) {
    const g = c.grupoEconomico || "—";
    const cur = gruposMap.get(g) ?? { custo: 0, clientes: 0, filiais: 0 };
    cur.custo += c.custoMensal;
    cur.clientes += 1;
    cur.filiais += 1;
    gruposMap.set(g, cur);
  }
  // Antes estas listas eram cortadas em 5 itens e não diziam quanto ficava de
  // fora — com 946 bloqueados e 2.562 clientes, era quase tudo escondido.
  // Agora mostram bem mais, com rolagem, e informam o que sobrou.
  const LISTA_MAX = 50;
  const gruposOrdenados = Array.from(gruposMap.entries()).sort(
    (a, b) => b[1].custo - a[1].custo,
  );
  const topGrupos = gruposOrdenados.slice(0, LISTA_MAX);

  const bloqueadosTodos = clientes.filter((c) => c.bloqueado);
  const bloqueadosList = bloqueadosTodos.slice(0, LISTA_MAX);

  const logs = sync?.logs ?? [];
  const ultimoSucesso = logs.find((l) => l.status === "sucesso");
  const syncAtivo = sync?.ativo ?? false;
  const syncIntervalo = sync?.intervaloHoras ?? 24;

  const kpis = [
    { label: "Clientes Ativos", value: `${ativos}/${total}`, sub: `${desativados} desativados`, icon: Building2, accent: "text-primary" },
    canSeeFinance
      ? {
          label: "Custo Recorrente",
          value: formatBRL(receita),
          sub: `${ativos} ativos · desativados não entram`,
          icon: TrendingUp,
          accent: "text-accent",
        }
      : { label: "Filiais Ativas", value: String(totalFiliais), sub: `${totalPdvs} PDVs`, icon: Store, accent: "text-accent" },
    {
      label: "Bloqueios",
      value: String(bloqueados),
      sub: bloqueadosAtivos
        ? `${bloqueadosAtivos} em cliente ativo`
        : bloqueados
          ? "todos em desativados"
          : "tudo ok",
      icon: ShieldAlert,
      accent: bloqueadosAtivos ? "text-destructive" : "text-muted-foreground",
    },
    {
      label: "Sync OEM",
      value: ultimoSucesso ? formatRelativo(ultimoSucesso.executadoEm) : "—",
      sub: syncAtivo ? `a cada ${syncIntervalo}h` : "automação desligada",
      icon: CircuitBoard,
      accent: syncAtivo ? "text-success" : "text-muted-foreground",
    },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Command Center</p>
          <h1 className="text-3xl lg:text-4xl font-semibold text-gradient">Visão Geral do Hub</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Resumo em tempo real da base sincronizada com o DoctorOEM.
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
            <p className="mt-1 text-xs text-muted-foreground">{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="glass-panel rounded-2xl p-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Footprint operacional
            <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
              clientes ativos
            </span>
          </p>
          <div className="mt-4 grid grid-cols-4 gap-3 text-center">
            <div>
              <Building2 className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-xl font-semibold tabular-nums">{totalGrupos}</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Grupos</p>
            </div>
            <div>
              <Store className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-xl font-semibold tabular-nums">{totalFiliais}</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Filiais</p>
            </div>
            <div>
              <Monitor className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-xl font-semibold tabular-nums">{totalPdvs}</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">PDVs</p>
            </div>
            <div>
              <Monitor className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-xl font-semibold tabular-nums">{totalComandas}</p>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Mesa/Ficha</p>
            </div>
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Últimas sincronizações</p>
            <Link to="/configuracoes" className="text-xs text-primary hover:underline">configurar</Link>
          </div>
          {logs.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">Nenhuma execução registrada ainda.</p>
          ) : (
            <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-border">
              {logs.map((l) => {
                const Icon =
                  l.status === "sucesso" ? CheckCircle2 :
                  l.status === "erro" ? AlertCircle : Clock;
                const color =
                  l.status === "sucesso" ? "text-success" :
                  l.status === "erro" ? "text-destructive" : "text-muted-foreground";
                return (
                  <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                    <Icon className={`h-4 w-4 ${color}`} />
                    <span className="flex-1 truncate text-xs text-muted-foreground">
                      {formatRelativo(l.executadoEm)} · {l.origem} · {l.clientesAtualizados}/{l.totalClientes} atualizados
                    </span>
                    <Badge variant="outline" className={
                      l.status === "sucesso" ? "border-success/40 text-success" :
                      l.status === "erro" ? "border-destructive/50 text-destructive" :
                      "border-muted-foreground/30 text-muted-foreground"
                    }>
                      {l.status}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {canSeeFinance && (
          <section className="glass-panel rounded-2xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                Grupos por custo
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  {topGrupos.length} de {gruposOrdenados.length}
                </span>
              </h2>
              <Link to="/clientes" className="text-xs text-primary hover:underline">ver todos</Link>
            </header>
            {topGrupos.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">Sem dados.</p>
            ) : (
              <ul className="max-h-[26rem] overflow-y-auto divide-y divide-border">
                {topGrupos.map(([nome, info]) => (
                  <li key={nome} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{nome}</p>
                      <p className="text-xs text-muted-foreground">{info.clientes} cliente(s) · {info.filiais} filial(is)</p>
                    </div>
                    <span className="text-sm tabular-nums font-medium">{formatBRL(info.custo)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="glass-panel rounded-2xl">
          <header className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Bloqueios ativos {bloqueados > 0 && <span className="ml-2 text-destructive">({bloqueados})</span>}
              {bloqueadosTodos.length > bloqueadosList.length && (
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  mostrando {bloqueadosList.length}
                </span>
              )}
            </h2>
            <Link to="/clientes" className="text-xs text-primary hover:underline">ver clientes</Link>
          </header>
          {bloqueadosList.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Nenhum cliente bloqueado no momento. 🎉</p>
          ) : (
            <ul className="max-h-[26rem] overflow-y-auto divide-y divide-border">
              {bloqueadosList.map((c) => (
                <li key={c.id}>
                  <Link
                    to="/clientes/$id"
                    params={{ id: c.id }}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40"
                  >
                    <ShieldAlert className="h-4 w-4 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.nomeFantasia}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.grupoEconomico} · {c.cnpj}</p>
                    </div>
                    {canSeeFinance && (
                      <span className="text-sm tabular-nums text-muted-foreground">{formatBRL(c.custoMensal)}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}