import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listAllTenants,
  createTenant,
  updateTenant,
  getTenantOemSettings,
  upsertTenantOemSettings,
} from "@/lib/tenant.functions";
import { testTenantOemConnection, avancarCargaTenant } from "@/lib/tenant-oem.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Settings as SettingsIcon, Zap, PlugZap } from "lucide-react";
import { Pencil } from "lucide-react";

export const Route = createFileRoute("/empresas")({
  head: () => ({
    meta: [
      { title: "Empresas · Nexus Hub" },
      { name: "description", content: "Cadastro de empresas (tenants) e configurações OEM por tenant." },
    ],
  }),
  component: EmpresasPage,
  errorComponent: ({ error }) => <div className="p-10 text-center text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-10 text-center text-muted-foreground">Página não encontrada.</div>,
});

function EmpresasPage() {
  const qc = useQueryClient();
  const list = useServerFn(listAllTenants);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { data: empresas, isLoading } = useQuery({
    queryKey: ["empresas", "all"],
    queryFn: () => list(),
    enabled: mounted,
    retry: false,
  });
  const create = useServerFn(createTenant);
  const update = useServerFn(updateTenant);

  const createMut = useMutation({
    mutationFn: (input: { nome: string; slug: string; cnpj?: string }) => create({ data: input }),
    onSuccess: () => {
      toast.success("Empresa criada");
      qc.invalidateQueries({ queryKey: ["empresas", "all"] });
      qc.invalidateQueries({ queryKey: ["my-tenants"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleAtivo = useMutation({
    mutationFn: (input: { id: string; ativo: boolean }) => update({ data: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["empresas", "all"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [slug, setSlug] = useState("");
  const [cnpj, setCnpj] = useState("");

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Multi-tenant</p>
          <h1 className="text-3xl font-semibold text-gradient">Empresas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cada empresa é 100% isolada. Configure as credenciais OEM da empresa para que apenas seus dados sejam exibidos.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Nova empresa</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Cadastrar empresa</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Nome</Label>
                <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Acme Foods" />
              </div>
              <div className="space-y-1.5">
                <Label>Slug (identificador)</Label>
                <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="ex: acme-foods" />
              </div>
              <div className="space-y-1.5">
                <Label>CNPJ (opcional)</Label>
                <Input value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={createMut.isPending || !nome || !slug}
                onClick={async () => {
                  await createMut.mutateAsync({ nome, slug, cnpj: cnpj || undefined });
                  setOpen(false); setNome(""); setSlug(""); setCnpj("");
                }}
              >
                {createMut.isPending ? "Criando…" : "Criar empresa"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {(empresas ?? []).map((e) => (
          <Card key={e.id}>
            <CardContent className="p-4 flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{e.nome}</h3>
                  <Badge variant="outline" className="text-[10px]">{e.slug}</Badge>
                  {!e.ativo && <Badge variant="outline" className="border-destructive/50 text-destructive">Inativa</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{e.cnpj ?? "—"}</p>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs">Ativa</Label>
                <Switch
                  checked={e.ativo}
                  onCheckedChange={(v) => toggleAtivo.mutate({ id: e.id, ativo: v })}
                />
              </div>
              <OemSettingsDialog tenantId={e.id} tenantNome={e.nome} />
              <CargaInicialButton tenantId={e.id} tenantNome={e.nome} />
              <EditTenantDialog tenant={e} />
            </CardContent>
          </Card>
        ))}
        {empresas && empresas.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Nenhuma empresa cadastrada ainda.
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Voltar para <Link to="/" className="text-primary hover:underline">Visão Geral</Link>
      </p>
    </div>
  );
}

function OemSettingsDialog({ tenantId, tenantNome }: { tenantId: string; tenantNome: string }) {
  const [open, setOpen] = useState(false);
  const get = useServerFn(getTenantOemSettings);
  const save = useServerFn(upsertTenantOemSettings);
  const testConn = useServerFn(testTenantOemConnection);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-oem", tenantId],
    queryFn: () => get({ data: { tenantId } }),
    enabled: open,
  });

  const [form, setForm] = useState({
    oem_api_base_url: "https://api.pdvlegal.com.br",
    oem_api_username: "",
    oem_api_password: "",
    oem_client_id: "",
    oem_client_secret: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setForm({
        oem_api_base_url: data.oem_api_base_url ?? "https://api.pdvlegal.com.br",
        oem_api_username: data.oem_api_username ?? "",
        oem_api_password: data.oem_api_password ?? "",
        oem_client_id: data.oem_client_id ?? "",
        oem_client_secret: data.oem_client_secret ?? "",
      });
      setLoaded(true);
    }
  }, [data, loaded]);
  useEffect(() => {
    if (!open) setLoaded(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <SettingsIcon className="h-3.5 w-3.5" /> Credenciais OEM
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Credenciais OEM — {tenantNome}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Preencha as credenciais OAuth2 da API OEM (TabletCloud / PDV Legal). Elas ficam restritas ao admin desta empresa por RLS.
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="space-y-3">
            <Field label="URL base da API OEM" value={form.oem_api_base_url} onChange={(v) => setForm({ ...form, oem_api_base_url: v })} />
            <Field label="Usuário (username)" value={form.oem_api_username} onChange={(v) => setForm({ ...form, oem_api_username: v })} />
            <Field label="Senha (password)" type="password" value={form.oem_api_password} onChange={(v) => setForm({ ...form, oem_api_password: v })} />
            <Field label="Client ID" value={form.oem_client_id} onChange={(v) => setForm({ ...form, oem_client_id: v })} />
            <Field label="Client Secret" type="password" value={form.oem_client_secret} onChange={(v) => setForm({ ...form, oem_client_secret: v })} />
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={testing}
            className="gap-2"
            onClick={async () => {
              // Salva antes para garantir que o teste use o que está na tela.
              try {
                setTesting(true);
                await save({
                  data: {
                    tenant_id: tenantId,
                    oem_api_base_url: form.oem_api_base_url || null,
                    oem_api_username: form.oem_api_username || null,
                    oem_api_password: form.oem_api_password || null,
                    oem_client_id: form.oem_client_id || null,
                    oem_client_secret: form.oem_client_secret || null,
                  },
                });
                const r = await testConn({ data: { tenantId } });
                if (r.ok) toast.success("Conexão OK — token obtido com sucesso.");
                else toast.error(`Falha: ${r.mensagem}`);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Erro ao testar conexão");
              } finally {
                setTesting(false);
              }
            }}
          >
            <PlugZap className="h-4 w-4" /> {testing ? "Testando…" : "Testar conexão"}
          </Button>
          <Button
            onClick={async () => {
              try {
                await save({
                  data: {
                    tenant_id: tenantId,
                    oem_api_base_url: form.oem_api_base_url || null,
                    oem_api_username: form.oem_api_username || null,
                    oem_api_password: form.oem_api_password || null,
                    oem_client_id: form.oem_client_id || null,
                    oem_client_secret: form.oem_client_secret || null,
                  },
                });
                toast.success("Credenciais salvas");
                qc.invalidateQueries({ queryKey: ["tenant-oem", tenantId] });
                setOpen(false);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Falha ao salvar");
              }
            }}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  );
}

function CargaInicialButton({ tenantId, tenantNome }: { tenantId: string; tenantNome: string }) {
  const run = useServerFn(avancarCargaTenant);
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="default"
      size="sm"
      className="gap-2"
      disabled={pending}
      onClick={async () => {
        if (!confirm(`Disparar carga inicial para ${tenantNome}? A sincronização roda em segundo plano e pode levar vários minutos.`)) return;
        try {
          setPending(true);
          await run({ data: { tenantId, origem: "carga-inicial" } });
          toast.success(`Carga inicial iniciada para ${tenantNome}. Acompanhe em Configurações.`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Falha ao iniciar carga");
        } finally {
          setPending(false);
        }
      }}
    >
      <Zap className="h-3.5 w-3.5" /> Carga inicial
    </Button>
  );
}

function EditTenantDialog({ tenant }: { tenant: { id: string; nome: string; cnpj: string | null } }) {
  const qc = useQueryClient();
  const update = useServerFn(updateTenant);
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState(tenant.nome);
  const [cnpj, setCnpj] = useState(tenant.cnpj ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setNome(tenant.nome);
      setCnpj(tenant.cnpj ?? "");
    }
  }, [open, tenant.nome, tenant.cnpj]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Pencil className="h-3.5 w-3.5" /> Editar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Editar empresa</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>CNPJ</Label>
            <Input value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            O slug (identificador) não pode ser alterado após o cadastro.
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={saving || !nome}
            onClick={async () => {
              try {
                setSaving(true);
                await update({ data: { id: tenant.id, nome, cnpj: cnpj || null } });
                toast.success("Empresa atualizada");
                qc.invalidateQueries({ queryKey: ["empresas", "all"] });
                qc.invalidateQueries({ queryKey: ["my-tenants"] });
                setOpen(false);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Falha ao atualizar");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}