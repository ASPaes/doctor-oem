-- ============================================================================
-- Agendamento da sincronização com o OEM — modelo DoctorOMIE.
--
-- pg_cron -> pg_net -> edge function `oem-sync-passo`, tudo dentro do Supabase.
-- Não depende de app hospedado em lugar nenhum.
--
-- COMO FUNCIONA
--   A cada 3 min o cron cutuca a função. Cada invocação processa UM passo
--   (~60 filiais, ~32s medidos) e devolve quanto falta. A fila (oem_sync_fila)
--   guarda o progresso entre uma chamada e outra, então a base inteira drena
--   em ~2h sem nenhuma execução longa e sem apanhar de 429.
--
--   O intervalo entre CARGAS continua sendo o `intervalo_horas` de
--   oem_sync_config (hoje 6h): quando não há carga em andamento e o intervalo
--   ainda não passou, a função devolve "ignorado" em milissegundos.
--
-- ANTES DE RODAR
--   Trocar <<COLE_AQUI_A_SERVICE_ROLE_KEY>> pela chave em
--   Settings -> API -> service_role. Ela vai para o Vault, não fica no cron.
-- ============================================================================

begin;

-- ---------------------------------------------------------------- extensões
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- O SQL Editor roda como `postgres`, que por padrão não enxerga cron.job
-- ("permission denied for table job"). Este é o grant padrão da Supabase.
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- ------------------------------------------------------------------- chave
-- A função exige JWT (verify_jwt = true). A chave fica no Vault, cifrada,
-- e não no comando do cron — que é legível por quem alcança cron.job.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'oem_sync_service_key') then
    perform vault.create_secret(
      '<<COLE_AQUI_A_SERVICE_ROLE_KEY>>',
      'oem_sync_service_key',
      'Usada pelo pg_cron para chamar a edge function oem-sync-passo'
    );
  end if;
end $$;

-- --------------------------------------------------------------- agendamento
-- Idempotente: remove o agendamento anterior antes de recriar.
do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname = 'oem-sync-passo' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule(
  'oem-sync-passo',
  '*/3 * * * *',
  $$
  select net.http_post(
    url     := 'https://furohpfhukwajhvnnbiw.functions.supabase.co/oem-sync-passo',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   select decrypted_secret from vault.decrypted_secrets
                    where name = 'oem_sync_service_key'
                 )
               ),
    body    := '{"origem":"cron"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

commit;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA (só leitura)
--
--   select jobid, jobname, schedule, active from cron.job;
--
--   select jobid, status, start_time from cron.job_run_details
--    order by start_time desc limit 10;
--
--   select executado_em, origem, status, total_clientes,
--          clientes_atualizados, clientes_falha, mensagem
--     from public.oem_sync_logs order by executado_em desc limit 10;
--
--   select status, count(*) from public.oem_sync_fila group by status;
--
-- DESLIGAR sem apagar:
--   update cron.job set active = false where jobname = 'oem-sync-passo';
-- ---------------------------------------------------------------------------
