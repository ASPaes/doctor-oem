// De onde o SERVIDOR tira o endereço e as chaves do Supabase.
//
// No Lovable, o `process.env.SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` /
// `SUPABASE_SERVICE_ROLE_KEY` do servidor publicado são impostos pelo Lovable
// Cloud e apontam para o banco antigo dele (tpzflrwtrpzjgsykwynq), não para o
// DoctorOEM (furohpfhukwajhvnnbiw). O navegador usa o DoctorOEM porque as VITE_*
// vão embutidas no build. Resultado medido em 29/09/2026: token do navegador
// rejeitado no servidor ("Unauthorized: Invalid token") e as funções com
// service role lendo um banco sem `profiles`.
//
// Por isso o servidor lê primeiro as VITE_* do build (as mesmas do navegador) e
// a service role de um segredo com nome próprio, que o Lovable não sobrescreve.

// 12/11/2026: as VITE_* também deixaram de ser confiáveis no servidor. Depois
// de um Publish, TODA server function passou a responder "Unauthorized: Invalid
// token" em todas as empresas, com o navegador ainda no DoctorOEM (token ES256,
// kid 7f7a9ee3 = furoh). O build do Lovable passou a injetar as VITE_SUPABASE_*
// do Cloud no lado servidor. Endereço e chave publishable são PÚBLICOS (estão
// no .env commitado e no bundle do navegador), então ficam fixos aqui: nenhuma
// variável de ambiente decide para qual banco o servidor olha.
const DOCTOROEM_SUPABASE_URL = "https://furohpfhukwajhvnnbiw.supabase.co";
const DOCTOROEM_SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cm9ocGZodWt3YWpodm5uYml3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzMxOTYsImV4cCI6MjA5NjU0OTE5Nn0.5qXujfD16TtztaEL3lrp7fbwzhjypAZgBgvXzlILPgE";

export function supabaseUrl(): string | undefined {
  return DOCTOROEM_SUPABASE_URL;
}

export function supabasePublishableKey(): string | undefined {
  return DOCTOROEM_SUPABASE_PUBLISHABLE_KEY;
}

// `DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY` é o segredo no Lovable (criado em 09/06 para este
// banco — ver tenant_oem_settings.doctoroem_service_secret_name). A `SUPABASE_SERVICE_ROLE_KEY`
// só vale quando o `SUPABASE_URL` do ambiente é o mesmo projeto (local, Cloudflare):
// no Lovable ela é a do Cloud e seria chave de um projeto usada contra outro.
export function supabaseServiceRoleKey(): string | undefined {
  const propria = process.env.DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY;
  if (propria) return propria;
  const doAmbiente = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const mesmoProjeto = normalizar(process.env.SUPABASE_URL) === normalizar(supabaseUrl());
  return mesmoProjeto ? doAmbiente : undefined;
}

function normalizar(url: string | undefined): string {
  return (url ?? "").replace(/\/+$/, "");
}
