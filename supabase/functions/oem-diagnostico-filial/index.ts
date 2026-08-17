// ============================================================================
// oem-diagnostico-filial — as respostas CRUAS do OEM para UMA filial.
//
// POR QUE ISTO EXISTE (17/08/2026)
//
// A filial 13250 (TROPEIRAO DO JUCAO) aparece no portal do OEM valendo
// R$ 257,88, e a carga grava R$ 213,88. A diferença é uma linha só, o módulo
// "Delivery Legal - Valor total dos pedidos", de R$ 44,00: o portal cobra, e
// o `/minhaslicencas/modulos` devolve esse módulo com valor ZERO — inclusive
// no `valorTotal` que ele mesmo declara.
//
// Antes de mudar a conta, é preciso ver o que cada endpoint responde, sem
// normalização nenhuma no meio. Trocar a fonte no escuro já custou caro aqui:
// o `modulos[]` do pdvlegal veio incompleto (2 de 5 na PARRILLA GOLD) e por
// isso o motor não o usa.
//
// O QUE ELA FAZ
//   - Não escreve NADA. Nem no banco, nem no OEM. É leitura pura.
//   - Pergunta os módulos para TODOS os produtos do catálogo, não só o
//     principal — se a filial tiver um segundo produto licenciado, o custo
//     dele nunca entrou na conta e é aqui que isso aparece.
//   - Devolve o payload cru de cada chamada, mais um resumo que diz onde cada
//     valor foi encontrado e o que sobra para fechar o total esperado.
//
// Autentica por x-api-key, igual à `oem-exportar`: quem chama é outro sistema
// (ou uma investigação pontual), não uma pessoa logada aqui. A chave carrega o
// tenant — não existe parâmetro de empresa no corpo.
// ============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const LEITURA_BASE = (Deno.env.get("OEM_API_LEITURA_URL") ?? "https://api.tabletcloud.com.br")
  .replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Creds = {
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  method: string;
};

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
    baseUrl: (c.base_url ?? "https://api.pdvlegal.com.br").replace(/\/+$/, ""),
    username: c.username!,
    password: c.password!,
    clientId: c.client_id!,
    clientSecret: c.client_secret!,
    method: c.method ?? "password",
  };
}

async function obterToken(base: string, creds: Creds): Promise<string> {
  const resp = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      username: creds.username,
      password: creds.password,
      grant_type: creds.method || "password",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
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

/** GET que nunca derruba o diagnóstico: falha vira registro, não exceção. */
async function espiar(token: string, url: string): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const texto = await resp.text().catch(() => "");
    let corpo: unknown = texto;
    try {
      corpo = JSON.parse(texto);
    } catch {
      // Não era JSON — o texto cru já é a informação que interessa.
    }
    return { url, http: resp.status, ok: resp.ok, corpo };
  } catch (e) {
    return { url, http: null, ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

/** Todo número > 0 que aparece em qualquer lugar do payload, com o caminho. */
function garimparValores(no: unknown, caminho = "", achados: Record<string, number> = {}) {
  if (no == null) return achados;
  if (typeof no === "number") {
    if (no > 0) achados[caminho || "(raiz)"] = no;
    return achados;
  }
  if (typeof no === "string") {
    // "44.00" e "44,00" contam: a API mistura número e texto no mesmo campo.
    const n = Number(no.replace(",", "."));
    if (Number.isFinite(n) && n > 0 && /^\s*[\d.,]+\s*$/.test(no)) {
      achados[caminho || "(raiz)"] = n;
    }
    return achados;
  }
  if (Array.isArray(no)) {
    no.forEach((v, i) => garimparValores(v, `${caminho}[${i}]`, achados));
    return achados;
  }
  if (typeof no === "object") {
    for (const [k, v] of Object.entries(no as Record<string, unknown>)) {
      garimparValores(v, caminho ? `${caminho}.${k}` : k, achados);
    }
  }
  return achados;
}

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
      return Response.json({ ok: false, mensagem: "Chave inválida." },
        { status: 401, headers: cors });
    }
    const tenantId = String(registro.tenant_id);

    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    const empresa = String(corpo.empresa ?? "").replace(/\D/g, "");
    const filial = String(corpo.filial ?? "").replace(/\D/g, "");
    // Quanto o portal do OEM mostra para esta filial. Opcional: serve só para
    // o resumo dizer quanto falta e onde esse número aparece nos payloads.
    const esperado = Number(corpo.esperado ?? 0) || null;
    if (corpo.comparar !== true && (!empresa || !filial)) {
      return Response.json(
        { ok: false, mensagem: "Informe empresa e filial no corpo: {\"empresa\":\"11058\",\"filial\":\"13250\"}" },
        { status: 400, headers: cors },
      );
    }

    const creds = await carregarCreds(db, tenantId);
    const tokenTc = await obterToken(LEITURA_BASE, creds);

    // ---------------------------------------------------------------- comparar
    //
    // Modo de conferência da BASE INTEIRA: o relatório de faturamento contra o
    // custo que a carga gravou. Uma chamada só ao OEM cobre todas as filiais —
    // é o mesmo dado, na escala em que a decisão precisa ser tomada.
    if (corpo.comparar === true) {
      const agoraC = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
      const mesC = Number(corpo.mes ?? 0) || agoraC.getMonth() + 1;
      const anoC = Number(corpo.ano ?? 0) || agoraC.getFullYear();
      const rel = await espiar(tokenTc, `${LEITURA_BASE}/licenciamento/relatorioMensal/${mesC}/${anoC}/true`);
      const corpoRel = (rel.corpo ?? {}) as Record<string, unknown>;

      const faturado = new Map<string, { nome: string; valor: number }>();
      for (const oem of (Array.isArray(corpoRel.oems) ? corpoRel.oems : []) as Record<string, unknown>[]) {
        for (const emp of (Array.isArray(oem.empresas) ? oem.empresas : []) as Record<string, unknown>[]) {
          for (const f of (Array.isArray(emp.filiais) ? emp.filiais : []) as Record<string, unknown>[]) {
            faturado.set(String(f.codigo), {
              nome: String(f.nome ?? ""),
              valor: Number(f.valorTotal ?? 0) || 0,
            });
          }
        }
      }

      const gravado: { filial_codigo: string; custo_total: number | null; status: string | null }[] = [];
      for (let de = 0; de < 100_000; de += 1000) {
        const { data, error } = await db
          .from("clientes_oem")
          .select("filial_codigo, custo_total, status")
          .eq("tenant_id", tenantId)
          .order("id")
          .range(de, de + 999);
        if (error) throw new Error(`clientes_oem: ${error.message}`);
        const lote = data ?? [];
        gravado.push(...(lote as typeof gravado));
        if (lote.length < 1000) break;
      }

      let somaFaturada = 0;
      let somaGravadaDosFaturados = 0;
      const divergentes: Record<string, unknown>[] = [];
      let iguais = 0;
      let semFaturamento = 0;
      // A conta que decide é a das ATIVAS: filial desativada hoje pode ter sido
      // faturada em julho por estar viva naquele mês, e essa diferença é do
      // calendário, não do dado. Misturar as duas infla o buraco.
      const ativas = { faturado: 0, gravado: 0, divergentes: 0, aMenos: 0, aMais: 0 };
      for (const g of gravado) {
        const f = faturado.get(String(g.filial_codigo));
        if (!f) {
          if (g.status === "Ativo") semFaturamento++;
          continue;
        }
        const gravadoV = Number(g.custo_total ?? 0) || 0;
        somaFaturada += f.valor;
        somaGravadaDosFaturados += gravadoV;
        if (g.status === "Ativo") {
          ativas.faturado += f.valor;
          ativas.gravado += gravadoV;
          if (Math.abs(f.valor - gravadoV) >= 0.01) {
            ativas.divergentes++;
            if (f.valor > gravadoV) ativas.aMenos++; else ativas.aMais++;
          }
        }
        if (Math.abs(f.valor - gravadoV) >= 0.01) {
          divergentes.push({
            filial: g.filial_codigo, nome: f.nome, status: g.status,
            gravado: gravadoV, faturado: f.valor,
            diferenca: Math.round((f.valor - gravadoV) * 100) / 100,
          });
        } else iguais++;
      }
      divergentes.sort((a, b) => Math.abs(Number(b.diferenca)) - Math.abs(Number(a.diferenca)));

      return Response.json({
        ok: true,
        competencia: `${String(mesC).padStart(2, "0")}/${anoC}`,
        duracaoMs: Date.now() - inicio,
        resumo: {
          filiaisNoRelatorio: faturado.size,
          filiaisNoEspelho: gravado.length,
          casadas: iguais + divergentes.length,
          iguais,
          divergentes: divergentes.length,
          ativasSemFaturamento: semFaturamento,
          somaFaturada: Math.round(somaFaturada * 100) / 100,
          somaGravada: Math.round(somaGravadaDosFaturados * 100) / 100,
          diferencaTotal: Math.round((somaFaturada - somaGravadaDosFaturados) * 100) / 100,
        },
        somenteAtivas: {
          faturado: Math.round(ativas.faturado * 100) / 100,
          gravado: Math.round(ativas.gravado * 100) / 100,
          diferenca: Math.round((ativas.faturado - ativas.gravado) * 100) / 100,
          divergentes: ativas.divergentes,
          gravadoAMenos: ativas.aMenos,
          gravadoAMais: ativas.aMais,
        },
        maioresDivergencias: divergentes.slice(0, 25),
      }, { headers: cors });
    }

    const tokenPl = await obterToken(creds.baseUrl, creds);

    // 1. Catálogo de produtos: é o que permite perguntar por TODOS eles.
    const catalogo = await espiar(tokenTc, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`);
    const produtos: { nome: string; codigo: string }[] = [];
    if (Array.isArray(catalogo.corpo)) {
      for (const p of catalogo.corpo as Array<{ codigo?: string; nome?: string }>) {
        if (p?.codigo) produtos.push({ nome: String(p.nome ?? p.codigo), codigo: String(p.codigo) });
      }
    }

    // 2. Módulos de CADA produto — é aqui que um segundo produto apareceria.
    const modulosPorProduto: Record<string, unknown>[] = [];
    for (const p of produtos) {
      const r = await espiar(
        tokenTc,
        `${LEITURA_BASE}/licenciamento/minhaslicencas/modulos/${encodeURIComponent(p.codigo)}/${empresa}/${filial}`,
      );
      const c = (r.corpo ?? {}) as Record<string, unknown>;
      const lista = Array.isArray(c.modulos) ? (c.modulos as Record<string, unknown>[]) : [];
      modulosPorProduto.push({
        produto: p.nome,
        codproduto: p.codigo,
        http: r.http,
        valorTotalDeclarado: c.valorTotal ?? null,
        somaDosModulos: lista.reduce((a, m) => a + (Number(m.valorTotal ?? m.valor ?? 0) || 0), 0),
        qtdModulos: lista.length,
        cru: r.corpo,
      });
    }

    // 3. O detalhe do host de ESCRITA (pdvlegal), que é o host do portal. Hoje
    //    a carga lê só `bloqueado`, `usuarios` e `pdvComandas` daqui e joga o
    //    resto fora — se o valor que falta existir, é o candidato número um.
    const detalhePl = await espiar(tokenPl, `${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`);

    // 3b. O RELATÓRIO DE FATURAMENTO — o que é cobrado de fato no mês.
    //
    // É outra pergunta, e é a que interessa: `/minhaslicencas/modulos` devolve
    // a licença CONFIGURADA (e devolveu 0,00 no módulo que o portal cobra),
    // enquanto este devolve o que entra na fatura. Módulo de consumo (Delivery
    // Legal) só tem valor aqui, porque só existe depois de faturado.
    //
    // `comDetalhesDeCadaFilial=true` é a consulta pesada — desce a base
    // inteira. Vale a pena: é uma chamada por mês, não uma por filial.
    const agora = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
    );
    const mes = Number(corpo.mes ?? 0) || agora.getMonth() + 1;
    const ano = Number(corpo.ano ?? 0) || agora.getFullYear();
    const relatorio = await espiar(
      tokenTc,
      `${LEITURA_BASE}/licenciamento/relatorioMensal/${mes}/${ano}/true`,
    );

    // Do relatório inteiro só interessa esta filial: devolver a base toda
    // estouraria a resposta e não ajudaria ninguém a ler.
    let faturamentoDaFilial: Record<string, unknown> | null = null;
    let empresaDaFilial: Record<string, unknown> | null = null;
    const rel = (relatorio.corpo ?? {}) as Record<string, unknown>;
    for (const oem of (Array.isArray(rel.oems) ? rel.oems : []) as Record<string, unknown>[]) {
      for (const emp of (Array.isArray(oem.empresas) ? oem.empresas : []) as Record<string, unknown>[]) {
        for (const f of (Array.isArray(emp.filiais) ? emp.filiais : []) as Record<string, unknown>[]) {
          if (String(f.codigo) === filial) {
            faturamentoDaFilial = f;
            empresaDaFilial = {
              codigo: emp.codigo, nome: emp.nome, cnpj: emp.cnpj,
              codProduto: emp.codProduto, nomeProduto: emp.nomeProduto,
              valorTotal: emp.valorTotal,
            };
          }
        }
      }
    }

    // 4. Onde cada número aparece. Com `esperado`, aponta direto quem fecha a
    //    diferença em vez de deixar a leitura no olho.
    const somaTc = modulosPorProduto.reduce(
      (a, m) => a + (Number(m.valorTotalDeclarado ?? 0) || 0), 0);
    const valoresPl = garimparValores(detalhePl.corpo);
    const faltando = esperado ? Math.round((esperado - somaTc) * 100) / 100 : null;
    const ondeEstaOQueFalta = faltando
      ? Object.entries(valoresPl).filter(([, v]) => Math.abs(v - faltando) < 0.005)
        .map(([k, v]) => ({ campo: k, valor: v }))
      : [];

    return Response.json({
      ok: true,
      empresa,
      filial,
      duracaoMs: Date.now() - inicio,
      resumo: {
        produtosConsultados: produtos.length,
        somaDeclaradaPelaApiDeCustos: somaTc,
        faturamentoDoMes: faturamentoDaFilial?.valorTotal ?? null,
        competencia: `${String(mes).padStart(2, "0")}/${ano}`,
        portalInformou: esperado,
        faltando,
        ondeEstaOQueFalta,
        // Sem candidato, o próximo passo é o suporte do OEM: nem o endpoint de
        // custos nem o do portal expõem o valor que a tela cobra.
        conclusao: !esperado
          ? "Sem `esperado` no corpo — só os payloads crus."
          : faltando === 0
            ? "A API de custos já fecha com o portal nesta filial."
            : ondeEstaOQueFalta.length
              ? "O valor que falta existe no detalhe do pdvlegal — dá para corrigir a carga."
              : "O valor que falta não aparece em nenhum dos dois endpoints.",
      },
      catalogoProdutos: catalogo,
      modulosPorProduto,
      detalhePdvLegal: detalhePl,
      faturamento: {
        http: relatorio.http,
        competencia: `${String(mes).padStart(2, "0")}/${ano}`,
        totaisDoOem: {
          valorTotalGeral: rel.valorTotalGeral ?? null,
          valorGeralLicenciamentos: rel.valorGeralLicenciamentos ?? null,
          valorGeralUsoPlataforma: rel.valorGeralUsoPlataforma ?? null,
        },
        empresa: empresaDaFilial,
        filial: faturamentoDaFilial,
      },
    }, { headers: cors });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oem-diagnostico-filial]", msg);
    return Response.json({ ok: false, mensagem: msg }, { status: 500, headers: cors });
  }
});
