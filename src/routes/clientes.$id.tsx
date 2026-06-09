import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowLeft, Eye, RefreshCw, ShieldAlert, ShieldCheck,
  Calendar, Hash, Building2, Users, Monitor, Boxes,
} from "lucide-react";
import { formatBRL, type Cliente } from "@/lib/mock-data";
import { getCliente, forceSyncCliente } from "@/lib/doctoroem.functions";
import { queryOptions, useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { useRole } from "@/lib/role-context";
import { toast } from "sonner";

const clienteQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["doctoroem", "cliente", id],
    queryFn: () => getCliente({ data: { id } }),
  });

export const Route = createFileRoute("/clientes/$id")({
  head: () => ({
    meta: [
      { title: "Cliente · Nexus Hub" },
      { name: "description", content: "Ficha completa do cliente com licenças OEM, módulos contratados e custos." },
    ],
  }),
  loader: async ({ params, context }) => {
    const cliente = await context.queryClient.ensureQueryData(clienteQueryOptions(params.id));
    if (!cliente) throw notFound();
  },
  component: ClienteDetalhe,
  notFoundComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Cliente não encontrado.</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
});

function ClienteDetalhe() {
  const { id } = Route.useParams();
  const { data: clienteOrNull } = useSuspenseQuery(clienteQueryOptions(id));
  const cliente = clienteOrNull as Cliente; // loader já garantiu não-nulo
  const { canSeeFinance } = useRole();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const queryClient = useQueryClient();
  const syncMutation = useMutation({
    mutationFn: () => forceSyncCliente({ data: { id } }),
    onMutate: () => {
      toast.message("Sincronizando com OEM...", {
        description: `Empresa ${cliente.codigoEmpresa}/${cliente.codigoFilial}`,
      });
    },
    onSuccess: (fresh) => {
      if (fresh) {
        queryClient.setQueryData(["doctoroem", "cliente", id], fresh);
        queryClient.invalidateQueries({ queryKey: ["doctoroem", "clientes"] });
        toast.success("Dados atualizados pelo OEM");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const syncing = syncMutation.isPending;

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Link to="/clientes" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Clientes
        </Link>
        <Button onClick={() => syncMutation.mutate()} disabled={syncing} variant="outline" className="glass-panel">
          <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Sincronizando OEM..." : "Forçar Sincronização OEM"}
        </Button>
      </div>

      <Header cliente={cliente} syncing={syncing} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-6">
          <IdentificadoresCard cliente={cliente} syncing={syncing} />
          <MetricasCard cliente={cliente} syncing={syncing} />
          <ModulosGrid cliente={cliente} canSeeFinance={canSeeFinance} syncing={syncing} />
        </section>

        <aside className="space-y-6">
          {canSeeFinance ? (
            <CustoCard cliente={cliente} syncing={syncing} onOpen={() => setDrawerOpen(true)} />
          ) : (
            <div className="glass-panel rounded-2xl p-5">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">Financeiro restrito</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Seu perfil (Suporte) não tem acesso a valores de custo e licenças financeiras.
              </p>
            </div>
          )}
          <StatusCard cliente={cliente} />
        </aside>
      </div>

      <BinoculoDrawer cliente={cliente} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  );
}

function Header({ cliente, syncing }: { cliente: Cliente; syncing: boolean }) {
  return (
    <div className="glass-panel rounded-2xl p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-[image:var(--gradient-hero)] opacity-50 pointer-events-none" />
      <div className="relative flex flex-wrap items-center gap-5">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-[image:var(--gradient-primary)] text-primary-foreground shadow-[var(--shadow-glow)]">
          <Building2 className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          {syncing ? (
            <>
              <Skeleton className="h-7 w-64" />
              <Skeleton className="mt-2 h-4 w-48" />
            </>
          ) : (
            <>
              <h1 className="text-2xl lg:text-3xl font-semibold">{cliente.nomeFantasia}</h1>
              <p className="text-sm text-muted-foreground">
                {cliente.grupoEconomico} · {cliente.produtoPrincipal}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge
            variant="outline"
            className={cliente.ativo ? "border-success/50 text-success" : "border-muted-foreground/40 text-muted-foreground"}
          >
            {cliente.ativo ? <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> : null}
            {cliente.ativo ? "Operacional" : "Desativado"}
          </Badge>
          {cliente.bloqueado && (
            <Badge variant="outline" className="border-destructive/60 text-destructive">
              <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
              Bloqueado
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function IdentificadoresCard({ cliente, syncing }: { cliente: Cliente; syncing: boolean }) {
  const items = [
    ["Código Empresa", cliente.codigoEmpresa],
    ["Código Filial", cliente.codigoFilial],
    ["CNPJ/CPF", cliente.cnpj],
    ["Grupo Econômico", cliente.grupoEconomico],
    ["Nome Fantasia", cliente.nomeFantasia],
    ["Produto Principal", cliente.produtoPrincipal],
  ];
  return (
    <Card title="Identificadores OEM" icon={Hash}>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{k}</dt>
            <dd className="mt-1 font-medium">
              {syncing ? <Skeleton className="h-5 w-32" /> : v}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function MetricasCard({ cliente, syncing }: { cliente: Cliente; syncing: boolean }) {
  const items = [
    { label: "Filiais ativas", value: cliente.filiaisAtivas, icon: Building2 },
    { label: "PDVs", value: cliente.qtdPdv, icon: Monitor },
    { label: "Comandas", value: cliente.qtdComandas, icon: Boxes },
    { label: "Usuários adicionais", value: cliente.usuariosAdicionais, icon: Users },
  ];
  return (
    <Card title="Métricas de Escala" icon={Calendar}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {items.map((m) => (
          <div key={m.label} className="rounded-xl border border-border bg-secondary/30 p-3">
            <m.icon className="h-4 w-4 text-accent" />
            <p className="mt-2 text-xl font-semibold tabular-nums">
              {syncing ? <Skeleton className="h-6 w-12" /> : m.value}
            </p>
            <p className="text-[11px] text-muted-foreground">{m.label}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Data de cadastro</p>
          <p className="font-medium">
            {syncing ? <Skeleton className="h-5 w-32" /> : new Date(cliente.dataCadastro).toLocaleDateString("pt-BR")}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Ativação</p>
          <p className="font-medium">
            {syncing ? <Skeleton className="h-5 w-40" /> : new Date(cliente.dataAtivacao).toLocaleString("pt-BR")}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ModulosGrid({ cliente, canSeeFinance, syncing }: { cliente: Cliente; canSeeFinance: boolean; syncing: boolean }) {
  return (
    <Card title="Matriz de Módulos" icon={Boxes}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cliente.modulos.map((m) => (
          <div
            key={m.id}
            className={`relative rounded-xl border p-4 transition ${
              m.ativo
                ? "border-accent/50 bg-secondary/40 shadow-[var(--shadow-glow-accent)]"
                : "border-border bg-secondary/10 opacity-50"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="font-semibold">{m.nome}</p>
              <span
                className={`h-2 w-2 rounded-full ${
                  m.ativo ? "bg-success status-dot text-success" : "bg-muted-foreground"
                }`}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{m.descricao}</p>
            {canSeeFinance && (
              <p className="mt-3 text-sm font-medium tabular-nums">
                {syncing ? <Skeleton className="h-4 w-16" /> : formatBRL(m.valor)}
                <span className="text-[10px] text-muted-foreground"> /mês</span>
              </p>
            )}
            <p className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
              {m.ativo ? "ativo no OEM" : "inativo"}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CustoCard({ cliente, syncing, onOpen }: { cliente: Cliente; syncing: boolean; onOpen: () => void }) {
  return (
    <Card title="Custo Mensal Total" icon={Hash}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-3xl font-semibold tabular-nums text-gradient">
            {syncing ? <Skeleton className="h-9 w-32" /> : formatBRL(cliente.custoMensal)}
          </p>
          <p className="text-xs text-muted-foreground">Soma de licenças OEM + módulos</p>
        </div>
        <button
          onClick={onOpen}
          className="group relative grid h-12 w-12 place-items-center rounded-full border border-accent/50 bg-secondary/40 transition hover:glow-accent"
          title="Abrir binóculo de custos"
        >
          <Eye className="h-5 w-5 text-accent" />
          <span className="absolute inset-0 rounded-full ring-1 ring-accent/30 group-hover:ring-accent/70 transition" />
        </button>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Toque no <span className="text-accent">binóculo</span> para ver cada licença bruta do OEM.
      </p>
    </Card>
  );
}

function StatusCard({ cliente }: { cliente: Cliente }) {
  return (
    <Card title="Status Operacional" icon={ShieldCheck}>
      <div className="space-y-3 text-sm">
        <Row label="Status" value={cliente.ativo ? "Ativo" : "Desativado"} ok={cliente.ativo} />
        <Row label="Bloqueado" value={cliente.bloqueado ? "Sim" : "Não"} ok={!cliente.bloqueado} />
        {cliente.bloqueado && cliente.motivoBloqueio && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
            {cliente.motivoBloqueio}
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`inline-flex items-center gap-2 ${ok ? "text-success" : "text-destructive"}`}>
        <span className={`h-2 w-2 rounded-full status-dot ${ok ? "bg-success text-success" : "bg-destructive text-destructive"}`} />
        {value}
      </span>
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="glass-panel rounded-2xl p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-accent" />
        <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function BinoculoDrawer({
  cliente, open, onOpenChange,
}: {
  cliente: Cliente; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const total = cliente.licencas.reduce((a, l) => a + l.valor, 0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md glass-panel border-l border-border backdrop-blur-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-accent" /> Binóculo de Custos
          </SheetTitle>
          <SheetDescription>
            Detalhamento bruto das licenças recebidas do OEM para{" "}
            <span className="text-foreground">{cliente.nomeFantasia}</span>.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-2">
          {cliente.licencas.map((l) => (
            <div
              key={l.id}
              className="flex items-center justify-between rounded-xl border border-border bg-secondary/30 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{l.descricao}</p>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{l.tipo}</p>
              </div>
              <p className="text-sm font-semibold tabular-nums">{formatBRL(l.valor)}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between rounded-xl border border-accent/40 bg-[image:var(--gradient-primary)]/10 p-4">
          <span className="text-xs uppercase tracking-widest text-muted-foreground">Total OEM</span>
          <span className="text-xl font-semibold text-gradient tabular-nums">{formatBRL(total)}</span>
        </div>
      </SheetContent>
    </Sheet>
  );
}