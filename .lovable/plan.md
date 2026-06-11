
## Decisão arquitetural (precisa antes do código)

Hoje os dados operacionais (`clientes_oem`, `oem_sync_config`, `oem_sync_logs`) vivem em um banco **externo** (projeto DoctorOEM, fora do Lovable Cloud). A tela /empresas já permite apontar uma URL DoctorOEM diferente por tenant, mas isso só funciona se **cada empresa tiver seu próprio projeto Supabase externo** — o que não combina com "basta preencher 4 campos e sincronizar".

Para o fluxo que você descreveu funcionar de verdade ("cadastrou empresa → preencheu user/pass/client_id/client_secret → carga inicial puxa tudo automaticamente"), os dados precisam estar **no Lovable Cloud central, com `tenant_id` em cada linha**. Esse é o modelo multi-tenant correto.

Plano abaixo assume essa migração. Se preferir manter um Supabase externo por empresa, o caminho muda bastante.

## O que será feito

### 1. Migração de schema (no Cloud central)

Criar no Cloud central as tabelas que hoje só existem no banco externo:
- `clientes_oem` — todas as colunas atuais + `tenant_id uuid not null references tenants(id)`
- `oem_sync_config` — config de automação, com `tenant_id` (singleton por tenant)
- `oem_sync_logs` — logs de execução, com `tenant_id`

Estender `tenant_oem_settings` adicionando colunas:
- `oem_api_base_url text` (default `https://api.pdvlegal.com.br`)
- `oem_api_username text`
- `oem_api_password text`
- `oem_client_id text`
- `oem_client_secret text`
- `oem_api_method text` (default `password`)

RLS em todas:
- SELECT: `has_tenant_access(auth.uid(), tenant_id)`
- INSERT/UPDATE/DELETE de clientes_oem/logs: bloqueado para usuários (só edge/server admin escreve)
- Config: `is_tenant_admin`
- Credenciais OEM em `tenant_oem_settings`: já restritas a admin do tenant + super_admin (mantém)

Índice único `(tenant_id, filial_codigo)` para o upsert da sincronização.

### 2. Refatorar o motor de sincronização

- `oem-import.server.ts` e `oem-sync.server.ts` deixam de ler `process.env.OEM_*` e passam a receber um `tenantId`, carregando as credenciais de `tenant_oem_settings` via `supabaseAdmin` central.
- Todas as queries em `clientes_oem` ganham filtro `.eq("tenant_id", tenantId)`.
- O upsert usa `onConflict: "tenant_id,filial_codigo"`.
- `doctoroem.functions.ts` (listClientes/getCliente/forceSync) lê o `active_tenant_id` do cookie e injeta o filtro de tenant + usa as credenciais do tenant ativo.
- O endpoint público `/api/public/oem-sync` (cron) passa a iterar **todos os tenants ativos com credenciais preenchidas** e roda a sincronização para cada um.

### 3. Tela /configuracoes

Mostra a config **do tenant ativo** (lido do contexto). Adicionar uma seção "Credenciais OEM" com:
- Base URL da API OEM (default preenchido)
- Username
- Password (input `type="password"`)
- Client ID
- Client Secret (input `type="password"`)
- Botão "Testar conexão" — chama uma server fn que tenta o OAuth2 e retorna sucesso/erro
- Botão "Salvar credenciais"

Os campos de intervalo/automação e a tabela de logs também passam a ser por tenant.

### 4. Tela /empresas — botão "Carga inicial"

Em cada card de empresa adicionar botão **"Carga inicial"** (visível só para super_admin), que:
- Valida que credenciais OEM estão preenchidas
- Dispara `runScheduledOemSync({ tenantId, origem: "manual" })` em background
- Mostra toast "Carga iniciada — acompanhe em Configurações"

### 5. Limpeza

- Remover referência aos env vars `OEM_*` no código (mantém os secrets no painel só como histórico — não apagar para não quebrar nada acidentalmente)
- O cliente externo `doctoroem-admin.server.ts` continua existindo só para a função de migração inicial (uma vez), depois pode ser removido em fase posterior.

## Detalhes técnicos

```text
tenant_oem_settings (ampliada)
├── tenant_id (PK)
├── oem_api_base_url
├── oem_api_username
├── oem_api_password         ← novo, texto plano no DB (protegido por RLS)
├── oem_client_id            ← novo
├── oem_client_secret        ← novo
└── oem_api_method (default 'password')

clientes_oem
├── tenant_id (FK → tenants)
├── empresa_codigo, filial_codigo
├── (todas as outras colunas atuais)
└── UNIQUE (tenant_id, filial_codigo)
```

Sobre segurança: as credenciais ficam em texto plano no banco, protegidas por RLS — só super_admin e admin do tenant conseguem ler/escrever. É o trade-off pedido ("basta preencher e sincronizar"). Se depois quiser endurecer, dá para mover para pgsodium/vault sem mudar a UI.

## Ordem de execução

1. Migração 1: criar `clientes_oem`, `oem_sync_config`, `oem_sync_logs` no Cloud central + colunas novas em `tenant_oem_settings` + RLS + GRANTs.
2. Migração 2 (opcional): copiar dados existentes do DoctorOEM externo → Cloud central, atribuindo ao tenant "digi-office".
3. Refatorar `.server.ts` e `.functions.ts` para usar tenant_id.
4. Atualizar /configuracoes (credenciais por tenant).
5. Adicionar botão "Carga inicial" em /empresas.
6. Testar fluxo: criar empresa nova → preencher credenciais → carga inicial → ver clientes isolados.
