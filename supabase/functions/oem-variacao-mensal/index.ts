// ============================================================================
// oem-variacao-mensal — POR QUE o custo de cada filial mudou de um mês para o
// outro (DEM-0517).
//
// POR QUE ISTO EXISTE (01/10/2026)
//
// O portal do OEM tem uma planilha chamada "Reajustes" (Relatórios ›
// Planilhas). Ela NÃO está na API pública (as 174 rotas de /Help) e, aberta,
// ela também não é o que o nome diz: lista TODA filial cujo valor mudou entre
// dois meses — `ValorAtual`, `ValorMesAnterior`, `Percentual`. Em set/2026
// eram 78 lojas, 26 delas CAINDO (até −72%), e o CASA DA PONTE aparecia com
// +10,12% por causa de dois módulos novos, não de reajuste.
//
// Acender "Reajuste Tablet Cloud" para quem aparece na planilha diria
// exatamente a coisa errada. Esta função refaz a mesma conta a partir do
// relatório de faturamento (rota documentada, uma chamada por mês) e separa a
// variação MÓDULO A MÓDULO:
//
//   - módulo que só existe no mês atual, ou com mais quantidade -> upsell
//   - módulo que só existe no anterior, ou com menos quantidade -> downsell
//   - mesmo módulo, mesma quantidade, valor diferente           -> reajuste
//   - módulo cobrado por pedido (quantidadePedido > 0)          -> consumo
//
// Cada módulo vira UM evento com o delta inteiro dele, então a soma dos
// eventos fecha a diferença da filial (sobra só centavo de arredondamento).
//
// Conferido em 01/10/2026 contra a planilha do portal de set/2026: 77 das 78
// lojas com os mesmos dois valores, centavo a centavo; a 78ª variou R$ 0,01.
// A planilha deixa de fora quem entrou ou saiu no mês (valor zero de um dos
// lados); esta função devolve também essas.
//
// O QUE ELA FAZ
//   - Não escreve NADA. Nem no banco, nem no OEM.
//   - Não guarda histórico: o DoctorSaaS consulta quando precisa. O
//     faturamento do mês fechado não muda, e a planilha do portal é
//     recalculada uma vez por dia — consultar sob demanda basta.
//
// Autentica por x-api-key, igual à `oem-exportar`: quem chama é o DoctorSaaS.
// ============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const LEITURA_BASE = (Deno.env.get("OEM_API_LEITURA_URL") ?? "https://api.tabletcloud.com.br")
  .replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Creds = { username: string; password: string; clientId: string; clientSecret: string; method: string };

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function carregarCreds(db: SupabaseClient, tenantId: string): Promise<Creds> {
  const { data, error } = await db.rpc("obter_credenciais_oem", { p_tenant_id: tenantId });
  if (error) throw new Error(`obter_credenciais_oem: ${error.message}`);
  if (!data) throw new Error("Credenciais OEM não cadastradas para esta empresa.");
  const c = data as Record<string, string | null>;
  const faltando = ["username", "password", "client_id", "client_secret"].filter((k) => !c[k]);
  if (faltando.length) throw new Error(`Credenciais OEM incompletas: ${faltando.join(", ")}.`);
  return {
    username: c.username!, password: c.password!,
    clientId: c.client_id!, clientSecret: c.client_secret!,
    method: c.method ?? "password",
  };
}

async function obterToken(base: string, creds: Creds): Promise<string> {
  const resp = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      username: creds.username, password: creds.password,
      grant_type: creds.method || "password",
      client_id: creds.clientId, client_secret: creds.clientSecret,
    }).toString(),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Autenticação em ${base} falhou (HTTP ${resp.status}): ${t.slice(0, 180)}`);
  }
  const j = await resp.json();
  if (!j?.access_token) throw new Error(`Resposta de token sem access_token em ${base}.`);
  return j.access_token as string;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;

type Modulo = { codigo: string; nome: string; valor: number; quantidade: number; pedidos: number; dataAtivacao: string | null };
type Filial = { codigo: string; nome: string; cnpj: string | null; grupo: string; produto: string | null; valorTotal: number; modulos: Map<string, Modulo> };

// O mesmo módulo pode vir em mais de uma linha (a "Licença PDV" aparece três
// vezes na mesma filial). Soma por código antes de comparar, senão a segunda
// linha vira "módulo removido".
async function faturamento(token: string, mes: number, ano: number): Promise<Map<string, Filial>> {
  const resp = await fetch(`${LEITURA_BASE}/licenciamento/relatorioMensal/${mes}/${ano}/true`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`relatorioMensal ${mes}/${ano}: HTTP ${resp.status}`);
  const rel = await resp.json() as Record<string, unknown>;
  const out = new Map<string, Filial>();
  for (const oem of (Array.isArray(rel.oems) ? rel.oems : []) as Record<string, unknown>[]) {
    for (const emp of (Array.isArray(oem.empresas) ? oem.empresas : []) as Record<string, unknown>[]) {
      for (const f of (Array.isArray(emp.filiais) ? emp.filiais : []) as Record<string, unknown>[]) {
        const modulos = new Map<string, Modulo>();
        for (const m of (Array.isArray(f.modulos) ? f.modulos : []) as Record<string, unknown>[]) {
          const cod = String(m.codigo ?? m.nome ?? "");
          const ja = modulos.get(cod);
          // `valor` é o TOTAL do módulo na fatura. Nunca multiplicar pela
          // quantidade (ver oem-valor-total-nunca-multiplicar).
          if (ja) {
            ja.valor += num(m.valor);
            ja.quantidade += num(m.quantidade);
            ja.pedidos += num(m.quantidadePedido);
          } else {
            modulos.set(cod, {
              codigo: cod, nome: String(m.nome ?? cod), valor: num(m.valor),
              quantidade: num(m.quantidade), pedidos: num(m.quantidadePedido),
              dataAtivacao: m.dataAtivacao ? String(m.dataAtivacao) : null,
            });
          }
        }
        out.set(String(f.codigo), {
          codigo: String(f.codigo), nome: String(f.nome ?? ""),
          cnpj: f.cnpj ? String(f.cnpj) : null, grupo: String(emp.codigo ?? ""),
          produto: emp.nomeProduto ? String(emp.nomeProduto) : null,
          valorTotal: num(f.valorTotal), modulos,
        });
      }
    }
  }
  return out;
}

type Evento = {
  tipo: "upsell" | "downsell" | "reajuste" | "consumo";
  modulo: string; codigo: string;
  qtdAntes: number; qtdDepois: number;
  valorAntes: number; valorDepois: number;
  delta: number; dataAtivacao: string | null;
};

function comparar(antes: Map<string, Modulo>, depois: Map<string, Modulo>): Evento[] {
  const eventos: Evento[] = [];
  const codigos = new Set([...antes.keys(), ...depois.keys()]);
  for (const cod of codigos) {
    const a = antes.get(cod);
    const d = depois.get(cod);
    const va = a?.valor ?? 0, vd = d?.valor ?? 0;
    const qa = a?.quantidade ?? 0, qd = d?.quantidade ?? 0;
    if (Math.abs(vd - va) < 0.005) continue;
    const base = {
      modulo: (d ?? a)!.nome, codigo: cod, qtdAntes: qa, qtdDepois: qd,
      valorAntes: r2(va), valorDepois: r2(vd), dataAtivacao: d?.dataAtivacao ?? a?.dataAtivacao ?? null,
    };
    // Cobrado por pedido: o valor varia todo mês com o movimento da loja. Não
    // é venda, não é perda e não é reajuste.
    if ((a?.pedidos ?? 0) > 0 || (d?.pedidos ?? 0) > 0) {
      eventos.push({ ...base, tipo: "consumo", delta: r2(vd - va) });
      continue;
    }
    // Módulo de valor zero num dos lados conta como entrada/saída inteira.
    if (!a || va === 0) { eventos.push({ ...base, tipo: "upsell", delta: r2(vd - va) }); continue; }
    if (!d || vd === 0) { eventos.push({ ...base, tipo: "downsell", delta: r2(vd - va) }); continue; }
    // Quantidade mudou: o delta INTEIRO é up/downsell. O PDV/Comandas tem preço
    // por faixa (2 terminais = R$ 25,65; 3 = R$ 32,40), então o unitário cai
    // quando a quantidade sobe. Partir em "quantidade × unitário antigo" +
    // "resto" fazia o 3º terminal virar upsell de R$ 12,83 E reajuste de
    // −R$ 6,07 — reajuste que não aconteceu (medido em set/2026, 6 lojas).
    if (qd !== qa) {
      eventos.push({ ...base, tipo: vd > va ? "upsell" : "downsell", delta: r2(vd - va) });
      continue;
    }
    // Mesma quantidade, valor diferente: o preço do módulo mudou.
    eventos.push({ ...base, tipo: "reajuste", delta: r2(vd - va) });
  }
  return eventos.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const inicio = Date.now();
  try {
    const chave = req.headers.get("x-api-key")
      ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!chave) {
      return Response.json({ ok: false, mensagem: "Informe a chave em x-api-key." }, { status: 401, headers: cors });
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } });
    const { data: registro } = await db.from("oem_api_chaves")
      .select("id, tenant_id, ativa, revogada_em")
      .eq("token_hash", await sha256Hex(chave))
      .maybeSingle();
    if (!registro || !registro.ativa || registro.revogada_em) {
      return Response.json({ ok: false, mensagem: "Chave inválida." }, { status: 401, headers: cors });
    }

    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    // Padrão: o último mês FECHADO. Competência aberta volta HTTP 200 com tudo
    // zerado (ver oem-custo-vem-do-faturamento), e compará-la contra o mês
    // anterior faria toda filial aparecer como downsell de 100%.
    const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const fechado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const mes = Number(corpo.mes ?? 0) || fechado.getMonth() + 1;
    const ano = Number(corpo.ano ?? 0) || fechado.getFullYear();
    const ant = new Date(ano, mes - 2, 1);
    const filtro = Array.isArray(corpo.filiais) ? new Set((corpo.filiais as unknown[]).map(String)) : null;

    const token = await obterToken(LEITURA_BASE, await carregarCreds(db, String(registro.tenant_id)));
    const [atual, anterior] = await Promise.all([
      faturamento(token, mes, ano),
      faturamento(token, ant.getMonth() + 1, ant.getFullYear()),
    ]);
    if (atual.size === 0) {
      return Response.json({ ok: false, mensagem: `Competência ${mes}/${ano} sem faturamento (ainda aberta?).` },
        { status: 409, headers: cors });
    }

    const filiais = [];
    const vazio = new Map<string, Modulo>();
    for (const cod of new Set([...atual.keys(), ...anterior.keys()])) {
      if (filtro && !filtro.has(cod)) continue;
      const d = atual.get(cod), a = anterior.get(cod);
      const va = a?.valorTotal ?? 0, vd = d?.valorTotal ?? 0;
      if (Math.abs(vd - va) < 0.005) continue;
      const eventos = comparar(a?.modulos ?? vazio, d?.modulos ?? vazio);
      const explicado = r2(eventos.reduce((s, e) => s + e.delta, 0));
      const ref = (d ?? a)!;
      filiais.push({
        filial: cod, nome: ref.nome, cnpj: ref.cnpj, grupo: ref.grupo, produto: ref.produto,
        valorAtual: r2(vd), valorAnterior: r2(va), diferenca: r2(vd - va),
        percentual: va > 0 ? r2(((vd - va) / va) * 100) : null,
        // O que os módulos não explicam: diferença entre o total da filial e a
        // soma das linhas. Deve ser zero; quando não é, a tela diz.
        naoExplicado: r2(vd - va - explicado),
        eventos,
      });
    }
    filiais.sort((x, y) => Math.abs(y.diferenca) - Math.abs(x.diferenca));

    const conta = (t: Evento["tipo"]) => filiais.filter((f) => f.eventos.some((e) => e.tipo === t)).length;
    return Response.json({
      ok: true,
      competencia: `${String(mes).padStart(2, "0")}/${ano}`,
      comparadaCom: `${String(ant.getMonth() + 1).padStart(2, "0")}/${ant.getFullYear()}`,
      duracaoMs: Date.now() - inicio,
      resumo: {
        filiaisComVariacao: filiais.length,
        comUpsell: conta("upsell"), comDownsell: conta("downsell"),
        comReajuste: conta("reajuste"), comConsumo: conta("consumo"),
        comSobraNaoExplicada: filiais.filter((f) => Math.abs(f.naoExplicado) > 0.015).length,
      },
      filiais,
    }, { headers: cors });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oem-variacao-mensal]", msg);
    return Response.json({ ok: false, mensagem: msg }, { status: 500, headers: cors });
  }
});
