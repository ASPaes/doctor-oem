-- ============================================================================
-- Nexus Hub / DoctorOEM — habilita o modelo multi-empresa no Supabase da ASP
--
-- PROJETO ALVO: furohpfhukwajhvnnbiw  (Supabase da ASP, org DoctorSaaS)
-- NÃO rodar no projeto do Lovable Cloud.
--
-- Regras deste script:
--   * Só ADITIVO — não apaga tabela, coluna nem linha. Os 2.272 clientes ficam.
--   * Idempotente — pode rodar duas vezes sem estragar nada.
--   * Não toca no OEM (api.pdvlegal.com.br). É só banco.
--   * Nomes com prefixo "nexus_" nas funções genéricas, para não sobrescrever
--     nada que já exista neste projeto (ex.: um handle_new_user de profiles).
-- ============================================================================

begin;

-- ---------------------------------------------------------------- 1) ENUMS
do $$ begin
  create type public.app_role as enum ('super_admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.tenant_role as enum ('admin', 'financeiro', 'suporte');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------- 2) TABELAS NOVAS (empresas)
create table if not exists public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  nome       text not null,
  cnpj       text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create table if not exists public.tenant_members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.tenant_role not null default 'suporte',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists idx_tenant_members_user   on public.tenant_members(user_id);
create index if not exists idx_tenant_members_tenant on public.tenant_members(tenant_id);

-- Credenciais da API OEM por empresa (é o que a tela Configurações grava).
create table if not exists public.tenant_oem_settings (
  tenant_id         uuid primary key references public.tenants(id) on delete cascade,
  oem_api_base_url  text default 'https://api.pdvlegal.com.br',
  oem_api_username  text,
  oem_api_password  text,
  oem_client_id     text,
  oem_client_secret text,
  oem_api_method    text default 'password',
  updated_at        timestamptz not null default now()
);

-- Cache do token OAuth2 do OEM (evita o HTTP 429 do endpoint /token).
create table if not exists public.oem_token_cache (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  token         text,
  expira_em     timestamptz,
  cooldown_ate  timestamptz,
  atualizado_em timestamptz not null default now()
);

-- ------------------------------------------ 3) EMPRESA PADRÃO + tenant_id
-- A base atual (2.272 clientes) é toda de uma empresa só: Digi Office.
insert into public.tenants (slug, nome)
select 'digi-office', 'Digi Office'
where not exists (select 1 from public.tenants where slug = 'digi-office');

insert into public.tenant_oem_settings (tenant_id)
select id from public.tenants where slug = 'digi-office'
on conflict (tenant_id) do nothing;

alter table public.clientes_oem    add column if not exists tenant_id uuid;
alter table public.oem_sync_logs   add column if not exists tenant_id uuid;
alter table public.oem_sync_config add column if not exists tenant_id uuid;

update public.clientes_oem
   set tenant_id = (select id from public.tenants where slug = 'digi-office')
 where tenant_id is null;
update public.oem_sync_logs
   set tenant_id = (select id from public.tenants where slug = 'digi-office')
 where tenant_id is null;
update public.oem_sync_config
   set tenant_id = (select id from public.tenants where slug = 'digi-office')
 where tenant_id is null;

alter table public.clientes_oem    alter column tenant_id set not null;
alter table public.oem_sync_logs   alter column tenant_id set not null;
alter table public.oem_sync_config alter column tenant_id set not null;

do $$ begin
  alter table public.clientes_oem add constraint clientes_oem_tenant_fk
    foreign key (tenant_id) references public.tenants(id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.oem_sync_logs add constraint oem_sync_logs_tenant_fk
    foreign key (tenant_id) references public.tenants(id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.oem_sync_config add constraint oem_sync_config_tenant_fk
    foreign key (tenant_id) references public.tenants(id) on delete cascade;
exception when duplicate_object then null; end $$;

-- Chaves que o app usa nos upserts (onConflict). Sem elas o upsert falha.
-- Conferido nos dados reais: os 2.272 filial_codigo são únicos — o índice sobe.
create unique index if not exists clientes_oem_tenant_filial_uidx
  on public.clientes_oem (tenant_id, filial_codigo);
create unique index if not exists oem_sync_config_tenant_uidx
  on public.oem_sync_config (tenant_id);
create index if not exists idx_clientes_oem_tenant
  on public.clientes_oem (tenant_id);
create index if not exists idx_clientes_oem_tenant_nome
  on public.clientes_oem (tenant_id, nome_fantasia);
create index if not exists idx_oem_sync_logs_tenant_data
  on public.oem_sync_logs (tenant_id, executado_em desc);

-- oem_sync_config.id é integer e o app insere sem informar id.
-- Se a coluna não tiver default, o insert quebra. Garante a sequência.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'oem_sync_config'
       and column_name = 'id' and column_default is not null
  ) then
    create sequence if not exists public.oem_sync_config_id_seq
      owned by public.oem_sync_config.id;
    perform setval('public.oem_sync_config_id_seq',
                   coalesce((select max(id) from public.oem_sync_config), 0) + 1, false);
    alter table public.oem_sync_config
      alter column id set default nextval('public.oem_sync_config_id_seq');
  end if;
end $$;

-- Carimbos de auditoria que o projeto da ASP não tem.
alter table public.clientes_oem add column if not exists created_at timestamptz not null default now();
alter table public.clientes_oem add column if not exists updated_at timestamptz not null default now();

-- ------------------------------------------------------------ 4) FUNÇÕES
-- Os nomes abaixo são chamados por RPC pelo app — não renomear.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(auth.uid(), 'super_admin'::public.app_role)
$$;

create or replace function public.has_tenant_access(_user_id uuid, _tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(_user_id, 'super_admin'::public.app_role)
      or exists (select 1 from public.tenant_members
                  where user_id = _user_id and tenant_id = _tenant_id)
$$;

create or replace function public.is_tenant_admin(_user_id uuid, _tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(_user_id, 'super_admin'::public.app_role)
      or exists (select 1 from public.tenant_members
                  where user_id = _user_id and tenant_id = _tenant_id and role = 'admin')
$$;

revoke all on function public.has_role(uuid, public.app_role)          from public;
revoke all on function public.is_super_admin()                         from public;
revoke all on function public.has_tenant_access(uuid, uuid)            from public;
revoke all on function public.is_tenant_admin(uuid, uuid)              from public;
grant execute on function public.has_role(uuid, public.app_role)       to authenticated, service_role;
grant execute on function public.is_super_admin()                      to authenticated, service_role;
grant execute on function public.has_tenant_access(uuid, uuid)         to authenticated, service_role;
grant execute on function public.is_tenant_admin(uuid, uuid)           to authenticated, service_role;

-- updated_at automático (prefixo nexus_ para não colidir com função existente)
create or replace function public.nexus_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.nexus_touch_updated_at();

drop trigger if exists trg_tenant_oem_settings_updated on public.tenant_oem_settings;
create trigger trg_tenant_oem_settings_updated before update on public.tenant_oem_settings
  for each row execute function public.nexus_touch_updated_at();

drop trigger if exists trg_clientes_oem_updated on public.clientes_oem;
create trigger trg_clientes_oem_updated before update on public.clientes_oem
  for each row execute function public.nexus_touch_updated_at();

-- Primeiro usuário criado vira super_admin e entra na Digi Office como admin.
-- É assim que o acesso nasce no projeto novo, sem precisar de SQL manual.
create or replace function public.nexus_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_primeiro boolean;
  v_tenant   uuid;
begin
  select not exists (select 1 from public.user_roles
                      where role = 'super_admin'::public.app_role)
    into v_primeiro;

  if v_primeiro then
    insert into public.user_roles (user_id, role)
    values (new.id, 'super_admin'::public.app_role)
    on conflict do nothing;

    select id into v_tenant from public.tenants where slug = 'digi-office';
    if v_tenant is not null then
      insert into public.tenant_members (tenant_id, user_id, role)
      values (v_tenant, new.id, 'admin')
      on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_nexus on auth.users;
create trigger on_auth_user_created_nexus
  after insert on auth.users
  for each row execute function public.nexus_handle_new_user();

-- --------------------------------------------------------- 5) RLS + GRANTS
alter table public.tenants             enable row level security;
alter table public.user_roles          enable row level security;
alter table public.tenant_members      enable row level security;
alter table public.tenant_oem_settings enable row level security;
alter table public.oem_token_cache     enable row level security;
alter table public.clientes_oem        enable row level security;
alter table public.oem_sync_logs       enable row level security;
alter table public.oem_sync_config     enable row level security;

grant select, insert, update, delete on public.tenants             to authenticated;
grant select                         on public.user_roles          to authenticated;
grant select, insert, update, delete on public.tenant_members      to authenticated;
grant select, insert, update, delete on public.tenant_oem_settings to authenticated;
grant select                         on public.clientes_oem        to authenticated;
grant select                         on public.oem_sync_logs       to authenticated;
grant select, insert, update         on public.oem_sync_config     to authenticated;
grant all on public.tenants, public.user_roles, public.tenant_members,
             public.tenant_oem_settings, public.oem_token_cache,
             public.clientes_oem, public.oem_sync_logs, public.oem_sync_config
          to service_role;

-- oem_token_cache guarda token de acesso: só o servidor (service_role) enxerga.
-- Sem policy para authenticated = ninguém logado lê. É proposital.

drop policy if exists nexus_tenants_select on public.tenants;
create policy nexus_tenants_select on public.tenants for select to authenticated
  using (public.has_tenant_access(auth.uid(), id));
drop policy if exists nexus_tenants_insert on public.tenants;
create policy nexus_tenants_insert on public.tenants for insert to authenticated
  with check (public.is_super_admin());
drop policy if exists nexus_tenants_update on public.tenants;
create policy nexus_tenants_update on public.tenants for update to authenticated
  using (public.is_tenant_admin(auth.uid(), id));
drop policy if exists nexus_tenants_delete on public.tenants;
create policy nexus_tenants_delete on public.tenants for delete to authenticated
  using (public.is_super_admin());

drop policy if exists nexus_user_roles_select on public.user_roles;
create policy nexus_user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists nexus_members_select on public.tenant_members;
create policy nexus_members_select on public.tenant_members for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));
drop policy if exists nexus_members_insert on public.tenant_members;
create policy nexus_members_insert on public.tenant_members for insert to authenticated
  with check (public.is_tenant_admin(auth.uid(), tenant_id));
drop policy if exists nexus_members_update on public.tenant_members;
create policy nexus_members_update on public.tenant_members for update to authenticated
  using (public.is_tenant_admin(auth.uid(), tenant_id));
drop policy if exists nexus_members_delete on public.tenant_members;
create policy nexus_members_delete on public.tenant_members for delete to authenticated
  using (public.is_tenant_admin(auth.uid(), tenant_id));

drop policy if exists nexus_settings_select on public.tenant_oem_settings;
create policy nexus_settings_select on public.tenant_oem_settings for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));
drop policy if exists nexus_settings_insert on public.tenant_oem_settings;
create policy nexus_settings_insert on public.tenant_oem_settings for insert to authenticated
  with check (public.is_tenant_admin(auth.uid(), tenant_id));
drop policy if exists nexus_settings_update on public.tenant_oem_settings;
create policy nexus_settings_update on public.tenant_oem_settings for update to authenticated
  using (public.is_tenant_admin(auth.uid(), tenant_id));

drop policy if exists nexus_clientes_select on public.clientes_oem;
create policy nexus_clientes_select on public.clientes_oem for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));

drop policy if exists nexus_sync_logs_select on public.oem_sync_logs;
create policy nexus_sync_logs_select on public.oem_sync_logs for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));

drop policy if exists nexus_sync_config_select on public.oem_sync_config;
create policy nexus_sync_config_select on public.oem_sync_config for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));
drop policy if exists nexus_sync_config_write on public.oem_sync_config;
create policy nexus_sync_config_write on public.oem_sync_config for insert to authenticated
  with check (public.is_tenant_admin(auth.uid(), tenant_id));
drop policy if exists nexus_sync_config_update on public.oem_sync_config;
create policy nexus_sync_config_update on public.oem_sync_config for update to authenticated
  using (public.is_tenant_admin(auth.uid(), tenant_id));

commit;

-- ============================================================================
-- CONFERÊNCIA (rode depois; só leitura)
--
-- select
--   (select count(*) from public.tenants)                                as empresas,
--   (select count(*) from public.clientes_oem where tenant_id is null)   as clientes_sem_empresa,
--   (select count(*) from public.clientes_oem)                           as clientes,
--   to_regclass('public.oem_token_cache')                                as token_cache_ok,
--   to_regprocedure('public.has_tenant_access(uuid,uuid)')               as funcao_ok;
--
-- Esperado: empresas = 1, clientes_sem_empresa = 0, clientes = 2272,
--           as duas últimas colunas preenchidas.
-- ============================================================================
