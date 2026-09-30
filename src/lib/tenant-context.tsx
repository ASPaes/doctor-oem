import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { AllowedTenant } from "./tenant.functions";

interface TenantCtx {
  isSuper: boolean;
  tenants: AllowedTenant[];
  activeTenant: AllowedTenant | null;
  setActiveTenantId: (id: string) => Promise<void>;
  loading: boolean;
}

const Ctx = createContext<TenantCtx | null>(null);

// Mesmo nome do cookie que a função de servidor gravava: quem já tinha empresa
// escolhida continua nela depois desta troca.
const TENANT_COOKIE = "active_tenant_id";

function lerEmpresaAtiva(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${TENANT_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function gravarEmpresaAtiva(id: string) {
  document.cookie = `${TENANT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

// Lista de empresas lida pelo NAVEGADOR, direto no Supabase (29/09/2026).
// Era função de servidor: passava pelo Worker, que no plano grátis do
// Cloudflare tem 10ms de CPU e estourava — 503, `retry: false`, e o topo ficava
// em "Sem empresas" até o F5. Era a última leitura do carregamento que ainda
// passava pelo Worker (ver oem-dados.ts). O Worker já consultava com o token do
// próprio usuário, então o RLS é o mesmo: nada de segurança muda.
async function listarMinhasEmpresas(): Promise<{
  isSuper: boolean;
  tenants: AllowedTenant[];
  activeTenantId: string | null;
}> {
  const { data: sessao } = await supabase.auth.getSession();
  const userId = sessao.session?.user.id;
  if (!userId) throw new Error("Sessão não encontrada");

  const { data: rolesData, error: rolesErr } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (rolesErr) throw new Error(rolesErr.message);
  const isSuper = !!rolesData?.some((r) => r.role === "super_admin");

  let tenants: AllowedTenant[];
  if (isSuper) {
    const { data, error } = await supabase
      .from("tenants")
      .select("id, slug, nome, cnpj, ativo")
      .order("nome");
    if (error) throw new Error(error.message);
    tenants = (data ?? []).map((t) => ({ ...t, role: "super_admin" as const }));
  } else {
    const { data, error } = await supabase
      .from("tenant_members")
      .select("role, tenants(id, slug, nome, cnpj, ativo)")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    tenants = (data ?? [])
      .filter((row: any) => row.tenants)
      .map((row: any) => ({
        id: row.tenants.id,
        slug: row.tenants.slug,
        nome: row.tenants.nome,
        cnpj: row.tenants.cnpj,
        ativo: row.tenants.ativo,
        role: row.role,
      }));
  }

  const salvo = lerEmpresaAtiva();
  const activeTenantId =
    salvo && tenants.some((t) => t.id === salvo) ? salvo : tenants[0]?.id ?? null;
  return { isSuper, tenants, activeTenantId };
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { data, isLoading } = useQuery({
    queryKey: ["my-tenants"],
    queryFn: listarMinhasEmpresas,
    staleTime: 30_000,
    enabled: mounted,
    // Falha passageira de rede não pode virar "Sem empresas" até o F5.
    retry: 3,
    retryDelay: (n) => Math.min(500 * 2 ** n, 4000),
  });
  const [optimistic, setOptimistic] = useState<string | null>(null);

  const activeId = optimistic ?? data?.activeTenantId ?? null;
  const activeTenant = useMemo(
    () => data?.tenants.find((t) => t.id === activeId) ?? null,
    [data, activeId],
  );

  const setActiveTenantId = useCallback(
    async (id: string) => {
      // A lista só tem empresa que o RLS deixou ler; o RLS continua barrando
      // qualquer leitura fora dela, então isto é conveniência, não segurança.
      if (!data?.tenants.some((t) => t.id === id)) throw new Error("Sem acesso a essa empresa");
      setOptimistic(id);
      gravarEmpresaAtiva(id);
      // invalida tudo o que depende do tenant
      await qc.invalidateQueries();
    },
    [data, qc],
  );

  const value: TenantCtx = {
    isSuper: !!data?.isSuper,
    tenants: data?.tenants ?? [],
    activeTenant,
    setActiveTenantId,
    loading: isLoading,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTenant deve ser usado dentro de TenantProvider");
  return ctx;
}
