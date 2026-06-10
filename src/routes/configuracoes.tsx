import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { queryOptions, useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plug, RefreshCw, Save, Clock } from "lucide-react";
import { getSyncSettings, updateSyncSettings, scheduledOemSync } from "@/lib/oem-sync.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

const syncSettingsQueryOptions = queryOptions({
  queryKey: ["doctoroem", "sync-settings"],
  queryFn: () => getSyncSettings(),
  // Atualiza os logs automaticamente a cada 5s para acompanhar
  // execuções em andamento no servidor (cron ou manual).
  refetchInterval: 5000,
  refetchIntervalInBackground: true,
});

export const Route = createFileRoute("/configuracoes")({
  head: () => ({
    meta: [
      { title: "Configurações · Nexus Hub" },
      {
        name: "description",
        content: "Controle da sincronização automática com o OEM da TabletCloud e logs de execução.",
      },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(syncSettingsQueryOptions),
  component: ConfiguracoesPage,
  pendingComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Carregando configurações…</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
  notFoundComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Configurações não encontradas.</div>
  ),
});

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "sucesso") return "border-success/40 text-success";
  if (s === "erro") return "border-destructive/50 text-destructive";
  return "border-muted-foreground/30 text-muted-foreground";
}

function formatDataHora(iso: string): { data: string; hora: string } {
  const d = new Date(iso);
  // Fuso fixo para evitar divergência entre servidor (UTC) e navegador.
  const timeZone = "America/Sao_Paulo";
  return {
    data: d.toLocaleDateString("pt-BR", { timeZone }),
    hora: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone }),
  };
}

function ConfiguracoesPage() {
  const { data: settings, refetch, isFetching } = useSuspenseQuery(syncSettingsQueryOptions);
  const queryClient = useQueryClient();

  const [intervalo, setIntervalo] = useState(settings.intervaloHoras);
  const [ativo, setAtivo] = useState(settings.ativo);

  useEffect(() => {
    setIntervalo(settings.intervaloHoras);
    setAtivo(settings.ativo);
  }, [settings.intervaloHoras, settings.ativo]);

  const salvarFn = useServerFn(updateSyncSettings);
  const salvarMutation = useMutation({
    mutationFn: () => salvarFn({ data: { intervaloHoras: intervalo, ativo } }),
    onSuccess: () => {
      toast.success("Configurações da sincronização salvas com sucesso.");
      queryClient.invalidateQueries({ queryKey: ["doctoroem", "sync-settings"] });
    },
    onError: (err: Error) => toast.error(`Falha ao salvar: ${err.message}`),
  });

  const executarFn = useServerFn(scheduledOemSync);
  const executarMutation = useMutation({
    mutationFn: () => executarFn(),
    onSuccess: (res) => {
      if (res.status === "sucesso") {
        toast.success(`Sincronização concluída: ${res.mensagem}`);
      } else {
        toast.error(`Sincronização terminou com status "${res.status}": ${res.mensagem}`);
      }
      queryClient.invalidateQueries({ queryKey: ["doctoroem"] });
    },
    onError: (err: Error) => toast.error(`Falha na sincronização: ${err.message}`),
  });

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Integrações</p>
        <h1 className="text-3xl font-semibold text-gradient">Configurações</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Automação da sincronização com o OEM da TabletCloud.
        </p>
      </div>

      {!settings.tabelasProntas && (
        <div className="glass-panel rounded-2xl border border-destructive/40 p-5 text-sm">
          <p className="font-semibold text-destructive">Tabelas de controle ausentes</p>
          <p className="mt-1 text-muted-foreground">
            As tabelas <code>oem_sync_config</code> e <code>oem_sync_logs</code> ainda não existem
            no banco. Rode o SQL de criação (enviado no chat) no editor SQL do projeto para ativar
            a automação e os logs.
          </p>
        </div>
      )}

      <div className="glass-panel rounded-2xl p-6 space-y-6 max-w-3xl">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-primary)] text-primary-foreground">
            <Plug className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold leading-tight">OEM TabletCloud</p>
            <p className="text-xs text-muted-foreground">
              Sincronização automática de módulos, custos e licenças.
            </p>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="intervalo">Intervalo de Sincronização Automática (em horas)</Label>
            <div className="relative">
              <Clock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="intervalo"
                type="number"
                min={1}
                max={168}
                value={intervalo}
                onChange={(e) => setIntervalo(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
                className="pl-9"
              />
            </div>
            <p className="text-xs text-muted-foreground">Padrão: 24h. Entre 1 e 168 horas.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="automacao">Sincronização em Segundo Plano</Label>
            <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-2.5">
              <Switch id="automacao" checked={ativo} onCheckedChange={setAtivo} />
              <span className="text-sm">
                {ativo ? "Automação ativada" : "Automação desativada"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Quando ativada, a Cron Job atualiza toda a base em lotes de 20 clientes.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button
            onClick={() => salvarMutation.mutate()}
            disabled={salvarMutation.isPending || !settings.tabelasProntas}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            {salvarMutation.isPending ? "Salvando…" : "Salvar configurações"}
          </Button>
          <Button
            variant="outline"
            onClick={() => executarMutation.mutate()}
            disabled={executarMutation.isPending}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${executarMutation.isPending ? "animate-spin" : ""}`} />
            {executarMutation.isPending ? "Sincronizando toda a base…" : "Executar sincronização agora"}
          </Button>
        </div>
      </div>

      <div className="glass-panel rounded-2xl p-6 max-w-5xl">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold mb-1">Logs de Execução</p>
            <p className="text-xs text-muted-foreground">
              Últimas 10 execuções · atualização automática a cada 5 segundos.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Atualizar logs
          </Button>
        </div>
        {settings.logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Nenhuma execução registrada ainda.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Horário</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Clientes Atualizados</TableHead>
                <TableHead className="text-right">Falhas</TableHead>
                <TableHead className="text-right">Duração</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.logs.map((log) => {
                const { data, hora } = formatDataHora(log.executadoEm);
                return (
                  <TableRow key={log.id}>
                    <TableCell className="tabular-nums">{data}</TableCell>
                    <TableCell className="tabular-nums">{hora}</TableCell>
                    <TableCell className="capitalize">{log.origem}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusBadge(log.status)}>
                        {log.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {log.clientesAtualizados}/{log.totalClientes}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{log.clientesFalha}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {log.duracaoMs == null ? "—" : `${(log.duracaoMs / 1000).toFixed(1)}s`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}