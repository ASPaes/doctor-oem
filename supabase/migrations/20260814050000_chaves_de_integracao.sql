-- ============================================================================
-- Chaves de integração do DoctorOEM — como o DoctorSaaS se conecta a uma empresa
--
-- O vínculo entre "tenant Digi Office no DoctorSaaS" e "tenant Digi Office no
-- DoctorOEM" estava chumbado numa variável de ambiente (OEM_MAPA_TENANTS), com
-- os dois UUIDs escritos à mão. Funcionava para uma empresa e não escalava:
-- cada empresa nova exigiria editar um segredo em produção.
--
-- Agora a CHAVE carrega o tenant. Gera-se no DoctorOEM, cola-se no DoctorSaaS,
-- e quem apresenta a chave só enxerga as filiais da empresa dona dela.
--
-- Guardamos apenas o SHA-256. A chave em claro aparece uma única vez, na hora
-- da geração — igual ao que a tela de Gateway já faz com os tokens de parceiro.
-- `prefixo` existe só para a pessoa reconhecer qual chave é qual na lista.
--
-- NÃO reaproveitamos `developer_gateways`: aquela tabela liga token a uma
-- FILIAL (client_id -> clientes_oem) para webhook de parceiro, e não tem
-- tenant_id. Escopo diferente.
-- ============================================================================

begin;

create table if not exists public.oem_api_chaves (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  nome          text not null,                 -- "DoctorSaaS produção", etc.
  token_hash    text not null unique,          -- sha256 hex da chave em claro
  prefixo       text not null,                 -- primeiros caracteres, para exibir
  ativa         boolean not null default true,
  criada_em     timestamptz not null default now(),
  criada_por    uuid,
  ultimo_uso_em timestamptz,
  revogada_em   timestamptz
);

create index if not exists idx_oem_chaves_tenant on public.oem_api_chaves (tenant_id, ativa);

alter table public.oem_api_chaves enable row level security;
grant select, insert, update on public.oem_api_chaves to authenticated;
grant all on public.oem_api_chaves to service_role;

-- Quem enxerga/gerencia chave é admin da empresa. E NUNCA se lê o hash pela
-- API do navegador: a policy libera a linha, mas a tela seleciona só as
-- colunas de exibição (nome, prefixo, datas).
drop policy if exists oem_chaves_select on public.oem_api_chaves;
create policy oem_chaves_select on public.oem_api_chaves for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));

drop policy if exists oem_chaves_insert on public.oem_api_chaves;
create policy oem_chaves_insert on public.oem_api_chaves for insert to authenticated
  with check (public.is_tenant_admin(auth.uid(), tenant_id));

drop policy if exists oem_chaves_update on public.oem_api_chaves;
create policy oem_chaves_update on public.oem_api_chaves for update to authenticated
  using (public.is_tenant_admin(auth.uid(), tenant_id));

commit;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA (só leitura)
--   select id, nome, prefixo, ativa, criada_em, ultimo_uso_em
--     from public.oem_api_chaves order by criada_em desc;
-- ---------------------------------------------------------------------------
