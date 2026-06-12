import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo, useDeferredValue, useTransition } from "react";
import { Search, RefreshCw, Store, Monitor, DollarSign, Activity, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck, Power, PowerOff, Loader2 } from "lucide-react";
import { formatBRL } from "@/lib/mock-data";
import { listTenantClientes, runTenantInitialLoad, alterarStatusLicencaOem, alterarStatusAtivacaoOem } from "@/lib/tenant-oem.functions";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTenant } from "@/lib/tenant-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, CardContent } from "@/components/ui/card";
import { useRole } from "@/lib/role-context";
import { useHorizontalDragScroll } from "@/hooks/use-horizontal-drag-scroll";
import { toast } from "sonner";

export const Route = createFileRoute("/clientes/")({
  head: () => ({
    meta: [
      { title: "Clientes · Nexus Hub" },
      { name: "description", content: "Lista completa de clientes, status operacional e custos mensais." },
    ],
  }),
  component: ClientesList,
  pendingComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Carregando clientes do DoctorOEM…</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
});

function ClientesList() {
  const [q, setQ] = useState("");
  // Dimensão 1: status do CLIENTE (operacional)
  const [clienteFilter, setClienteFilter] = useState<string[]>(["ativo", "desativado"]);
  // Dimensão 2: status da LICENÇA
  const [licencaFilter, setLicencaFilter] = useState<string[]>(["ativa", "bloqueada"]);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const [, startTransition] = useTransition();
  // Valores adiados: o clique no filtro responde na hora e a tabela pesada re-renderiza depois
  const deferredQ = useDeferredValue(q);
  const deferredCliente = useDeferredValue(clienteFilter);
  const deferredLicenca = useDeferredValue(licencaFilter);
  const scrollRef = useHorizontalDragScroll<HTMLDivElement>();
  const { canSeeFinance, role } = useRole();
  const isAdmin = role === "admin";
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantId = activeTenant?.id ?? null;
  const queryClient = useQueryClient();
  const listFn = useServerFn(listTenantClientes);
  const runLoad = useServerFn(runTenantInitialLoad);
  const alterarLicFn = useServerFn(alterarStatusLicencaOem);
  const alterarAtvFn = useServerFn(alterarStatusAtivacaoOem);
  const { data: clientes = [], isLoading } = useQuery({
    queryKey: ["tenant-clientes", tenantId],
    queryFn: () => listFn({ data: { tenantId: tenantId! } }),
    enabled: !!tenantId,
  });
  const syncMutation = useMutation({
    mutationFn: () => runLoad({ data: { tenantId: tenantId!, origem: "manual" } }),
    onSuccess: () => {
      toast.success("Sincronização disparada — rodando em segundo plano. Acompanhe em Configurações.");
      queryClient.invalidateQueries({ queryKey: ["tenant-clientes", tenantId] });
    },
    onError: (err: Error) => toast.error(`Falha ao sincronizar base: ${err.message}`),
  });

  // Mutations por linha — controlam loading individual via variável `pendingId`
  const [pendingId, setPendingId] = useState<string | null>(null);
  const licencaMutation = useMutation({
    mutationFn: ({ clienteId, bloquear }: { clienteId: string; bloquear: boolean }) =>
      alterarLicFn({ data: { tenantId: tenantId!, clienteId, bloquear } }),
    onMutate: ({ clienteId }) => setPendingId(clienteId),
    onSuccess: (res) => {
      toast.success(res.bloqueado ? "Licença bloqueada no OEM." : "Licença desbloqueada no OEM.");
      queryClient.invalidateQueries({ queryKey: ["tenant-clientes", tenantId] });
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setPendingId(null),
  });
  const ativacaoMutation = useMutation({
    mutationFn: ({ clienteId, ativar }: { clienteId: string; ativar: boolean }) =>
      alterarAtvFn({ data: { tenantId: tenantId!, clienteId, ativar } }),
    onMutate: ({ clienteId }) => setPendingId(clienteId),
    onSuccess: (res) => {
      toast.success(res.ativo ? "Cliente reativado no OEM." : "Cliente desativado no OEM.");
      queryClient.invalidateQueries({ queryKey: ["tenant-clientes", tenantId] });
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setPendingId(null),
  });

  const list = useMemo(() => {
    const term = deferredQ.trim().toLowerCase();
    return clientes.filter((c) => {
      const cliKey = c.ativo ? "ativo" : "desativado";
      const licKey = c.bloqueado ? "bloqueada" : "ativa";
      if (deferredCliente.length > 0 && !deferredCliente.includes(cliKey)) return false;
      if (deferredLicenca.length > 0 && !deferredLicenca.includes(licKey)) return false;
      if (!term) return true;
      return (
        c.nomeFantasia.toLowerCase().includes(term) ||
        c.cnpj.includes(term) ||
        c.grupoEconomico.toLowerCase().includes(term) ||
        (c.codigoEmpresa ?? "").toLowerCase().includes(term) ||
        (c.codigoFilial ?? "").toLowerCase().includes(term)
      );
    });
  }, [clientes, deferredQ, deferredCliente, deferredLicenca]);

  // Cards refletem o resultado FILTRADO (não a base inteira)
  const totals = useMemo(
    () =>
      list.reduce(
        (acc, c) => {
          if (c.ativo && !c.bloqueado) acc.ativoLicAtiva++;
          else if (c.ativo && c.bloqueado) acc.ativoLicBloqueada++;
          else if (!c.ativo && !c.bloqueado) acc.desativadoLicAtiva++;
          else acc.desativadoLicBloqueada++;
          return acc;
        },
        { ativoLicAtiva: 0, ativoLicBloqueada: 0, desativadoLicAtiva: 0, desativadoLicBloqueada: 0 },
      ),
    [list],
  );

  const pageTotals = useMemo(
    () =>
      list.reduce(
        (acc, c) => {
          acc.filiais += c.filiaisAtivas;
          acc.pdvs += c.qtdPdv;
          acc.comandas += c.qtdComandas;
          acc.usuarios += c.usuariosAdicionais;
          acc.custo += c.custoMensal;
          return acc;
        },
        { filiais: 0, pdvs: 0, comandas: 0, usuarios: 0, custo: 0 },
      ),
    [list],
  );

  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageList = useMemo(
    () => list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [list, safePage],
  );

  if (tenantLoading || !tenantId) {
    return <div className="p-10 text-center text-muted-foreground">Selecione uma empresa no topo…</div>;
  }
  if (isLoading) {
    return <div className="p-10 text-center text-muted-foreground">Carregando clientes…</div>;
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Diretório</p>
          <h1 className="text-3xl font-semibold text-gradient">Clientes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {list.length} cliente{list.length !== 1 && "s"} sincronizados com o OEM.
          </p>
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nome, CNPJ, grupo, cód. empresa ou filial"
            className="pl-9 glass-panel border-border"
          />
        </div>
        <Button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          {syncMutation.isPending ? "Sincronizando…" : "Sincronizar Base de Clientes"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Cliente</span>
          <ToggleGroup
            type="multiple"
            value={clienteFilter}
            onValueChange={(v) => startTransition(() => { setClienteFilter(v); setPage(1); })}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="ativo">Ativo</ToggleGroupItem>
            <ToggleGroupItem value="desativado">Desativado</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Licença</span>
          <ToggleGroup
            type="multiple"
            value={licencaFilter}
            onValueChange={(v) => startTransition(() => { setLicencaFilter(v); setPage(1); })}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="ativa">Ativa</ToggleGroupItem>
            <ToggleGroupItem value="bloqueada">Bloqueada</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <ShieldCheck className="h-5 w-5 text-success mb-1" />
            <span className="text-2xl font-bold text-success">{totals.ativoLicAtiva}</span>
            <span className="text-[11px] text-muted-foreground leading-tight">Ativo<br/>Lic. Ativa</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <ShieldAlert className="h-5 w-5 text-destructive mb-1" />
            <span className="text-2xl font-bold text-destructive">{totals.ativoLicBloqueada}</span>
            <span className="text-[11px] text-muted-foreground leading-tight">Ativo<br/>Lic. Bloqueada</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <PowerOff className="h-5 w-5 text-muted-foreground mb-1" />
            <span className="text-2xl font-bold">{totals.desativadoLicAtiva}</span>
            <span className="text-[11px] text-muted-foreground leading-tight">Desativado<br/>Lic. Ativa</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <PowerOff className="h-5 w-5 text-destructive mb-1" />
            <span className="text-2xl font-bold">{totals.desativadoLicBloqueada}</span>
            <span className="text-[11px] text-muted-foreground leading-tight">Desativado<br/>Lic. Bloqueada</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <Activity className="h-5 w-5 text-muted-foreground mb-1" />
            <span className="text-2xl font-bold">{list.length}</span>
            <span className="text-xs text-muted-foreground">Filtrados</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <Store className="h-5 w-5 text-muted-foreground mb-1" />
            <span className="text-2xl font-bold">{pageTotals.filiais}</span>
            <span className="text-xs text-muted-foreground">Filiais</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center justify-center text-center">
            <Monitor className="h-5 w-5 text-muted-foreground mb-1" />
            <span className="text-2xl font-bold">{pageTotals.pdvs}</span>
            <span className="text-xs text-muted-foreground">PDVs</span>
          </CardContent>
        </Card>
        {canSeeFinance && (
          <Card>
            <CardContent className="p-4 flex flex-col items-center justify-center text-center">
              <DollarSign className="h-5 w-5 text-muted-foreground mb-1" />
              <span className="text-2xl font-bold">{formatBRL(pageTotals.custo)}</span>
              <span className="text-xs text-muted-foreground">Custo Mensal</span>
            </CardContent>
          </Card>
        )}
      </div>

      <div ref={scrollRef} className="rounded-xl border bg-card shadow overflow-x-auto select-none cursor-grab">
        <table className="min-w-max caption-bottom text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Cód. Empresa</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Cód. Filial</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Nome Fantasia</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">CNPJ</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Grupo Econômico</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Produto Principal</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Filiais</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">PDVs</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Status Cliente</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Status Licença</th>
              {canSeeFinance && (
                <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Custo Mensal</th>
              )}
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Ações</th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {pageList.map((c) => {
              const isBusy = pendingId === c.id;
              return (
              <tr
                key={c.id}
                className="border-b transition-colors hover:bg-muted/50"
              >
                <td className="p-2 px-3 align-middle whitespace-nowrap font-medium">{c.codigoEmpresa}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">{c.codigoFilial}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <Link to="/clientes/$id" params={{ id: c.id }} className="hover:text-primary hover:underline">
                    {c.nomeFantasia}
                  </Link>
                </td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.cnpj}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.grupoEconomico}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.produtoPrincipal}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.filiaisAtivas}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.qtdPdv}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <Badge
                    variant="outline"
                    className={c.ativo ? "border-success/40 text-success" : "border-muted-foreground/40 text-muted-foreground"}
                  >
                    {c.ativo ? "Ativo" : "Desativado"}
                  </Badge>
                </td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <Badge
                    variant="outline"
                    className={c.bloqueado ? "border-destructive/50 text-destructive" : "border-success/40 text-success"}
                  >
                    {c.bloqueado ? "Bloqueada" : "Ativa"}
                  </Badge>
                </td>
                {canSeeFinance && (
                  <td className="p-2 px-3 align-middle whitespace-nowrap tabular-nums font-medium">
                    {formatBRL(c.custoMensal)}
                  </td>
                )}
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {isAdmin && (
                      <>
                        {c.bloqueado ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 border-success/50 text-success hover:bg-success/10"
                            disabled={isBusy}
                            onClick={() => licencaMutation.mutate({ clienteId: c.id, bloquear: false })}
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                            Desbloquear
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 gap-1"
                            disabled={isBusy}
                            onClick={() => {
                              if (window.confirm(`Bloquear a licença de "${c.nomeFantasia}"? O sistema do cliente fica indisponível.`)) {
                                licencaMutation.mutate({ clienteId: c.id, bloquear: true });
                              }
                            }}
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                            Bloquear
                          </Button>
                        )}
                        {c.ativo ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                            disabled={isBusy}
                            onClick={() => {
                              if (window.confirm(`Desativar o cliente "${c.nomeFantasia}" no OEM?`)) {
                                ativacaoMutation.mutate({ clienteId: c.id, ativar: false });
                              }
                            }}
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PowerOff className="h-3 w-3" />}
                            Desativar
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 border-success/50 text-success hover:bg-success/10"
                            disabled={isBusy}
                            onClick={() => ativacaoMutation.mutate({ clienteId: c.id, ativar: true })}
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
                            Ativar
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Nenhum cliente encontrado com os filtros atuais.
          </div>
        )}
      </div>

      {list.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">
            Mostrando {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, list.length)} de {list.length} clientes
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Anterior
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              Página {safePage} de {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="gap-1"
            >
              Próxima <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}