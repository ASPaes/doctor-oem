-- ============================================================================
-- URGENTE — obter_credenciais_oem está devolvendo a senha do OEM para a chave
-- ANON, que é pública.
--
-- A migration de 15/08/2026 tirou senha e client_secret das colunas em claro e
-- pôs no Vault, com a leitura só por RPC:
--   revoke all on function public.obter_credenciais_oem(uuid) from public;
--   grant execute on function public.obter_credenciais_oem(uuid) to service_role;
--
-- O REVOKE FROM PUBLIC não desfaz o `alter default privileges ... grant all on
-- functions to anon, authenticated` que o Supabase deixa ligado no schema
-- public: PUBLIC e anon/authenticated são papéis diferentes. Resultado medido
-- chamando o PostgREST com a chave anon do .env (a mesma que vai embutida no
-- bundle do Nexus Hub e portanto é pública):
--
--   POST /rest/v1/rpc/obter_credenciais_oem  ->  200 com a senha em claro.
--
-- Ou seja, a mudança que era para PROTEGER a senha piorou o acesso: antes ela
-- estava numa coluna atrás de RLS, agora sai por uma função que qualquer um
-- chama. É o inverso do que a migration se propôs a fazer.
--
-- Depois de aplicar esta correção, TROCAR a senha no portal do OEM — ela
-- esteve publicamente legível enquanto o furo existiu.
-- ============================================================================

begin;

revoke all on function public.obter_credenciais_oem(uuid)
  from public, anon, authenticated;
grant execute on function public.obter_credenciais_oem(uuid) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA
--
--   select proname, proacl from pg_proc
--    where proname in ('obter_credenciais_oem','salvar_credenciais_oem');
--
--   obter_credenciais_oem  -> só postgres e service_role
--   salvar_credenciais_oem -> authenticated PODE (é a tela), e ela tem portão
--                             de admin por dentro (is_tenant_admin)
--
-- Prova de ponta a ponta com a chave anon:
--   curl -s -X POST ".../rest/v1/rpc/obter_credenciais_oem" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--     -H "Content-Type: application/json" -d '{"p_tenant_id":"<uuid>"}'
--   -> 42501 permission denied for function obter_credenciais_oem
-- ---------------------------------------------------------------------------
