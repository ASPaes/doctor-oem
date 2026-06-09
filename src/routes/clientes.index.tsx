import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Search, Building2 } from "lucide-react";
import { clientesMock, formatBRL } from "@/lib/mock-data";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useRole } from "@/lib/role-context";

export const Route = createFileRoute("/clientes/")({
  head: () => ({
    meta: [
      { title: "Clientes · Nexus Hub" },
      { name: "description", content: "Lista completa de clientes, status operacional e custos mensais." },
    ],
  }),
  component: ClientesList,
});

function ClientesList() {
  const [q, setQ] = useState("");
  const { canSeeFinance } = useRole();
  const list = clientesMock.filter(
    (c) =>
      !q ||
      c.nomeFantasia.toLowerCase().includes(q.toLowerCase()) ||
      c.cnpj.includes(q) ||
      c.grupoEconomico.toLowerCase().includes(q.toLowerCase()),
  );

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
            placeholder="Buscar por nome, CNPJ ou grupo"
            className="pl-9 glass-panel border-border"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((c) => (
          <Link
            key={c.id}
            to="/clientes/$id"
            params={{ id: c.id }}
            className="glass-panel group relative rounded-2xl p-5 transition hover:glow-border"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-[image:var(--gradient-primary)] text-primary-foreground">
                  <Building2 className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold leading-tight">{c.nomeFantasia}</p>
                  <p className="text-xs text-muted-foreground">{c.grupoEconomico}</p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
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
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
              <Info label="CNPJ" value={c.cnpj} />
              <Info label="Produto" value={c.produtoPrincipal} />
              <Info label="Filiais" value={String(c.filiaisAtivas)} />
              <Info label="PDVs" value={String(c.qtdPdv)} />
            </dl>
            {canSeeFinance && (
              <div className="mt-5 flex items-end justify-between border-t border-border pt-4">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Custo mensal</p>
                  <p className="text-lg font-semibold tabular-nums">{formatBRL(c.custoMensal)}</p>
                </div>
                <span className="text-xs text-primary group-hover:underline">Abrir ficha →</span>
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground">{value}</dd>
    </div>
  );
}