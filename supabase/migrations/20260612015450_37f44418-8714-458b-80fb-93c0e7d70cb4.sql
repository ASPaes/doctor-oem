
-- Garante RLS ativo (idempotente)
ALTER TABLE public.clientes_oem ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oem_sync_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oem_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_oem_settings ENABLE ROW LEVEL SECURITY;

-- ===== clientes_oem: escrita restrita ao admin do tenant dono =====
DROP POLICY IF EXISTS "Admin do tenant insere cliente" ON public.clientes_oem;
CREATE POLICY "Admin do tenant insere cliente" ON public.clientes_oem
  FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "Admin do tenant atualiza cliente" ON public.clientes_oem;
CREATE POLICY "Admin do tenant atualiza cliente" ON public.clientes_oem
  FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id))
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "Admin do tenant remove cliente" ON public.clientes_oem;
CREATE POLICY "Admin do tenant remove cliente" ON public.clientes_oem
  FOR DELETE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

-- ===== oem_sync_logs: admin do tenant pode inserir/atualizar/remover logs do próprio tenant =====
DROP POLICY IF EXISTS "Admin do tenant insere log" ON public.oem_sync_logs;
CREATE POLICY "Admin do tenant insere log" ON public.oem_sync_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "Admin do tenant atualiza log" ON public.oem_sync_logs;
CREATE POLICY "Admin do tenant atualiza log" ON public.oem_sync_logs
  FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id))
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "Admin do tenant remove log" ON public.oem_sync_logs;
CREATE POLICY "Admin do tenant remove log" ON public.oem_sync_logs
  FOR DELETE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

-- ===== oem_sync_config: garante DELETE restrito (insert/update já existem) =====
DROP POLICY IF EXISTS "Admin do tenant remove config" ON public.oem_sync_config;
CREATE POLICY "Admin do tenant remove config" ON public.oem_sync_config
  FOR DELETE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id));

-- GRANTs explícitos (idempotentes) — defesa em profundidade
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes_oem TO authenticated;
GRANT ALL ON public.clientes_oem TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oem_sync_config TO authenticated;
GRANT ALL ON public.oem_sync_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oem_sync_logs TO authenticated;
GRANT ALL ON public.oem_sync_logs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_oem_settings TO authenticated;
GRANT ALL ON public.tenant_oem_settings TO service_role;
