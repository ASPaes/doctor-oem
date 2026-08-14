// ============================================================================
// oem-exportar — porta de saída do DoctorOEM para quem consome de fora.
//
// Autentica por CHAVE DE INTEGRAÇÃO (header x-api-key), não por JWT: quem
// chama é outro sistema (o DoctorSaaS), não uma pessoa logada aqui. Por isso
// esta função é declarada com verify_jwt = false no config.toml — a checagem
// é a chave, e ela é comparada por SHA-256 contra oem_api_chaves.
//
// A CHAVE É QUEM CARREGA O TENANT. Quem apresenta a chave da Digi Office só
// enxerga as filiais da Digi Office. Não existe parâmetro de tenant no corpo,
// justamente para não haver como pedir os dados de outra empresa.
//
// Substitui o OEM_MAPA_TENANTS, que era um de-para chumbado em variável de
// ambiente e não escalava para uma segunda empresa.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const inicio = Date.now();

  try {
    const chave = req.headers.get("x-api-key")
      ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!chave) {
      return Response.json({ ok: false, mensagem: "Informe a chave em x-api-key." },
        { status: 401, headers: cors });
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: registro } = await db
      .from("oem_api_chaves")
      .select("id, tenant_id, ativa, revogada_em")
      .eq("token_hash", await sha256Hex(chave))
      .maybeSingle();

    if (!registro || !registro.ativa || registro.revogada_em) {
      // Mesma resposta para chave inexistente e revogada — não entregamos
      // ao chamador a informação de que a chave já existiu.
      return Response.json({ ok: false, mensagem: "Chave inválida." },
        { status: 401, headers: cors });
    }

    const tenantId = String(registro.tenant_id);

    // Carimba o uso. Falhar aqui não pode derrubar a exportação.
    db.from("oem_api_chaves").update({ ultimo_uso_em: new Date().toISOString() })
      .eq("id", registro.id).then(({ error }) => {
        if (error) console.error("[oem-exportar] ultimo_uso_em:", error.message);
      });

    // Filiais da empresa dona da chave. Paginado: PostgREST corta em 1000.
    const filiais: Record<string, unknown>[] = [];
    for (let de = 0; de < 100_000; de += 1000) {
      const { data, error } = await db
        .from("clientes_oem")
        .select("empresa_codigo, filial_codigo, nome_fantasia, razao_social, grupo_economico, " +
                "cnpj_cpf, produto_principal, status, bloqueado, custo_total, qtd_pdv, " +
                "qtd_comandas, usuarios_adicionais, numero_filiais, modulos_ativos, last_sync")
        .eq("tenant_id", tenantId)
        .order("id")
        .range(de, de + 999);
      if (error) throw new Error(`clientes_oem: ${error.message}`);
      const lote = data ?? [];
      filiais.push(...lote);
      if (lote.length < 1000) break;
    }

    // Estado da última carga, para o consumidor saber se o dado é fresco.
    const { data: log } = await db
      .from("oem_sync_logs")
      .select("executado_em, status, total_clientes, clientes_atualizados, clientes_falha, mensagem")
      .eq("tenant_id", tenantId)
      .order("executado_em", { ascending: false })
      .limit(1)
      .maybeSingle();

    return Response.json({
      ok: true,
      tenantId,
      total: filiais.length,
      ultimaSincronizacao: log ?? null,
      duracaoMs: Date.now() - inicio,
      filiais,
    }, { headers: cors });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oem-exportar]", msg);
    return Response.json({ ok: false, mensagem: msg }, { status: 500, headers: cors });
  }
});
