## Objetivo

Transformar o Nexus Hub em multi-tenant: cada empresa (tenant) é 100% isolada. Você (super-admin) alterna entre empresas via um seletor no topo; usuários comuns enxergam apenas a sua empresa. Hoje tudo aponta para o DoctorOEM da Digi Office — vamos centralizar no Lovable Cloud e tratar a Digi Office como o primeiro tenant.

## Arquitetura

```text
Lovable Cloud (Supabase central)
├── auth.users                       (login email/senha)
├── tenants                          (empresas cadastradas)
├── tenant_members (user_id, tenant_id, role)
├── user_roles (user_id, role: super_admin)
├── tenant_oem_settings (URL/keys do DoctorOEM por tenant)
├── tenant_clientes / tenant_sync_logs / ...  (dados operacionais)
└── RLS: tudo filtrado por tenant_id via has_tenant_access()
```

Super-admin (você) bypassa o filtro de tenant_id; usuários normais só veem o tenant_id ao qual pertencem.

## Etapas

### 1. Habilitar Lovable Cloud + auth
- Habilitar Cloud, criar página `/auth` (email/senha), proteger rotas com `_authenticated/route.tsx` gerenciado.
- Criar enum `app_role` (`super_admin`, `admin`, `member`) e tabela `user_roles` + função `has_role()` (security definer).

### 2. Schema multi-tenant
- `tenants`: id, nome, slug, cnpj, ativo, created_at.
- `tenant_members`: user_id, tenant_id, role no tenant (admin/financeiro/suporte) — substitui o `role-context` atual.
- `tenant_oem_settings`: tenant_id, doctoroem_url, doctoroem_publishable_key, doctoroem_service_key (criptografado / referenciado por segredo), tabletcloud_url, tabletcloud_token.
- Função `has_tenant_access(_user, _tenant)` security definer.
- RLS em todas as tabelas: `super_admin` vê tudo, demais só seu tenant.
- Seed: criar tenant "Digi Office" com as credenciais atuais (`DOCTOROEM_*`).

### 3. Migrar tabelas operacionais para o Cloud
- Replicar as tabelas hoje existentes no DoctorOEM (clientes, módulos, licenças, sync_logs, etc.) no Cloud com coluna `tenant_id NOT NULL`.
- Reescrever `src/lib/doctoroem.functions.ts` e `oem-sync.*` para:
  - Receber `tenant_id` do contexto (server-fn middleware).
  - Buscar credenciais OEM em `tenant_oem_settings` daquele tenant.
  - Gravar resultado em tabelas do Cloud com `tenant_id`.

### 4. Contexto de tenant no app
- `tenant-context.tsx`: provider + hook `useTenant()` (substitui parcialmente o role-context).
- `TenantSwitcher` no header (ao lado do RoleSwitcher) — lista tenants visíveis ao usuário (todos se super_admin).
- Persistir tenant ativo em cookie httpOnly server-side (ou localStorage + validação server-side a cada chamada).
- Middleware `requireTenant` em todas as server fns: lê cookie, valida `has_tenant_access`, injeta `tenantId` no context.

### 5. Telas
- Nova rota `/empresas` (só super_admin): CRUD de tenants + edição das credenciais OEM/TabletCloud por empresa.
- `/configuracoes`: passa a editar apenas configs do tenant ativo.
- `/usuarios`: gerencia membros do tenant ativo (super_admin pode convidar/remover; admin do tenant idem dentro do seu).
- Todas as outras telas (clientes, gateway, overview) continuam iguais visualmente, mas todas as queries passam pelo tenant ativo automaticamente.

### 6. Sign-in / sign-up
- `/auth`: email + senha. Primeiro usuário cadastrado é promovido a `super_admin` (você).
- Convite de membros via super_admin/admin do tenant (cria conta e vincula em `tenant_members`).

## Pontos técnicos sensíveis

- **Service role do DoctorOEM por tenant**: o ideal é guardar em `secrets` do Cloud (um por tenant, ex.: `OEM_SERVICE_KEY_<tenant_slug>`) e a tabela `tenant_oem_settings` referencia o nome do segredo. Isso evita armazenar chave em texto plano no banco.
- **RLS em tudo**: cada tabela operacional ganha policy `tenant_id IN (SELECT tenant_id FROM tenant_members WHERE user_id = auth.uid()) OR has_role(auth.uid(),'super_admin')`.
- **Cookie de tenant ativo**: validar server-side a cada server-fn — nunca confiar no client.
- **Migração da Digi Office**: na mesma migration, inserir tenant + settings apontando para as env vars atuais (`DOCTOROEM_SUPABASE_*`), e fazer um sync inicial para popular as tabelas do Cloud.

## Decisões que preciso confirmar antes de começar

1. **Primeiro usuário super-admin**: posso usar o email que você usar no primeiro signup, ou prefere que eu deixe um seed com email específico (qual)?
2. **Dados atuais do DoctorOEM (Digi Office)**: posso migrar tudo para tabelas no Lovable Cloud (com `tenant_id`) e passar a ler/gravar lá, **mantendo o DoctorOEM apenas como fonte de sincronização externa**? Ou você quer continuar lendo direto do DoctorOEM em tempo real e o Cloud só guardar metadados (tenants/usuários/configs)?
3. **Roles dentro do tenant**: mantenho `admin / financeiro / suporte` que já existem no `role-context`?

Posso prosseguir com este plano após essas três respostas.