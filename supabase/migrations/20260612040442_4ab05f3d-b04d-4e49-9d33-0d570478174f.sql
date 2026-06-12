CREATE TABLE public.oem_token_cache (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  token text NOT NULL,
  expira_em timestamptz NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.oem_token_cache TO service_role;
ALTER TABLE public.oem_token_cache ENABLE ROW LEVEL SECURITY;