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
//
// ---------------------------------------------------------------------------
// DUAS COISAS SAEM DAQUI, E ELAS SÃO DE NÍVEIS DIFERENTES
// ---------------------------------------------------------------------------
//   filiais[] — a LICENÇA DE CADA CLIENTE: quais módulos a filial tem ligados e
//               quanto ela é faturada. Vem do espelho (clientes_oem), que o
//               oem-sync-passo mantém.
//   precos[]  — as REGRAS COMERCIAIS DO PARCEIRO: quanto cada módulo custa em
//               cada produto do catálogo. Não depende de cliente nenhum — é a
//               grade de "Dados da empresa › Regras comerciais" do portal.
//
// Confundir as duas custa caro: o valor da grade é preço de tabela, e o da
// filial é o que ela paga (pode ter desconto — medido no grupo 8201, "Gestao"
// de tabela 39,90 sai 25,12 na loja). Uma não substitui a outra.
// ============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Host de LEITURA. O de escrita (api.pdvlegal.com.br) vem nas credenciais e
// não serve aqui: o token dele é recusado nas rotas de licenciamento — medido,
// devolve 401 "Authorization has been denied for this request.".
const LEITURA_BASE = (Deno.env.get("OEM_API_LEITURA_URL") ?? "https://api.tabletcloud.com.br")
  .replace(/\/+$/, "");

type ItemPreco = {
  produto_codigo: string;
  produto_nome: string;
  modulo_codigo: number;
  modulo_nome: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
};

/** GET no OEM que espera uma vez quando toma 429. São 7 chamadas ao todo. */
async function oemGet(token: string, url: string): Promise<Response> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status !== 429) return r;
  const espera = Number(r.headers.get("retry-after")) * 1000;
  await new Promise((s) => setTimeout(s, Number.isFinite(espera) && espera > 0 ? espera : 2000));
  return fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
}

/**
 * A tabela de preços do parceiro.
 *
 * A ROTA É A MESMA DOS MÓDULOS DA LICENÇA, COM GRUPO E LOJA = 0. É isso que a
 * API chama de "novo licenciamento": sem loja para consultar, ela devolve o
 * valor de TABELA de cada módulo em vez do valor daquela filial. Conferido
 * contra o portal em 17/08/2026 no produto GESTAO LEGAL — Gestao 39,90 ·
 * Usuário Cloud 0,00 · PDV/Comandas 15,00 · NFCE 5,00 · NFE 5,00 · SAT 5,00.
 *
 * São 6 produtos no catálogo da Digi Office e ~57 módulos distintos: 1 token +
 * 1 listagem + 6 chamadas, ~3s no total. Não vale tabela nem fila para isso.
 */
async function buscarPrecos(db: SupabaseClient, tenantId: string): Promise<{
  produtos: { codigo: string; nome: string }[];
  itens: ItemPreco[];
}> {
  const { data, error } = await db.rpc("obter_credenciais_oem", { p_tenant_id: tenantId });
  if (error) throw new Error(`obter_credenciais_oem: ${error.message}`);
  if (!data) throw new Error("Credenciais OEM não cadastradas para esta empresa.");
  const c = data as Record<string, string | null>;
  const faltando = ["username", "password", "client_id", "client_secret"].filter((k) => !c[k]);
  if (faltando.length) throw new Error(`Credenciais OEM incompletas: ${faltando.join(", ")}.`);

  const respToken = await fetch(`${LEITURA_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      username: c.username!, password: c.password!,
      grant_type: c.method ?? "password",
      client_id: c.client_id!, client_secret: c.client_secret!,
    }).toString(),
  });
  if (!respToken.ok) {
    const t = await respToken.text().catch(() => "");
    throw new Error(`Autenticação no OEM falhou (HTTP ${respToken.status}): ${t.slice(0, 180)}`);
  }
  const token = (await respToken.json())?.access_token;
  if (!token) throw new Error("Resposta de token sem access_token.");

  const rProd = await oemGet(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`);
  if (!rProd.ok) throw new Error(`Catálogo de produtos HTTP ${rProd.status}.`);
  const catalogo = await rProd.json().catch(() => null);
  if (!Array.isArray(catalogo)) throw new Error("Catálogo de produtos veio inválido.");

  const produtos = catalogo
    .filter((p) => p?.codigo && p?.nome)
    .map((p) => ({ codigo: String(p.codigo), nome: String(p.nome).trim() }));

  const itens: ItemPreco[] = [];
  for (const p of produtos) {
    const url = `${LEITURA_BASE}/licenciamento/minhaslicencas/modulos/${encodeURIComponent(p.codigo)}/0/0`;
    const r = await oemGet(token, url);
    // Produto que falha não derruba os outros: a grade sai sem a coluna dele e
    // o consumidor vê o que deu para ler. Zerar tudo por causa de um seria pior.
    if (!r.ok) { console.error(`[oem-exportar] preços ${p.nome}: HTTP ${r.status}`); continue; }
    const raw = await r.json().catch(() => null);
    for (const m of (Array.isArray(raw?.modulos) ? raw.modulos : []) as Record<string, any>[]) {
      const cod = Number(m.codigo);
      if (!Number.isFinite(cod)) continue;
      const quantidade = Number(m.quantidade ?? 1) || 1;
      const valorTotal = Number(m.valorTotal ?? 0) || 0;
      let valorUnitario = Number(m.valorUnitario ?? 0) || 0;
      if (valorUnitario === 0 && quantidade > 0 && valorTotal > 0) {
        valorUnitario = Math.round((valorTotal / quantidade) * 100) / 100;
      }
      itens.push({
        produto_codigo: p.codigo,
        produto_nome: p.nome,
        modulo_codigo: cod,
        modulo_nome: String(m.nome ?? `Módulo ${cod}`).trim(),
        quantidade,
        valor_unitario: valorUnitario,
        valor_total: valorTotal,
      });
    }
  }
  // `ativo` do módulo NÃO é copiado de propósito: sem loja na consulta ele vem
  // sempre false, e gravá-lo faria a grade dizer que nada está habilitado.
  return { produtos, itens };
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

    // Tabela de preços do parceiro. Vai junto por padrão; quem só quer as
    // filiais manda {"precos": false} e economiza as 7 chamadas ao OEM.
    //
    // FALHA AQUI NÃO DERRUBA A EXPORTAÇÃO. As filiais são o caminho crítico do
    // espelho do DoctorSaaS — deixar o custo de 2.500 filiais desatualizado
    // porque o catálogo de preços não respondeu seria o rabo abanando o
    // cachorro. O consumidor recebe `precos: null` e o motivo escrito.
    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    let precos: Record<string, unknown> | null = null;
    let precosErro: string | null = null;
    if (corpo?.precos !== false) {
      try {
        precos = { atualizado_em: new Date().toISOString(), ...(await buscarPrecos(db, tenantId)) };
      } catch (e) {
        precosErro = e instanceof Error ? e.message : String(e);
        console.error("[oem-exportar] preços:", precosErro);
      }
    }

    return Response.json({
      ok: true,
      tenantId,
      total: filiais.length,
      ultimaSincronizacao: log ?? null,
      duracaoMs: Date.now() - inicio,
      filiais,
      precos,
      precosErro,
    }, { headers: cors });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oem-exportar]", msg);
    return Response.json({ ok: false, mensagem: msg }, { status: 500, headers: cors });
  }
});
