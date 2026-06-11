import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMyTenants, setActiveTenant, type AllowedTenant } from "./tenant.functions";

interface TenantCtx {
  isSuper: boolean;
  tenants: AllowedTenant[];
  activeTenant: AllowedTenant | null;
  setActiveTenantId: (id: string) => Promise<void>;
  loading: boolean;
}

const Ctx = createContext<TenantCtx | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const list = useServerFn(listMyTenants);
  const setActive = useServerFn(setActiveTenant);
  const qc = useQueryClient();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { data, isLoading } = useQuery({
    queryKey: ["my-tenants"],
    queryFn: () => list(),
    staleTime: 30_000,
    enabled: mounted,
    retry: false,
  });
  const [optimistic, setOptimistic] = useState<string | null>(null);

  const activeId = optimistic ?? data?.activeTenantId ?? null;
  const activeTenant = useMemo(
    () => data?.tenants.find((t) => t.id === activeId) ?? null,
    [data, activeId],
  );

  const setActiveTenantId = useCallback(
    async (id: string) => {
      setOptimistic(id);
      await setActive({ data: { tenantId: id } });
      // invalida tudo o que depende do tenant
      await qc.invalidateQueries();
    },
    [setActive, qc],
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