-- ============================================================================
-- Remove o UNIQUE (cnpj_cpf) de clientes_oem.
--
-- Descoberto na primeira carga real: TODAS as falhas de gravação eram
--   duplicate key value violates unique constraint "clientes_oem_cnpj_cpf_key"
--
-- A constraint veio do scaffold original e assume "um CNPJ = um registro".
-- Isso é falso neste domínio: o OEM licencia por FILIAL, e várias filiais do
-- mesmo grupo compartilham o mesmo CNPJ. Enquanto ela existir, toda filial
-- cujo CNPJ já esteja na tabela é impossível de inserir — para sempre.
--
-- É quase certamente a causa raiz das ~840 falhas por rodada do motor antigo,
-- que nunca registrou o motivo. A listagem do OEM traz 2.564 filiais e a
-- tabela estava travada em 2.272 registros: a diferença nunca teve como entrar.
--
-- A identidade correta da linha é (tenant_id, filial_codigo), já garantida
-- pelo índice clientes_oem_tenant_filial_uidx criado na migration do dia 11.
-- Nenhum upsert do código usa cnpj_cpf como chave (conferido: só leitura).
-- ============================================================================

begin;

alter table public.clientes_oem
  drop constraint if exists clientes_oem_cnpj_cpf_key;

-- Devolve para a fila as linhas que falharam só por causa dessa constraint,
-- para serem reprocessadas na mesma carga em vez de ficarem como erro.
update public.oem_sync_fila
   set status = 'pendente', erro = null, processado_em = null
 where status = 'erro'
   and erro like '%clientes_oem_cnpj_cpf_key%';

commit;

-- Conferência (só leitura):
-- select status, count(*) from public.oem_sync_fila group by status;
