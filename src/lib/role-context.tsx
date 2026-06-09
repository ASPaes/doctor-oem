import { createContext, useContext, useState, type ReactNode } from "react";
import type { Role } from "./mock-data";

interface RoleCtx {
  role: Role;
  setRole: (r: Role) => void;
  canSeeFinance: boolean;
  canManageUsers: boolean;
  canAccessGateway: boolean;
}

const Ctx = createContext<RoleCtx | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>("admin");
  const value: RoleCtx = {
    role,
    setRole,
    canSeeFinance: role === "admin" || role === "financeiro",
    canManageUsers: role === "admin",
    canAccessGateway: role === "admin",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRole() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}

export const roleLabels: Record<Role, string> = {
  admin: "Admin",
  financeiro: "Financeiro",
  suporte: "Suporte",
};