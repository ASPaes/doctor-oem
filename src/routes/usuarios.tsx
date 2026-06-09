import { createFileRoute } from "@tanstack/react-router";
import { type Role } from "@/lib/mock-data";
import { listUsuarios } from "@/lib/doctoroem.functions";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, UserCog, Shield, Wallet, Headset } from "lucide-react";
import { useRole, roleLabels } from "@/lib/role-context";

const usuariosQueryOptions = queryOptions({
  queryKey: ["doctoroem", "usuarios"],
  queryFn: () => listUsuarios(),
});

export const Route = createFileRoute("/usuarios")({
  head: () => ({
    meta: [
      { title: "Usuários & Acesso · Nexus Hub" },
      { name: "description", content: "Gerencie perfis de acesso RBAC: Admin, Financeiro e Suporte." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(usuariosQueryOptions),
  component: Usuarios,
  pendingComponent: () => (
    <div className="p-10 text-center text-muted-foreground">Carregando usuários…</div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-destructive">{error.message}</div>
  ),
});

const roleIcon: Record<Role, typeof Shield> = {
  admin: Shield,
  financeiro: Wallet,
  suporte: Headset,
};

const roleDescricao: Record<Role, string> = {
  admin: "Acesso total ao hub, integrações e financeiro.",
  financeiro: "Cadastros, faturas, custos e licenças OEM.",
  suporte: "Status operacional. Valores e financeiro ocultos.",
};

function Usuarios() {
  const { canManageUsers } = useRole();
  const { data: usuarios } = useSuspenseQuery(usuariosQueryOptions);

  if (!canManageUsers) {
    return (
      <div className="p-10">
        <div className="glass-panel mx-auto max-w-md rounded-2xl p-8 text-center">
          <Shield className="mx-auto h-8 w-8 text-destructive" />
          <h2 className="mt-3 text-lg font-semibold">Acesso restrito</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Apenas administradores podem gerenciar usuários e perfis de acesso.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">RBAC</p>
          <h1 className="text-3xl font-semibold text-gradient">Usuários &amp; Perfis</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Controle de acesso baseado em papéis. Edite, ative ou crie novos usuários.
          </p>
        </div>
        <Button className="bg-[image:var(--gradient-primary)] text-primary-foreground shadow-[var(--shadow-glow)]">
          <Plus className="mr-2 h-4 w-4" /> Novo usuário
        </Button>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(Object.keys(roleLabels) as Role[]).map((r) => {
          const Icon = roleIcon[r];
          const count = usuarios.filter((u) => u.role === r).length;
          return (
            <div key={r} className="glass-panel rounded-2xl p-5">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-secondary text-accent">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="font-semibold">{roleLabels[r]}</p>
                  <p className="text-xs text-muted-foreground">{count} usuários</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{roleDescricao[r]}</p>
            </div>
          );
        })}
      </section>

      <section className="glass-panel rounded-2xl overflow-hidden">
        <header className="flex items-center gap-2 border-b border-border px-5 py-4">
          <UserCog className="h-4 w-4 text-accent" />
          <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Usuários cadastrados</h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-5 py-3">Nome</th>
                <th className="px-5 py-3">Perfil</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Último acesso</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => (
                <tr key={u.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/30 transition">
                  <td className="px-5 py-3">
                    <p className="font-medium">{u.nome}</p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </td>
                  <td className="px-5 py-3">
                    <Badge variant="outline" className="border-primary/40 text-primary">
                      {roleLabels[u.role]}
                    </Badge>
                  </td>
                  <td className="px-5 py-3">
                    <Badge
                      variant="outline"
                      className={u.ativo ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}
                    >
                      {u.ativo ? "Ativo" : "Inativo"}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {new Date(u.ultimoAcesso).toLocaleString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}