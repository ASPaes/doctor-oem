import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plug, RefreshCw, Save, Clock, KeyRound, PlugZap, Zap } from "lucide-react";
import {
  updateTenantSyncSettings,
  avancarCargaTenant,
  testTenantOemConnection,
  gerarChaveIntegracao,
  revogarChaveIntegracao,
} from "@/lib/tenant-oem.functions";
import { obterSyncSettings, listarChaves } from "@/lib/oem-dados";
import { getTenantOemSettings, upsertTenantOemSettings } from "@/lib/tenant.functions";
import { useTenant } from "@/lib/tenant-context";
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

export const Route = createFileRoute("/configuracoes")({
  head: () => ({
    meta: [
      { title: "Configurações · Nexus Hub" },
      {
        name: "description",
        content:
          "Credenciais OEM por empresa, controle da sincronização automática e logs de execução.",
      },
    ],
  }),
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
  const { activeTenant, loading: tenantLoading } = useTenant();
  const queryClient = useQueryClient();

  const updateSync = useServerFn(updateTenantSyncSettings);
  const avancar = useServerFn(avancarCargaTenant);
  const getCreds = useServerFn(getTenantOemSettings);
  const saveCreds = useServerFn(upsertTenantOemSettings);
  const testConn = useServerFn(testTenantOemConnection);

  const tenantId = activeTenant?.id ?? null;

  const { data: settings, refetch, isFetching } = useQuery({
    queryKey: ["tenant-sync", tenantId],
    queryFn: () => obterSyncSettings(tenantId!),
    enabled: !!tenantId,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  const { data: creds, isLoading: credsLoading } = useQuery({
    queryKey: ["tenant-oem-creds", tenantId],
    queryFn: () => getCreds({ data: { tenantId: tenantId! } }),
    enabled: !!tenantId,
  });

  const [intervalo, setIntervalo] = useState(24);
  const [ativo, setAtivo] = useState(true);

  useEffect(() => {
    if (settings) {
      setIntervalo(settings.intervaloHoras);
      setAtivo(settings.ativo);
    }
  }, [settings]);

  const [credForm, setCredForm] = useState({
    oem_api_base_url: "https://api.pdvlegal.com.br",
    oem_api_username: "",
    oem_api_password: "",
    oem_client_id: "",
    oem_client_secret: "",
  });
  const [credLoaded, setCredLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (creds && credLoaded !== tenantId) {
      setCredForm({
        oem_api_base_url: creds.oem_api_base_url ?? "https://api.pdvlegal.com.br",
        oem_api_username: creds.oem_api_username ?? "",
        oem_api_password: "",
        oem_client_id: creds.oem_client_id ?? "",
        oem_client_secret: "",
      });
      setCredLoaded(tenantId);
    }
  }, [creds, tenantId, credLoaded]);

  const salvarMutation = useMutation({
    mutationFn: () => updateSync({ data: { tenantId: tenantId!, intervaloHoras: intervalo, ativo } }),
    onSuccess: () => {
      toast.success("Configurações salvas.");
      queryClient.invalidateQueries({ queryKey: ["tenant-sync", tenantId] });
    },
    onError: (err: Error) => toast.error(`Falha ao salvar: ${err.message}`),
  });

  // Chaves de integração: leitura direta (RLS limita ao tenant), geração e
  // revogação por função de servidor, que exige admin da empresa.
  const [chaveNova, setChaveNova] = useState<string | null>(null);
  const gerarChave = useServerFn(gerarChaveIntegracao);
  const revogarChave = useServerFn(revogarChaveIntegracao);
  const { data: chaves = [] } = useQuery({
    queryKey: ["oem-chaves", tenantId],
    queryFn: () => listarChaves(tenantId!),
    enabled: !!tenantId,
  });
  const gerarChaveMutation = useMutation({
    mutationFn: () =>
      gerarChave({ data: { tenantId: tenantId!, nome: "DoctorSaaS" } }),
    onSuccess: ({ chave }) => {
      setChaveNova(chave);
      queryClient.invalidateQueries({ queryKey: ["oem-chaves", tenantId] });
    },
    onError: (err: Error) => toast.error(`Falha ao gerar chave: ${err.message}`),
  });
  const revogarMutation = useMutation({
    mutationFn: (id: string) => revogarChave({ data: { tenantId: tenantId!, id } }),
    onSuccess: () => {
      toast.success("Chave revogada.");
      queryClient.invalidateQueries({ queryKey: ["oem-chaves", tenantId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // A carga completa faz ~2 chamadas ao OEM por cliente — não cabe numa
  // requisição só. Cada passo processa um lote e devolve quanto falta;
  // aqui chamamos em loop até acabar, mostrando o progresso no botão.
  const [progresso, setProgresso] = useState<string | null>(null);
  const executarMutation = useMutation({
    mutationFn: async () => {
      let passo = await avancar({ data: { tenantId: tenantId!, origem: "manual" } });
      for (let volta = 0; volta < 500; volta++) {
        if (passo.concluido || passo.fase === "erro") break;
        setProgresso(
          passo.fase === "listando"
            ? `Enumerando… ${passo.enfileirados} na fila`
            : `${passo.processados}/${passo.enfileirados} · faltam ${passo.restantes}`,
        );
        queryClient.invalidateQueries({ queryKey: ["tenant-sync", tenantId] });
        passo = await avancar({ data: { tenantId: tenantId!, origem: "manual" } });
      }
      setProgresso(null);
      return passo;
    },
    onSuccess: (passo) => {
      if (passo.fase === "erro") {
        toast.error(`Sincronização interrompida: ${passo.mensagem}`);
      } else if (passo.concluido) {
        toast.success(`Sincronização concluída — ${passo.mensagem}`);
      } else {
        toast.warning(`Sincronização pausada: ${passo.mensagem}`);
      }
      queryClient.invalidateQueries({ queryKey: ["tenant-sync", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["tenant-clientes", tenantId] });
    },
    onError: (err: Error) => {
      setProgresso(null);
      toast.error(`Falha na sincronização: ${err.message}`);
    },
  });

  const salvarCredsMutation = useMutation({
    mutationFn: () =>
      saveCreds({
        data: {
          tenant_id: tenantId!,
          oem_api_base_url: credForm.oem_api_base_url || null,
          oem_api_username: credForm.oem_api_username || null,
          oem_api_password: credForm.oem_api_password || null,
          oem_client_id: credForm.oem_client_id || null,
          oem_client_secret: credForm.oem_client_secret || null,
        },
      }),
    onSuccess: () => {
      toast.success("Credenciais salvas.");
      queryClient.invalidateQueries({ queryKey: ["tenant-oem-creds", tenantId] });
    },
    onError: (err: Error) => toast.error(`Falha: ${err.message}`),
  });

  const testarMutation = useMutation({
    mutationFn: async () => {
      // garante que o que está na tela esteja salvo antes do teste
      await saveCreds({
        data: {
          tenant_id: tenantId!,
          oem_api_base_url: credForm.oem_api_base_url || null,
          oem_api_username: credForm.oem_api_username || null,
          oem_api_password: credForm.oem_api_password || null,
          oem_client_id: credForm.oem_client_id || null,
          oem_client_secret: credForm.oem_client_secret || null,
        },
      });
      return testConn({ data: { tenantId: tenantId! } });
    },
    onSuccess: (r) => {
      if (r.ok) toast.success("Conexão OK — token OAuth2 obtido.");
      else toast.error(`Falha na conexão: ${r.mensagem}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (tenantLoading || !tenantId) {
    return <div className="p-10 text-center text-muted-foreground">Selecione uma empresa…</div>;
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Integrações</p>
        <h1 className="text-3xl font-semibold text-gradient">Configurações</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Empresa ativa: <strong>{activeTenant?.nome}</strong> — credenciais e sincronização isoladas por empresa.
        </p>
      </div>

      {/* ===== Credenciais OEM por empresa ===== */}
      <div className="glass-panel rounded-2xl p-6 space-y-4 max-w-3xl">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-primary)] text-primary-foreground">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Credenciais da API OEM</p>
            <p className="text-xs text-muted-foreground">
              OAuth2 (password grant) — usados pela sincronização desta empresa.
            </p>
          </div>
        </div>
        {credsLoading ? (
          <p className="text-sm text-muted-foreground">Carregando credenciais…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>URL base da API</Label>
              <Input
                value={credForm.oem_api_base_url}
                onChange={(e) => setCredForm({ ...credForm, oem_api_base_url: e.target.value })}
                placeholder="https://api.pdvlegal.com.br"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Usuário (username)</Label>
              <Input
                value={credForm.oem_api_username}
                onChange={(e) => setCredForm({ ...credForm, oem_api_username: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Senha (password)</Label>
              <Input
                type="password"
                value={credForm.oem_api_password}
                onChange={(e) => setCredForm({ ...credForm, oem_api_password: e.target.value })}
                autoComplete="new-password"
                placeholder={creds?.tem_segredos ? "•••••••• guardada no cofre" : "não cadastrada"}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Client ID</Label>
              <Input
                value={credForm.oem_client_id}
                onChange={(e) => setCredForm({ ...credForm, oem_client_id: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Client Secret</Label>
              <Input
                type="password"
                value={credForm.oem_client_secret}
                onChange={(e) => setCredForm({ ...credForm, oem_client_secret: e.target.value })}
                autoComplete="new-password"
                placeholder={creds?.tem_segredos ? "•••••••• guardado no cofre" : "não cadastrado"}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Senha e Client Secret ficam no cofre do Supabase e não são mais legíveis pela tela.
              Deixe em branco para manter os que já estão gravados.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button
            onClick={() => salvarCredsMutation.mutate()}
            disabled={salvarCredsMutation.isPending}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            {salvarCredsMutation.isPending ? "Salvando…" : "Salvar credenciais"}
          </Button>
          <Button
            variant="outline"
            onClick={() => testarMutation.mutate()}
            disabled={testarMutation.isPending}
            className="gap-2"
          >
            <PlugZap className={`h-4 w-4 ${testarMutation.isPending ? "animate-pulse" : ""}`} />
            {testarMutation.isPending ? "Testando…" : "Testar conexão"}
          </Button>
          <Button
            variant="default"
            onClick={() => executarMutation.mutate()}
            disabled={executarMutation.isPending}
            className="gap-2"
          >
            <Zap className={`h-4 w-4 ${executarMutation.isPending ? "animate-pulse" : ""}`} />
            {executarMutation.isPending
              ? (progresso ?? "Sincronizando…")
              : "Carga inicial / sincronizar agora"}
          </Button>
        </div>
      </div>

      {/* ---------------------------------------------------------------
          Chave de integração: é por ela que o DoctorSaaS lê esta empresa.
          Guardamos só o SHA-256 — a chave em claro aparece uma única vez.
          --------------------------------------------------------------- */}
      <div className="glass-panel rounded-2xl p-6 space-y-4 max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-primary)] text-primary-foreground">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold leading-tight">Chave de integração</p>
              <p className="text-xs text-muted-foreground">
                Use no DoctorSaaS, em Configurações › Integrações › OEM.
              </p>
            </div>
          </div>
          <Button
            onClick={() => gerarChaveMutation.mutate()}
            disabled={gerarChaveMutation.isPending}
            className="gap-2"
          >
            <KeyRound className="h-4 w-4" />
            {gerarChaveMutation.isPending ? "Gerando…" : "Gerar chave"}
          </Button>
        </div>

        {chaveNova && (
          <div className="rounded-xl border border-success/40 bg-success/10 p-4 space-y-2">
            <p className="text-sm font-medium text-success">
              Copie agora — ela não aparece de novo.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-background/60 px-3 py-2 text-xs break-all">
                {chaveNova}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(chaveNova).catch(() => {});
                  toast.success("Chave copiada.");
                }}
              >
                Copiar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Guardamos apenas o resumo criptográfico dela. Se perder, gere outra e revogue esta.
            </p>
          </div>
        )}

        {chaves.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma chave gerada. Sem uma chave, o DoctorSaaS não tem como ler esta empresa.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {chaves.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{k.nome}</p>
                  <p className="font-mono text-xs text-muted-foreground">{k.prefixo}…</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {k.ultimo_uso_em
                    ? `usada ${new Date(k.ultimo_uso_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
                    : "nunca usada"}
                </div>
                {k.ativa ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => {
                      if (window.confirm(`Revogar a chave "${k.nome}"? O DoctorSaaS para de ler esta empresa na hora.`)) {
                        revogarMutation.mutate(k.id);
                      }
                    }}
                  >
                    Revogar
                  </Button>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">revogada</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-panel rounded-2xl p-6 space-y-6 max-w-3xl">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-primary)] text-primary-foreground">
            <Plug className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Automação da sincronização</p>
            <p className="text-xs text-muted-foreground">
              Frequência e ativação da sincronização em segundo plano.
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
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button
            onClick={() => salvarMutation.mutate()}
            disabled={salvarMutation.isPending}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            {salvarMutation.isPending ? "Salvando…" : "Salvar configurações"}
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
        {!settings || settings.logs.length === 0 ? (
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