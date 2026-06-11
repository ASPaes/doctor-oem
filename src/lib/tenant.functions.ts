import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getCookie, setCookie } from "@tanstack/react-start/server";

const TENANT_COOKIE = "active_tenant_id";

export type AllowedTenant = {
  id: string;
  slug: string;
  nome: string;
  cnpj: string | null;
  ativo: boolean;
  role: "admin" | "financeiro" | "suporte" | "super_admin";
};

export const listMyTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: rolesData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const isSuper = !!rolesData?.some((r) => r.role === "super_admin");

    if (isSuper) {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, slug, nome, cnpj, ativo")
        .order("nome");
      if (error) throw new Error(error.message);
      const tenants: AllowedTenant[] = (data ?? []).map((t) => ({
        ...t,
        role: "super_admin" as const,
      }));
      const active = getCookie(TENANT_COOKIE) ?? tenants[0]?.id ?? null;
      return { isSuper, tenants, activeTenantId: active };
    }

    const { data, error } = await supabase
      .from("tenant_members")
      .select("role, tenants(id, slug, nome, cnpj, ativo)")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);

    const tenants: AllowedTenant[] = (data ?? [])
      .filter((row: any) => row.tenants)
      .map((row: any) => ({
        id: row.tenants.id,
        slug: row.tenants.slug,
        nome: row.tenants.nome,
        cnpj: row.tenants.cnpj,
        ativo: row.tenants.ativo,
        role: row.role,
      }));
    const cookieTenant = getCookie(TENANT_COOKIE);
    const active =
      cookieTenant && tenants.some((t) => t.id === cookieTenant)
        ? cookieTenant
        : tenants[0]?.id ?? null;
    return { isSuper, tenants, activeTenantId: active };
  });

export const setActiveTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: ok } = await supabase.rpc("has_tenant_access", {
      _user_id: userId,
      _tenant_id: data.tenantId,
    });
    if (!ok) throw new Error("Sem acesso a essa empresa");
    setCookie(TENANT_COOKIE, data.tenantId, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

// ----- CRUD de empresas (super_admin) -----

export const listAllTenants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("tenants")
      .select("id, slug, nome, cnpj, ativo, created_at")
      .order("nome");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        nome: z.string().min(2).max(120),
        slug: z
          .string()
          .min(2)
          .max(60)
          .regex(/^[a-z0-9-]+$/, "Use apenas letras minúsculas, números e hífen"),
        cnpj: z.string().max(20).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isSuper } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "super_admin",
    });
    if (!isSuper) throw new Error("Apenas super_admin pode criar empresa");
    const { data: row, error } = await supabase
      .from("tenants")
      .insert({ nome: data.nome, slug: data.slug, cnpj: data.cnpj ?? null })
      .select()
      .single();
    if (error) throw new Error(error.message);
    // cria settings vazias
    await supabase
      .from("tenant_oem_settings")
      .insert({ tenant_id: row.id });
    return row;
  });

export const updateTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        nome: z.string().min(2).max(120).optional(),
        cnpj: z.string().max(20).optional().nullable(),
        ativo: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { id, ...patch } = data;
    const { error } = await supabase.from("tenants").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getTenantOemSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("tenant_oem_settings")
      .select("*")
      .eq("tenant_id", data.tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const upsertTenantOemSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        doctoroem_url: z.string().url().nullable().optional(),
        doctoroem_publishable_secret_name: z.string().max(120).nullable().optional(),
        doctoroem_service_secret_name: z.string().max(120).nullable().optional(),
        tabletcloud_url: z.string().url().nullable().optional(),
        tabletcloud_token_secret_name: z.string().max(120).nullable().optional(),
        oem_api_base_url: z.string().url().nullable().optional(),
        oem_api_username: z.string().max(200).nullable().optional(),
        oem_api_password: z.string().max(200).nullable().optional(),
        oem_client_id: z.string().max(200).nullable().optional(),
        oem_client_secret: z.string().max(200).nullable().optional(),
        oem_api_method: z.string().max(40).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("tenant_oem_settings")
      .upsert(data, { onConflict: "tenant_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listTenantMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ tenantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("tenant_members")
      .select("id, user_id, role, created_at")
      .eq("tenant_id", data.tenantId);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });