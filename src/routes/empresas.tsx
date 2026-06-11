import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { queryOptions, useQuery, useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listAllTenants,
  createTenant,
  updateTenant,
  getTenantOemSettings,
  upsertTenantOemSettings,
} from "@/lib/tenant.functions";
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
import { Plus, Settings as SettingsIcon } from "lucide-react";

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
  const { data: empresas, isLoading } = useQuery({
    queryKey: ["empresas", "all"],
    queryFn: () => list(),
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
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["tenant-oem", tenantId],
    queryFn: () => get({ data: { tenantId } }),
    enabled: open,
  });

  const [form, setForm] = useState({
    doctoroem_url: "",
    doctoroem_publishable_secret_name: "",
    doctoroem_service_secret_name: "",
    tabletcloud_url: "",
    tabletcloud_token_secret_name: "",
  });

  // sync once loaded
  if (data && form.doctoroem_url === "" && (data.doctoroem_url ?? "") !== "") {
    setForm({
      doctoroem_url: data.doctoroem_url ?? "",
      doctoroem_publishable_secret_name: data.doctoroem_publishable_secret_name ?? "",
      doctoroem_service_secret_name: data.doctoroem_service_secret_name ?? "",
      tabletcloud_url: data.tabletcloud_url ?? "",
      tabletcloud_token_secret_name: data.tabletcloud_token_secret_name ?? "",
    });
  }

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
          As chaves não ficam no banco: armazene-as como secrets no painel Cloud e informe aqui apenas o <strong>nome</strong> do secret (ex.: <code>DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY</code>).
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="space-y-3">
            <Field label="DoctorOEM URL" value={form.doctoroem_url} onChange={(v) => setForm({ ...form, doctoroem_url: v })} />
            <Field label="Nome do secret — publishable key" value={form.doctoroem_publishable_secret_name} onChange={(v) => setForm({ ...form, doctoroem_publishable_secret_name: v })} />
            <Field label="Nome do secret — service-role key" value={form.doctoroem_service_secret_name} onChange={(v) => setForm({ ...form, doctoroem_service_secret_name: v })} />
            <Field label="TabletCloud URL" value={form.tabletcloud_url} onChange={(v) => setForm({ ...form, tabletcloud_url: v })} />
            <Field label="Nome do secret — TabletCloud token" value={form.tabletcloud_token_secret_name} onChange={(v) => setForm({ ...form, tabletcloud_token_secret_name: v })} />
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={async () => {
              try {
                await save({
                  data: {
                    tenant_id: tenantId,
                    doctoroem_url: form.doctoroem_url || null,
                    doctoroem_publishable_secret_name: form.doctoroem_publishable_secret_name || null,
                    doctoroem_service_secret_name: form.doctoroem_service_secret_name || null,
                    tabletcloud_url: form.tabletcloud_url || null,
                    tabletcloud_token_secret_name: form.tabletcloud_token_secret_name || null,
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

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}