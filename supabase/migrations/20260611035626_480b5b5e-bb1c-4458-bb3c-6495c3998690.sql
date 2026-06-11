
-- =============================================================
-- ENUMS
-- =============================================================
CREATE TYPE public.app_role AS ENUM ('super_admin');
CREATE TYPE public.tenant_role AS ENUM ('admin', 'financeiro', 'suporte');

-- =============================================================
-- TENANTS
-- =============================================================
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  cnpj TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- USER_ROLES (papel global, ex.: super_admin)
-- =============================================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- TENANT_MEMBERS
-- =============================================================
CREATE TABLE public.tenant_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.tenant_role NOT NULL DEFAULT 'suporte',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_members TO authenticated;
GRANT ALL ON public.tenant_members TO service_role;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_tenant_members_user ON public.tenant_members(user_id);
CREATE INDEX idx_tenant_members_tenant ON public.tenant_members(tenant_id);

-- =============================================================
-- TENANT_OEM_SETTINGS  (uma linha por tenant)
-- Guarda apenas URLs e o NOME do secret (env var) com a chave.
-- =============================================================
CREATE TABLE public.tenant_oem_settings (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  doctoroem_url TEXT,
  doctoroem_publishable_secret_name TEXT,
  doctoroem_service_secret_name TEXT,
  tabletcloud_url TEXT,
  tabletcloud_token_secret_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_oem_settings TO authenticated;
GRANT ALL ON public.tenant_oem_settings TO service_role;
ALTER TABLE public.tenant_oem_settings ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- FUNÇÕES (security definer)
-- =============================================================
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'super_admin'::public.app_role)
$$;

CREATE OR REPLACE FUNCTION public.has_tenant_access(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.tenant_members
      WHERE user_id = _user_id AND tenant_id = _tenant_id
    )
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'super_admin'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.tenant_members
      WHERE user_id = _user_id AND tenant_id = _tenant_id AND role = 'admin'
    )
$$;

-- =============================================================
-- RLS POLICIES
-- =============================================================
-- tenants
CREATE POLICY "Membros enxergam suas empresas; super_admin vê tudo"
  ON public.tenants FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), id));

CREATE POLICY "Apenas super_admin cria empresa"
  ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY "Super_admin ou admin da empresa atualiza"
  ON public.tenants FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), id));

CREATE POLICY "Apenas super_admin deleta empresa"
  ON public.tenants FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- user_roles
CREATE POLICY "Usuário vê seus próprios papéis; super_admin vê todos"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin());

-- tenant_members
CREATE POLICY "Vê membros das empresas que tem acesso"
  ON public.tenant_members FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin adiciona membros"
  ON public.tenant_members FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin atualiza membros"
  ON public.tenant_members FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin remove membros"
  ON public.tenant_members FOR DELETE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

-- tenant_oem_settings
CREATE POLICY "Vê configurações do tenant ao qual pertence"
  ON public.tenant_oem_settings FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin gerencia configurações (insert)"
  ON public.tenant_oem_settings FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin gerencia configurações (update)"
  ON public.tenant_oem_settings FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

CREATE POLICY "Admin do tenant ou super_admin gerencia configurações (delete)"
  ON public.tenant_oem_settings FOR DELETE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

-- =============================================================
-- TRIGGER: primeiro usuário vira super_admin e ganha
-- vínculo com a empresa default "Digi Office"
-- =============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_first BOOLEAN;
  v_default_tenant UUID;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin'::public.app_role)
    INTO v_is_first;

  IF v_is_first THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin'::public.app_role);

    -- Garante o tenant default Digi Office
    SELECT id INTO v_default_tenant FROM public.tenants WHERE slug = 'digi-office';
    IF v_default_tenant IS NULL THEN
      INSERT INTO public.tenants (slug, nome) VALUES ('digi-office', 'Digi Office')
      RETURNING id INTO v_default_tenant;
      INSERT INTO public.tenant_oem_settings (
        tenant_id, doctoroem_url,
        doctoroem_publishable_secret_name, doctoroem_service_secret_name
      ) VALUES (
        v_default_tenant,
        'https://furohpfhukwajhvnnbiw.supabase.co',
        'DOCTOROEM_SUPABASE_PUBLISHABLE_KEY',
        'DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY'
      );
    END IF;

    INSERT INTO public.tenant_members (tenant_id, user_id, role)
    VALUES (v_default_tenant, NEW.id, 'admin')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================
-- updated_at triggers
-- =============================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_tenants_updated
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER trg_tenant_oem_settings_updated
  BEFORE UPDATE ON public.tenant_oem_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
