
-- =========================================================
-- 1) Estende tenant_oem_settings com credenciais da API OEM
-- =========================================================
ALTER TABLE public.tenant_oem_settings
  ADD COLUMN IF NOT EXISTS oem_api_base_url text DEFAULT 'https://api.pdvlegal.com.br',
  ADD COLUMN IF NOT EXISTS oem_api_username text,
  ADD COLUMN IF NOT EXISTS oem_api_password text,
  ADD COLUMN IF NOT EXISTS oem_client_id text,
  ADD COLUMN IF NOT EXISTS oem_client_secret text,
  ADD COLUMN IF NOT EXISTS oem_api_method text DEFAULT 'password';

-- =========================================================
-- 2) clientes_oem no Cloud central, isolado por tenant
-- =========================================================
CREATE TABLE IF NOT EXISTS public.clientes_oem (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  empresa_codigo text,
  filial_codigo text,
  razao_social text,
  nome_fantasia text NOT NULL,
  grupo_economico text,
  cnpj_cpf text NOT NULL DEFAULT '',
  produto_principal text,
  numero_filiais integer,
  status text,
  bloqueado boolean DEFAULT false,
  usuarios_adicionais integer,
  qtd_pdv_comandas integer,
  qtd_pdv integer,
  qtd_comandas integer,
  motivo_bloqueio text,
  custo_total numeric,
  modulos_ativos jsonb,
  licencas_detalhe jsonb,
  last_sync timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clientes_oem_tenant_filial_unique UNIQUE (tenant_id, filial_codigo)
);
GRANT SELECT ON public.clientes_oem TO authenticated;
GRANT ALL ON public.clientes_oem TO service_role;
ALTER TABLE public.clientes_oem ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Vê clientes da empresa que tem acesso"
  ON public.clientes_oem FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), tenant_id));

CREATE INDEX IF NOT EXISTS idx_clientes_oem_tenant ON public.clientes_oem(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clientes_oem_nome ON public.clientes_oem(tenant_id, nome_fantasia);

DROP TRIGGER IF EXISTS trg_clientes_oem_updated ON public.clientes_oem;
CREATE TRIGGER trg_clientes_oem_updated
  BEFORE UPDATE ON public.clientes_oem
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- 3) oem_sync_config — singleton por tenant
-- =========================================================
CREATE TABLE IF NOT EXISTS public.oem_sync_config (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  intervalo_horas integer NOT NULL DEFAULT 24,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.oem_sync_config TO authenticated;
GRANT ALL ON public.oem_sync_config TO service_role;
ALTER TABLE public.oem_sync_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vê config de sync do tenant"
  ON public.oem_sync_config FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), tenant_id));
CREATE POLICY "Admin do tenant insere config"
  ON public.oem_sync_config FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));
CREATE POLICY "Admin do tenant atualiza config"
  ON public.oem_sync_config FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

DROP TRIGGER IF EXISTS trg_oem_sync_config_updated ON public.oem_sync_config;
CREATE TRIGGER trg_oem_sync_config_updated
  BEFORE UPDATE ON public.oem_sync_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- 4) oem_sync_logs por tenant
-- =========================================================
CREATE TABLE IF NOT EXISTS public.oem_sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  origem text NOT NULL,
  status text NOT NULL,
  clientes_atualizados integer NOT NULL DEFAULT 0,
  clientes_falha integer NOT NULL DEFAULT 0,
  total_clientes integer NOT NULL DEFAULT 0,
  duracao_ms integer,
  mensagem text,
  executado_em timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.oem_sync_logs TO authenticated;
GRANT ALL ON public.oem_sync_logs TO service_role;
ALTER TABLE public.oem_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vê logs do tenant"
  ON public.oem_sync_logs FOR SELECT TO authenticated
  USING (public.has_tenant_access(auth.uid(), tenant_id));

CREATE INDEX IF NOT EXISTS idx_oem_sync_logs_tenant_time
  ON public.oem_sync_logs(tenant_id, executado_em DESC);
