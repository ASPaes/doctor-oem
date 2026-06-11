import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { formatBRL } from "@/lib/mock-data";
import { listClientes, bulkSyncClientes } from "@/lib/doctoroem.functions";
import { queryOptions, useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRole } from "@/lib/role-context";
import { toast } from "sonner";

const clientesQueryOptions = queryOptions({
  queryKey: ["doctoroem", "clientes"],
  queryFn: () => listClientes(),
});

export const Route = createFileRoute("/clientes/")({
  head: () => ({
    meta: [
      { title: "Clientes · Nexus Hub" },
      { name: "description", content: "Lista completa de clientes, status operacional e custos mensais." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(clientesQueryOptions),
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
  const [statusFilter, setStatusFilter] = useState<string[]>(["ativo", "inativo", "bloqueado"]);
  const { canSeeFinance } = useRole();
  const { data: clientes } = useSuspenseQuery(clientesQueryOptions);
  const queryClient = useQueryClient();
  const bulkSync = useServerFn(bulkSyncClientes);
  const syncMutation = useMutation({
    mutationFn: () => bulkSync(),
    onSuccess: (res) => {
      toast.success(
        `🎉 Carga total concluída! ${res.updated} cliente(s) atualizado(s), ${res.inserted} novo(s) capturado(s) na varredura (${res.scanned} consultas ao OEM).`,
      );
      queryClient.invalidateQueries({ queryKey: ["doctoroem", "clientes"] });
    },
    onError: (err: Error) => toast.error(`Falha ao sincronizar base: ${err.message}`),
  });
  const term = q.trim().toLowerCase();
  const list = clientes.filter((c) => {
    const status = c.bloqueado ? "bloqueado" : c.ativo ? "ativo" : "inativo";
    if (statusFilter.length > 0 && !statusFilter.includes(status)) return false;
    if (!term) return true;
    return (
      c.nomeFantasia.toLowerCase().includes(term) ||
      c.cnpj.includes(term) ||
      c.grupoEconomico.toLowerCase().includes(term) ||
      (c.codigoEmpresa ?? "").toLowerCase().includes(term) ||
      (c.codigoFilial ?? "").toLowerCase().includes(term)
    );
  });

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
            onChange={(e) => setQ(e.target.value)}
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

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Status</span>
        <ToggleGroup
          type="multiple"
          value={statusFilter}
          onValueChange={setStatusFilter}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="ativo" aria-label="Mostrar ativos">
            Ativo
          </ToggleGroupItem>
          <ToggleGroupItem value="inativo" aria-label="Mostrar inativos">
            Inativo
          </ToggleGroupItem>
          <ToggleGroupItem value="bloqueado" aria-label="Mostrar bloqueados">
            Bloqueado
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="rounded-xl border bg-card shadow overflow-x-auto">
        <table className="w-full caption-bottom text-sm">
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
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Comandas</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Usuários</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Status</th>
              {canSeeFinance && (
                <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Custo Mensal</th>
              )}
              <th className="h-10 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">Ação</th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {list.map((c) => (
              <tr
                key={c.id}
                className="border-b transition-colors hover:bg-muted/50"
              >
                <td className="p-2 px-3 align-middle whitespace-nowrap font-medium">{c.codigoEmpresa}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">{c.codigoFilial}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">{c.nomeFantasia}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.cnpj}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.grupoEconomico}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-muted-foreground">{c.produtoPrincipal}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.filiaisAtivas}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.qtdPdv}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.qtdComandas}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap text-center">{c.usuariosAdicionais}</td>
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <div className="flex flex-wrap gap-1">
                    <Badge
                      variant="outline"
                      className={c.ativo ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}
                    >
                      {c.ativo ? "Ativo" : "Inativo"}
                    </Badge>
                    {c.bloqueado && (
                      <Badge variant="outline" className="border-destructive/50 text-destructive">
                        Bloqueado
                      </Badge>
                    )}
                  </div>
                </td>
                {canSeeFinance && (
                  <td className="p-2 px-3 align-middle whitespace-nowrap tabular-nums font-medium">
                    {formatBRL(c.custoMensal)}
                  </td>
                )}
                <td className="p-2 px-3 align-middle whitespace-nowrap">
                  <Link
                    to="/clientes/$id"
                    params={{ id: c.id }}
                    className="text-xs text-primary hover:underline"
                  >
                    Abrir ficha →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Nenhum cliente encontrado com os filtros atuais.
          </div>
        )}
      </div>
    </div>
  );
}