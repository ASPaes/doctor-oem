-- ============================================================================
-- Corrige a criação de usuários no projeto DoctorOEM (furohpfhukwajhvnnbiw).
--
-- Sintoma: "Failed to create user: {}" no painel do Supabase.
-- Causa:   public.handle_new_user() é SECURITY DEFINER SEM `SET search_path`.
--          Quem insere em auth.users é o supabase_auth_admin, cujo search_path
--          é `auth`. O cast 'suporte'::user_role (sem o schema na frente) não
--          resolve, a função estoura e o GoTrue aborta a criação.
--          Nunca tinha aparecido porque nenhum usuário foi criado neste
--          projeto desde 09/06 — public.profiles tem 0 linhas.
--
-- Correção: fixa o search_path, qualifica o tipo, e blinda AMBOS os gatilhos
--           com EXCEPTION para que nenhum deles possa voltar a impedir a
--           criação de um usuário. Falha vira WARNING no log, não erro.
-- ============================================================================

begin;

-- ------------------------------------------------- gatilho legado (profiles)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', 'suporte'::public.user_role)
  on conflict (id) do nothing;
  return new;
exception when others then
  raise warning '[handle_new_user] ignorado para %: %', new.id, sqlerrm;
  return new;
end;
$$;

-- ------------------------------------------- gatilho novo (super_admin/empresa)
create or replace function public.nexus_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primeiro boolean;
  v_tenant   uuid;
begin
  select not exists (
    select 1 from public.user_roles where role = 'super_admin'::public.app_role
  ) into v_primeiro;

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
exception when others then
  raise warning '[nexus_handle_new_user] ignorado para %: %', new.id, sqlerrm;
  return new;
end;
$$;

commit;
