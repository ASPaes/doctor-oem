# Deploy do Nexus Hub (DoctorOEM)

Fora do Lovable desde 12/08/2026. O app roda no **Cloudflare Workers** e o banco
é o Supabase **DoctorOEM da ASP** (`furohpfhukwajhvnnbiw`).

## O que o app precisa para funcionar

| Variável | Onde vive | Por quê |
|---|---|---|
| `VITE_SUPABASE_URL` · `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env` (build) | vão embutidas no bundle do navegador |
| `SUPABASE_URL` · `SUPABASE_PUBLISHABLE_KEY` | `wrangler.jsonc` → `vars` | servidor, não são segredo |
| `SUPABASE_SERVICE_ROLE_KEY` | **segredo do Worker** | bypassa RLS — nunca no repo |
| `OEM_API_LEITURA_URL` | `vars` | host de leitura (tabletcloud) |
| `OEM_ESCRITA_HABILITADA` | `vars` | trava de escrita no OEM (padrão `false`) |

As credenciais da API OEM **não** são variável de ambiente: ficam por empresa em
`tenant_oem_settings`, preenchidas na tela de Configurações.

## Primeira publicação

```bash
# 1. Conta Cloudflare (uma vez)
bunx wrangler login

# 2. Segredo do Supabase (uma vez; cola a service_role key quando pedir)
bunx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# 3. Build + publicação
bun run build
bunx wrangler deploy
```

O `wrangler deploy` devolve a URL pública (`https://nexus-hub-oem.<conta>.workers.dev`).
Guarde essa URL: o agendamento da sincronização aponta para ela.

## Publicações seguintes

```bash
bun run build && bunx wrangler deploy
```

## Antes de publicar, sempre

```bash
bunx tsc --noEmit   # tem que sair limpo
bun run build       # tem que compilar
```

## Domínio próprio

Em Workers & Pages → o worker → Settings → Domains & Routes → Add custom domain.
O DNS precisa estar na Cloudflare.

## O que NÃO fazer

- **Não commitar** `.env.local` (está no `.gitignore` via `*.local`). Ele tem a
  `service_role` do banco de produção.
- **Não colocar** a `SUPABASE_SERVICE_ROLE_KEY` em `wrangler.jsonc`. Ela é
  segredo; `vars` fica visível no painel e no repositório.
- **Não ligar** `OEM_ESCRITA_HABILITADA` sem combinar antes. Com ela em `true`,
  os botões de bloquear/desbloquear e ativar/desativar passam a alterar o OEM
  de verdade — e esse caminho ainda não foi validado contra a API real.

## O plano grátis do Cloudflare basta

Cloudflare Workers permite **50 subrequisições por requisição no plano free**.
Uma carga completa do OEM são ~5.100 chamadas — não caberia nunca.

Mas **a carga não roda aqui**. Ela vive na edge function `oem-sync-passo`, no
próprio Supabase, chamada pelo pg_cron a cada 3 minutos. O botão "Sincronizar"
da tela apenas **invoca essa função**: 1 subrequisição, não 120.

Ou seja: o Worker serve as telas e faz chamadas ao Supabase. Nada aqui chega
perto do limite do plano grátis.

O único caminho neste runtime que fala com o OEM é a **escrita** (bloquear /
desativar), que faz ~4 chamadas por clique — e está desligada por padrão.
