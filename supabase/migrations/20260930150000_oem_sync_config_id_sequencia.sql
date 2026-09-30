-- oem_sync_config.id tinha padrão fixo 1 (a tabela nasceu com uma empresa só).
-- A migration 20260811230000 previa trocar por sequência, mas só quando a
-- coluna não tinha padrão nenhum — e o 1 já estava lá, então ela pulou.
-- Em 30/09/2026 a 2ª empresa (Delvale) não conseguia salvar a automação:
-- "duplicate key value violates unique constraint oem_sync_config_pkey".
-- Aplicada em produção pelo SQL Editor em 30/09/2026.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.oem_sync_config'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~* '\mid\M'
  loop
    execute format('alter table public.oem_sync_config drop constraint %I', c.conname);
  end loop;

  create sequence if not exists public.oem_sync_config_id_seq;
  alter sequence public.oem_sync_config_id_seq owned by public.oem_sync_config.id;
  perform setval('public.oem_sync_config_id_seq',
                 coalesce((select max(id) from public.oem_sync_config), 0) + 1, false);
  alter table public.oem_sync_config
    alter column id set default nextval('public.oem_sync_config_id_seq');
end $$;
