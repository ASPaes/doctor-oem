import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only admin client for the EXTERNAL Supabase project "DoctorOEM".
// Uses the service_role key, which BYPASSES RLS. Never import in client code.
let _client: SupabaseClient | null = null;

export function getDoctorOemAdmin(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.DOCTOROEM_SUPABASE_URL;
  const key = process.env.DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "DoctorOEM: variáveis DOCTOROEM_SUPABASE_URL e/ou DOCTOROEM_SUPABASE_SERVICE_ROLE_KEY ausentes.",
    );
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}