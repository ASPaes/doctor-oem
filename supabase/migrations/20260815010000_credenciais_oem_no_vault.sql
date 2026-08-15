-- ============================================================================
-- Credenciais da API OEM saem de texto puro e vão para o Vault
--
-- tenant_oem_settings guardava oem_api_password e oem_client_secret em colunas
-- comuns. Qualquer admin da empresa com acesso à tabela lia a senha do OEM em
-- claro — e um SELECT distraído num suporte a colocaria num log.
--
-- O que é SEGREDO vai para o cofre; o que é IDENTIFICADOR fica na tabela:
--
--   ficam    oem_api_base_url · oem_api_method · oem_api_username · oem_client_id
--   ao cofre oem_api_password · oem_client_secret
--
-- username e client_id não são segredo — o client_id aparece na própria tela de
-- configuração. Deixá-los na tabela mantém o formulário preenchível sem que a
-- tela precise abrir o cofre para desenhar.
--
-- Mesmo desenho que já usamos no DoctorSaaS para a chave de integração:
-- grava por RPC com portão de admin, lê por RPC só para service_role.
-- ============================================================================

begin;

create extension if not exists supabase_vault with schema vault;

alter table public.tenant_oem_settings
  add column if not exists vault_secret_id uuid;

-- ------------------------------------------------- migra o que já existe
do $$
declare r record; v_sid uuid; v_nome text;
begin
  for r in
    select tenant_id, oem_api_password, oem_client_secret
      from public.tenant_oem_settings
     where vault_secret_id is null
       and (coalesce(oem_api_password,'') <> '' or coalesce(oem_client_secret,'') <> '')
  loop
    v_nome := 'oem_credenciais_' || r.tenant_id::text;
    v_sid := vault.create_secret(
      json_build_object(
        'password', coalesce(r.oem_api_password, ''),
        'client_secret', coalesce(r.oem_client_secret, '')
      )::text,
      v_nome,
      'Senha e client_secret da API OEM'
    );
    update public.tenant_oem_settings set vault_secret_id = v_sid where tenant_id = r.tenant_id;
  end loop;
end $$;

-- Só agora as colunas em claro somem — depois do conteúdo estar no cofre.
alter table public.tenant_oem_settings drop column if exists oem_api_password;
alter table public.tenant_oem_settings drop column if exists oem_client_secret;

-- --------------------------------------------------------------- leitura
-- Devolve TUDO, inclusive os segredos. Só service_role executa: é o motor da
-- sincronização e o caminho de escrita no OEM que precisam disso.
create or replace function public.obter_credenciais_oem(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_row record; v_sec text; v_json jsonb;
begin
  select oem_api_base_url, oem_api_method, oem_api_username, oem_client_id, vault_secret_id
    into v_row
    from public.tenant_oem_settings
   where tenant_id = p_tenant_id;
  if not found then return null; end if;

  if v_row.vault_secret_id is not null then
    select decrypted_secret into v_sec from vault.decrypted_secrets where id = v_row.vault_secret_id;
  end if;
  v_json := coalesce(v_sec::jsonb, '{}'::jsonb);

  return jsonb_build_object(
    'base_url',      coalesce(v_row.oem_api_base_url, 'https://api.pdvlegal.com.br'),
    'method',        coalesce(v_row.oem_api_method, 'password'),
    'username',      v_row.oem_api_username,
    'client_id',     v_row.oem_client_id,
    'password',      v_json->>'password',
    'client_secret', v_json->>'client_secret'
  );
end $$;

revoke all on function public.obter_credenciais_oem(uuid) from public;
grant execute on function public.obter_credenciais_oem(uuid) to service_role;

-- --------------------------------------------------------------- escrita
-- Senha e secret em branco significam "não mexer" — assim a tela pode salvar
-- só a URL ou só o usuário sem obrigar a redigitar o que ela nem consegue ler.
create or replace function public.salvar_credenciais_oem(
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
declare v_sid uuid; v_atual jsonb; v_sec text; v_nome text;
begin
  if not public.is_tenant_admin(auth.uid(), p_tenant_id) then
    raise exception 'Apenas administradores podem alterar as credenciais do OEM.';
  end if;

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
    return;  -- nada de segredo mudou
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
    v_nome := 'oem_credenciais_' || p_tenant_id::text;
    v_sid := vault.create_secret(v_sec, v_nome, 'Senha e client_secret da API OEM');
    update public.tenant_oem_settings set vault_secret_id = v_sid where tenant_id = p_tenant_id;
  else
    perform vault.update_secret(v_sid, v_sec);
  end if;
end $$;

revoke all on function public.salvar_credenciais_oem(uuid, text, text, text, text, text, text) from public;
grant execute on function public.salvar_credenciais_oem(uuid, text, text, text, text, text, text)
  to authenticated, service_role;

commit;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA (só leitura)
--   select tenant_id, oem_api_username, oem_client_id,
--          vault_secret_id is not null as tem_segredo
--     from public.tenant_oem_settings;
--
--   -- as colunas em claro têm que ter sumido:
--   select column_name from information_schema.columns
--    where table_name = 'tenant_oem_settings'
--      and column_name in ('oem_api_password','oem_client_secret');
-- ---------------------------------------------------------------------------
