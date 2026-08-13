-- ============================================================================
-- Fila de carga do OEM — torna a sincronização RETOMÁVEL por lotes.
--
-- Motivo: uma carga completa faz ~2 chamadas HTTP ao OEM por cliente.
-- Com 2.272 clientes são ~4.500 chamadas numa execução só. Nenhum runtime
-- serverless aguenta isso numa requisição (Cloudflare Workers permite 50
-- subrequisições no free e 1.000 no pago). Era exatamente esse o muro em que
-- a sincronização antiga batia: morria em ~30s com 84% dos clientes marcados
-- como "falha" e ainda assim gravava o log como "sucesso".
--
-- Agora: fase 1 enumera e ENFILEIRA; fase 2 drena a fila em lotes; cada passo
-- devolve quanto falta. Um passo que morre não perde o trabalho já feito.
-- ============================================================================

begin;

-- Uma linha por execução de carga (o "run").
create table if not exists public.oem_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  log_id          uuid,                       -- linha correspondente em oem_sync_logs
  origem          text not null default 'manual',
  fase            text not null default 'listando',  -- listando|detalhando|concluido|erro
  proxima_pagina  integer not null default 1,
  grupos_lidos    integer not null default 0,
  total_registros integer,
  produtos        jsonb,                      -- catálogo codproduto<->nome, buscado 1x
  enfileirados    integer not null default 0,
  processados     integer not null default 0,
  inseridos       integer not null default 0,
  atualizados     integer not null default 0,
  falhas          integer not null default 0,
  erro            text,
  iniciado_em     timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  finalizado_em   timestamptz
);

-- Só pode existir UM run ativo por empresa — evita duas cargas concorrentes
-- brigando pela mesma fila (o botão da tela e o cron ao mesmo tempo).
create unique index if not exists oem_sync_runs_um_ativo_por_tenant
  on public.oem_sync_runs (tenant_id)
  where fase in ('listando', 'detalhando');

-- Uma linha por (empresa, filial) a buscar no OEM.
create table if not exists public.oem_sync_fila (
  id             bigserial primary key,
  run_id         uuid not null references public.oem_sync_runs(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  empresa_codigo text not null,
  filial_codigo  text not null,
  produto        text,
  numero_filiais integer,
  resumo         jsonb,          -- dados da listagem, usados se o detalhe falhar
  status         text not null default 'pendente',   -- pendente|ok|erro
  tentativas     smallint not null default 0,
  erro           text,
  criado_em      timestamptz not null default now(),
  processado_em  timestamptz,
  unique (run_id, empresa_codigo, filial_codigo)
);

create index if not exists idx_oem_sync_fila_pendente
  on public.oem_sync_fila (run_id, id) where status = 'pendente';
create index if not exists idx_oem_sync_fila_tenant
  on public.oem_sync_fila (tenant_id, status);

alter table public.oem_sync_runs enable row level security;
alter table public.oem_sync_fila enable row level security;

grant select on public.oem_sync_runs to authenticated;
grant select on public.oem_sync_fila to authenticated;
grant all    on public.oem_sync_runs to service_role;
grant all    on public.oem_sync_fila to service_role;
grant usage, select on sequence public.oem_sync_fila_id_seq to service_role;

drop policy if exists nexus_sync_runs_select on public.oem_sync_runs;
create policy nexus_sync_runs_select on public.oem_sync_runs for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));

drop policy if exists nexus_sync_fila_select on public.oem_sync_fila;
create policy nexus_sync_fila_select on public.oem_sync_fila for select to authenticated
  using (public.has_tenant_access(auth.uid(), tenant_id));

commit;
