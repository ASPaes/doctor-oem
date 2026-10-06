-- ============================================================================
-- Provisionamento pelo DoctorSaaS (DEM-0516)
--
-- Até aqui ligar uma empresa nova era trabalho em dois sistemas: criar a
-- empresa aqui, digitar as credenciais do PDV Legal, gerar a chave de
-- integração e colar no DoctorSaaS. A DEM-0516 leva tudo para o DoctorSaaS:
-- a pessoa preenche as credenciais lá e a edge function `oem-provisionar`
-- faz os três passos daqui de uma vez.
--
-- O problema de bootstrap: toda porta deste projeto se autentica pela chave
-- oem_live_, e a chave só existe DEPOIS da empresa. Para criar a empresa é
-- preciso outra credencial — um segredo de PLATAFORMA, compartilhado só entre
-- as edge functions dos dois projetos. Ele mora no Vault e é comparado AQUI
-- DENTRO (fn_provisionamento_segredo_ok): o valor nunca sai do banco.
--
-- QUEM É A EMPRESA: o par (tenant do DoctorSaaS, unidade base). NUNCA o CNPJ.
-- Casar por CNPJ deixaria qualquer admin do DoctorSaaS digitar o CNPJ de outra
-- empresa e receber uma chave que lê as filiais dela. Empresa criada à mão
-- aqui (Digi, Delvale) entra no de-para por ADOÇÃO: o DoctorSaaS apresenta a
-- chave colada junto com o segredo, e ter a chave prova que a empresa é dele.
-- ============================================================================

begin;

-- ------------------------------------------------------------- o de-para
create table if not exists public.oem_provisionamento (
  id                uuid primary key default gen_random_uuid(),
  origem            text not null default 'doctorsaas',
  origem_tenant_id  uuid not null,     -- tenants.id NO DoctorSaaS
  origem_unidade_id bigint not null,   -- unidades_base.id NO DoctorSaaS
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  chave_id          uuid references public.oem_api_chaves(id) on delete set null,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  unique (origem, origem_tenant_id, origem_unidade_id)
);

alter table public.oem_provisionamento enable row level security;
-- Sem policy: só a edge function (service_role) lê e escreve.
revoke all on public.oem_provisionamento from public, anon, authenticated;
grant all on public.oem_provisionamento to service_role;

-- ---------------------------------------------- portão do segredo de plataforma
-- Devolve false (nunca NULL) quando o segredo não está cadastrado: um cofre
-- vazio não pode abrir a porta.
create or replace function public.fn_provisionamento_segredo_ok(p_segredo text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare v_sec text;
begin
  if coalesce(p_segredo, '') = '' then return false; end if;
  select decrypted_secret into v_sec
    from vault.decrypted_secrets
   where name = 'doctorsaas_provisionamento_secret';
  return coalesce(v_sec <> '' and v_sec = p_segredo, false);
end $$;

-- REVOKE FROM PUBLIC sozinho não basta: o default privileges do Supabase dá
-- EXECUTE direto para anon/authenticated (ver 20260815140000).
revoke all on function public.fn_provisionamento_segredo_ok(text) from public, anon, authenticated;
grant execute on function public.fn_provisionamento_segredo_ok(text) to service_role;

-- ------------------------------------------ gravação das credenciais sem pessoa
-- Mesmo corpo de salvar_credenciais_oem, sem o portão is_tenant_admin(auth.uid()):
-- chamada por service_role o auth.uid() é NULL e o portão recusaria sempre.
-- Cópia em vez de refatorar a original de propósito: a da tela fica intocada.
-- Quem chama já autenticou (segredo de plataforma ou chave da empresa).
create or replace function public.salvar_credenciais_oem_servico(
  p_tenant_id     uuid,
  p_base_url      text default null,
  p_username      text default null,
  p_client_id     text default null,
  p_password      text default null,
  p_client_secret text default null,
  p_method        text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_sid uuid; v_atual jsonb; v_sec text;
begin
  insert into public.tenant_oem_settings (tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;

  update public.tenant_oem_settings
     set oem_api_base_url = coalesce(nullif(trim(p_base_url), ''), oem_api_base_url),
         oem_api_username = coalesce(nullif(trim(p_username), ''), oem_api_username),
         oem_client_id    = coalesce(nullif(trim(p_client_id), ''), oem_client_id),
         oem_api_method   = coalesce(nullif(trim(p_method), ''), oem_api_method),
         updated_at       = now()
   where tenant_id = p_tenant_id
  returning vault_secret_id into v_sid;

  if coalesce(p_password,'') = '' and coalesce(p_client_secret,'') = '' then
    return;
  end if;

  if v_sid is not null then
    select decrypted_secret into v_sec from vault.decrypted_secrets where id = v_sid;
  end if;
  v_atual := coalesce(v_sec::jsonb, '{}'::jsonb);

  v_sec := jsonb_build_object(
    'password',      coalesce(nullif(p_password, ''),      v_atual->>'password',      ''),
    'client_secret', coalesce(nullif(p_client_secret, ''), v_atual->>'client_secret', '')
  )::text;

  if v_sid is null then
    v_sid := vault.create_secret(v_sec, 'oem_credenciais_' || p_tenant_id::text,
                                 'Senha e client_secret da API OEM');
    update public.tenant_oem_settings set vault_secret_id = v_sid where tenant_id = p_tenant_id;
  else
    perform vault.update_secret(v_sid, v_sec);
  end if;
end $$;

revoke all on function public.salvar_credenciais_oem_servico(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.salvar_credenciais_oem_servico(uuid, text, text, text, text, text, text)
  to service_role;

commit;

-- ---------------------------------------------------------------------------
-- DEPOIS DE APLICAR: cadastrar o segredo de plataforma (o MESMO valor vai no
-- Vault do DoctorSaaS, com o nome oem_provisionamento_secret):
--
--   select vault.create_secret('<48+ caracteres aleatórios>',
--          'doctorsaas_provisionamento_secret',
--          'Segredo DoctorSaaS -> oem-provisionar (DEM-0516)');
--
-- CONFERÊNCIA (só leitura) — as duas funções só podem ter postgres e service_role:
--   select proname, proacl from pg_proc
--    where proname in ('fn_provisionamento_segredo_ok','salvar_credenciais_oem_servico');
-- ---------------------------------------------------------------------------
