// ============================================================================
// oem-licenca-criar — cria uma licença NOVA no OEM: grupo novo (licença
// avulsa) ou filial nova dentro de um grupo que já existe.
//
// POR QUE ELA É ASSIM (24/09/2026)
//
// Até aqui o DoctorSaaS só mexia em licença que já existia. A API documentada
// (api.tabletcloud.com.br/Help) tem as duas rotas de criação:
//
//   POST /licenciamento/minhaslicencas/saveGrupoEconomico  {nome, codproduto, cpF_CNPJ, email}
//   POST /licenciamento/minhaslicencas/saveFilial           a filial inteira
//
// e a documentação NÃO responde duas coisas que decidem o desenho:
//   1. se `codloja = 0` cria filial nova (em vez de alterar alguma);
//   2. se a resposta devolve o código criado — ela só promete "201 ou 400".
//
// Por isso esta função não confia na resposta para saber o que nasceu. Ela
// fotografa a listagem ANTES (`minhaslicencas/0/{filtro}`), cria, fotografa
// DEPOIS e devolve a diferença. E devolve as respostas cruas das duas rotas:
// o primeiro teste real é quem vai dizer o formato.
//
// Três ações:
//   listas  — tipos de negócio, detalhes, origens da venda e produtos. Leitura.
//   buscar  — a listagem de licenças com um filtro. Leitura.
//   criar   — com `simular: true` monta e devolve os payloads SEM enviar.
//
// Não existe modo de teste no parceiro: `criar` sem `simular` cria uma licença
// de verdade, que passa a ser cobrada. Quem chama tem que ter aprovação.
//
// Autentica por x-api-key, igual às irmãs: quem chama é o DoctorSaaS.
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
  username: string; password: string;
  clientId: string; clientSecret: string; method: string;
};

type Chamada = { url: string; http: number | null; ok: boolean; corpo?: unknown; erro?: string };

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

// O host documentado exige token PRÓPRIO: o do pdvlegal responde 401 aqui.
async function obterToken(creds: Creds): Promise<string> {
  const resp = await fetch(`${LEITURA_BASE}/token`, {
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
    throw new Error(`Autenticação em ${LEITURA_BASE} falhou (HTTP ${resp.status}): ${t.slice(0, 180)}`);
  }
  const j = await resp.json();
  if (!j?.access_token) throw new Error("Resposta de token sem access_token.");
  return j.access_token as string;
}

/** Chamada que nunca derruba a função: falha vira registro, com o corpo cru. */
async function chamar(token: string, url: string, corpo?: unknown): Promise<Chamada> {
  try {
    const resp = await fetch(url, {
      method: corpo === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text().catch(() => "");
    let json: unknown = texto;
    try { json = JSON.parse(texto); } catch { /* texto cru já é a informação */ }
    return { url, http: resp.status, ok: resp.ok, corpo: json };
  } catch (e) {
    return { url, http: null, ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const inteiro = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

type LicencaListada = { grupo: number; nomegrupo: string; filial: number; nomefilial: string; cpf_cnpj: string };

/** Achata `minhaslicencas/0/{filtro}` em pares grupo × filial. */
function achatar(corpo: unknown): LicencaListada[] {
  const data = (corpo as Record<string, unknown>)?.data;
  const out: LicencaListada[] = [];
  for (const g of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const grupo = inteiro(g.codgrupo);
    if (grupo == null) continue;
    for (const f of (Array.isArray(g.filiais) ? g.filiais : []) as Record<string, unknown>[]) {
      const filial = inteiro(f.codfilial);
      if (filial == null) continue;
      out.push({
        grupo, nomegrupo: String(g.nomegrupo ?? ""),
        filial, nomefilial: String(f.nomefilial ?? ""),
        cpf_cnpj: soDigitos(f.cpf_cnpj ?? g.cpf_cnpj),
      });
    }
  }
  return out;
}

/**
 * Grupo e loja que o OEM devolve ao salvar. Medido em 26/09/2026: as duas rotas
 * respondem `{CodigoGrupoEconomico, CodigoFilial, ...}` com 201.
 */
function codigosDaResposta(corpo: unknown): { grupo: number | null; filial: number | null } {
  const r = (corpo ?? {}) as Record<string, unknown>;
  return {
    grupo: inteiro(r.CodigoGrupoEconomico ?? r.codigoGrupoEconomico ?? r.codgrupo),
    filial: inteiro(r.CodigoFilial ?? r.codigoFilial ?? r.codfilial),
  };
}

/**
 * A resposta de criação traz a SENHA do usuário master e o token de webservice
 * da licença. Nada disso sai daqui: a resposta vai para a fila do DoctorSaaS,
 * que outras pessoas leem.
 */
function semSegredos(c: Chamada | null): Chamada | null {
  if (!c || !c.corpo || typeof c.corpo !== "object") return c;
  const corpo = { ...(c.corpo as Record<string, unknown>) };
  for (const k of Object.keys(corpo)) {
    if (/senha|password|token/i.test(k)) corpo[k] = "[removido]";
  }
  return { ...c, corpo };
}

async function listar(token: string, filtro: string) {
  const r = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/0/${encodeURIComponent(filtro)}`);
  return { chamada: r, licencas: r.ok ? achatar(r.corpo) : [] };
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
      return Response.json({ ok: false, mensagem: "Chave inválida." }, { status: 401, headers: cors });
    }

    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    const acao = String(corpo.acao ?? "");
    const token = await obterToken(await carregarCreds(db, String(registro.tenant_id)));

    // ------------------------------------------------------------------ listas
    if (acao === "listas") {
      const [tipos, origens, produtos] = await Promise.all([
        chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/tipodenegocio`),
        chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/origemdavenda`),
        chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`),
      ]);
      // Detalhe depende do tipo. São poucos tipos: uma chamada por tipo.
      const listaTipos = (Array.isArray(tipos.corpo) ? tipos.corpo : []) as Record<string, unknown>[];
      const detalhes: Record<string, unknown> = {};
      await Promise.all(listaTipos.map(async (t) => {
        const cod = String(t.codigo ?? "");
        if (!cod) return;
        const r = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/detalhestipodenegocio/${encodeURIComponent(cod)}`);
        detalhes[cod] = r.ok ? r.corpo : { http: r.http, erro: r.erro ?? r.corpo };
      }));
      return Response.json({
        ok: tipos.ok && origens.ok && produtos.ok,
        tipos_negocio: tipos.corpo, detalhes_tipo_negocio: detalhes,
        origens_venda: origens.corpo, produtos: produtos.corpo,
        duracaoMs: Date.now() - inicio,
      }, { headers: cors });
    }

    // ------------------------------------------------------------------ buscar
    if (acao === "buscar") {
      const filtro = String(corpo.filtro ?? "").trim();
      if (!filtro) {
        return Response.json({ ok: false, mensagem: "Informe o filtro." }, { status: 400, headers: cors });
      }
      const { chamada, licencas } = await listar(token, filtro);
      return Response.json({ ok: chamada.ok, licencas, cru: chamada, duracaoMs: Date.now() - inicio }, { headers: cors });
    }

    // ------------------------------------------------------------------- criar
    if (acao === "criar") {
      const simular = corpo.simular === true;
      const modo = String(corpo.modo ?? "");
      const produto = inteiro(corpo.produto_codigo);
      const nomeLoja = String(corpo.nome_loja ?? "").trim();
      const cnpjLoja = soDigitos(corpo.cnpj_loja);
      const tipo = inteiro(corpo.tipo_negocio);
      const detalhe = inteiro(corpo.detalhe_tipo_negocio);
      const origem = inteiro(corpo.origem_venda);
      const pedidos = (Array.isArray(corpo.modulos) ? corpo.modulos : []) as Record<string, unknown>[];

      const faltando: string[] = [];
      if (modo !== "avulsa" && modo !== "grupo") faltando.push("modo (avulsa|grupo)");
      if (produto == null) faltando.push("produto_codigo");
      if (!nomeLoja) faltando.push("nome_loja");
      if (cnpjLoja.length !== 14 && cnpjLoja.length !== 11) faltando.push("cnpj_loja");
      if (tipo == null) faltando.push("tipo_negocio");
      if (detalhe == null) faltando.push("detalhe_tipo_negocio");
      if (origem == null) faltando.push("origem_venda");
      if (!pedidos.length) faltando.push("modulos");
      let grupo = modo === "grupo" ? inteiro(corpo.grupo_codigo) : null;
      if (modo === "grupo" && grupo == null) faltando.push("grupo_codigo");
      // Grupo existente: o nome é como a listagem o acha. Avulsa: vira o nome do grupo novo.
      const nomeGrupo = String(corpo.nome_grupo ?? (modo === "avulsa" ? nomeLoja : "")).trim();
      const email = String(corpo.email ?? "").trim();
      if (modo === "avulsa" && !email) faltando.push("email");
      if (faltando.length) {
        return Response.json({ ok: false, mensagem: `Faltou: ${faltando.join(", ")}.` }, { status: 400, headers: cors });
      }

      // Preço de TABELA de cada módulo: a mesma rota dos módulos da licença, com
      // grupo e loja 0. É o que uma licença nova passa a custar.
      const tabela = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/modulos/${produto}/0/0`);
      const catalogo = new Map<number, Record<string, unknown>>();
      for (const m of ((tabela.corpo as Record<string, unknown>)?.modulos ?? []) as Record<string, unknown>[]) {
        const c = inteiro(m.codigo);
        if (c != null) catalogo.set(c, m);
      }
      if (!tabela.ok || catalogo.size === 0) {
        return Response.json({ ok: false, mensagem: "Não consegui ler a tabela de módulos do produto no OEM.", tabela },
          { status: 502, headers: cors });
      }
      const produtos = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`);
      const nomeProduto = String(((Array.isArray(produtos.corpo) ? produtos.corpo : []) as Record<string, unknown>[])
        .find((p) => inteiro(p.codigo) === produto)?.nome ?? "");

      const agora = new Date().toISOString();
      const desconhecidos: number[] = [];
      const modulos = pedidos.flatMap((p) => {
        const cod = inteiro(p.codigo);
        const qtd = Math.max(1, inteiro(p.quantidade) ?? 1);
        const cat = cod == null ? undefined : catalogo.get(cod);
        if (cod == null || !cat) { if (cod != null) desconhecidos.push(cod); return []; }
        const unit = Number(cat.valorUnitario ?? cat.valor_unitario ?? cat.valor ?? 0) || 0;
        return [{
          codigo: cod, codproduto: produto, nome: String(cat.nome ?? ""), ativo: true,
          datacadastro: agora, datavalidade: null,
          quantidade: qtd, valorUnitario: unit, valorTotal: Math.round(unit * qtd * 100) / 100,
        }];
      });
      if (desconhecidos.length) {
        return Response.json({ ok: false, mensagem: `Módulos fora da tabela do produto no OEM: ${desconhecidos.join(", ")}.` },
          { status: 400, headers: cors });
      }
      const qtdDe = (cod: number) => modulos.find((m) => m.codigo === cod)?.quantidade ?? 0;

      const payloadGrupo = modo === "avulsa"
        ? { nome: nomeGrupo, codproduto: produto, cpF_CNPJ: cnpjLoja, email }
        : null;
      // codLoja 0 CRIA uma loja; o código de uma loja existente ATUALIZA ela.
      const montarFilial = (codGrupo: number | null, nomeGrupoOem?: string, codLoja = 0) => ({
        codloja: codLoja,
        nomeloja: nomeLoja,
        cnpJloja: cnpjLoja,
        codgrupoeconomico: codGrupo ?? 0,
        // O nome como o OEM guarda vence o que o DoctorSaaS mandou.
        nomegrupo: nomeGrupoOem || nomeGrupo,
        codproduto: produto,
        nomeproduto: nomeProduto,
        valorTotal: Math.round(modulos.reduce((s, m) => s + m.valorTotal, 0) * 100) / 100,
        modulos,
        codigoTipoNegocio: tipo,
        codigoDetalhesTipoNegocio: detalhe,
        codigoOrigemVenda: origem,
        bloquearLicenca: false,
        desativarLicenca: false,
        // Na leitura documentada 9 e 10 são módulos da lista E campos próprios;
        // mandar só um deles deixaria o contador do portal em zero.
        usuariosAdicionais: qtdDe(9),
        pdvComandas: qtdDe(10),
      });

      // Filial em grupo existente se acha pelo CÓDIGO do grupo; grupo novo, pelo
      // CNPJ que ele vai carregar. Nome NÃO serve: medido em 25/09, o nome
      // completo "CAMPINA VERDE COM. DE RACOES LTDA ME" volta 404, enquanto
      // "4517" e o CNPJ acham o grupo.
      const filtroBusca = modo === "grupo" ? String(grupo) : cnpjLoja;

      // Foto de ANTES: é contra ela que se descobre o que nasceu. Foto vazia por
      // falha de busca faria a filial ANTIGA parecer nova — então, no grupo
      // existente, o grupo tem que aparecer nela.
      const antes = await listar(token, filtroBusca);
      if (modo === "grupo") {
        const doGrupo = antes.licencas.filter((l) => l.grupo === grupo);
        if (!antes.chamada.ok || doGrupo.length === 0) {
          return Response.json({
            ok: false, etapa: "busca_antes",
            mensagem: `Não achei o grupo ${grupo} na listagem do OEM. Nada foi criado.`,
            busca_antes: antes.chamada,
          }, { status: 409, headers: cors });
        }
      } else if (!antes.chamada.ok && antes.chamada.http !== 404) {
        // Avulsa: 404 é "nenhuma licença com este CNPJ", que é o esperado.
        return Response.json({
          ok: false, etapa: "busca_antes",
          mensagem: "A listagem do OEM falhou antes de criar. Nada foi criado.",
          busca_antes: antes.chamada,
        }, { status: 502, headers: cors });
      }

      const nomeGrupoOem = antes.licencas.find((l) => l.grupo === grupo)?.nomegrupo;

      // Duplo clique, ou reenvio depois de um erro que na verdade gravou:
      // mesma loja no mesmo grupo já listada = não cria outra.
      const mesmoNome = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();
      const repetida = antes.licencas.find((l) =>
        mesmoNome(l.nomefilial, nomeLoja)
        && (grupo != null ? l.grupo === grupo : mesmoNome(l.nomegrupo, nomeGrupo)));
      if (repetida && corpo.permitir_repetida !== true) {
        return Response.json({
          ok: false, ja_existe: true, grupo_codigo: repetida.grupo, filial_codigo: repetida.filial,
          mensagem: `Já existe a loja ${repetida.nomefilial} (${repetida.grupo}/${repetida.filial}) com este CNPJ no OEM.`,
        }, { status: 409, headers: cors });
      }

      if (simular) {
        return Response.json({
          ok: true, simulado: true,
          passos: modo === "avulsa"
            ? ["saveGrupoEconomico: cria o grupo e a matriz",
               "saveFilial com o código da matriz: aplica módulos e códigos de negócio (atualiza, não cria)"]
            : [`saveFilial com codloja 0: cria UMA loja no grupo ${grupo}`],
          payload_grupo: payloadGrupo,
          payload_filial: montarFilial(grupo, nomeGrupoOem),
          filtro_da_busca: filtroBusca,
          listadas_antes: antes.licencas,
          busca_antes: { http: antes.chamada.http, ok: antes.chamada.ok },
          duracaoMs: Date.now() - inicio,
        }, { headers: cors });
      }

      // ===================================================================
      // ⚠️ `saveGrupoEconomico` JÁ CRIA A PRIMEIRA LOJA DO GRUPO (a matriz).
      //
      // Medido em 26/09/2026 no primeiro teste real (grupo 33430): a resposta
      // do grupo devolveu `CodigoGrupoEconomico: 33430` E `CodigoFilial: 40570`.
      // A documentação não diz isso. A primeira versão desta função chamava em
      // seguida `saveFilial` com `codloja: 0`, que CRIA outra loja — nasceram
      // duas licenças cobradas (40570 e 40571) para um pedido de licença avulsa.
      //
      // Então: avulsa = `saveGrupoEconomico` (grupo + matriz) e depois
      // `saveFilial` com o código DA MATRIZ, que atualiza em vez de criar.
      // `codloja: 0` só existe no modo grupo, e uma vez só.
      // ===================================================================
      let respostaGrupo: Chamada | null = null;
      let filialAlvo: number | null = null;   // loja a ATUALIZAR (avulsa: a matriz)

      if (modo === "avulsa") {
        respostaGrupo = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/saveGrupoEconomico`, payloadGrupo);
        if (!respostaGrupo.ok) {
          return Response.json({
            ok: false, etapa: "grupo", mensagem: "O OEM recusou criar o grupo.",
            resposta_grupo: semSegredos(respostaGrupo),
          }, { status: 502, headers: cors });
        }
        const cod = codigosDaResposta(respostaGrupo.corpo);
        grupo = cod.grupo;
        filialAlvo = cod.filial;

        // Sem os códigos na resposta, a listagem diz qual grupo nasceu e qual
        // é a loja dele. Grupo novo tem exatamente uma loja: a matriz.
        if (grupo == null || filialAlvo == null) {
          const conhecidos = new Set(antes.licencas.map((l) => l.grupo));
          const depoisGrupo = await listar(token, filtroBusca);
          const doNovo = depoisGrupo.licencas.filter((l) => !conhecidos.has(l.grupo));
          if (doNovo.length === 1) {
            grupo = doNovo[0].grupo;
            filialAlvo = doNovo[0].filial;
          }
        }
        if (grupo == null || filialAlvo == null) {
          // Grupo criado sem código achável: parar aqui é o que evita mexer na
          // loja errada. Nada mais é enviado; gente olha a resposta.
          return Response.json({
            ok: false, etapa: "grupo_sem_codigo",
            mensagem: "O OEM aceitou o grupo, mas não consegui descobrir o código dele e da matriz. Os módulos NÃO foram aplicados.",
            resposta_grupo: semSegredos(respostaGrupo),
          }, { status: 502, headers: cors });
        }
      }

      // ---- módulos e códigos de negócio na loja
      // Avulsa: ATUALIZA a matriz que o grupo criou. Grupo existente: CRIA uma loja.
      const payloadFilial = montarFilial(grupo, nomeGrupoOem, filialAlvo ?? 0);
      const respostaFilial = await chamar(token, `${LEITURA_BASE}/licenciamento/minhaslicencas/saveFilial`, payloadFilial);
      if (!respostaFilial.ok) {
        return Response.json({
          ok: false, etapa: "filial", grupo_codigo: grupo, filial_codigo: filialAlvo,
          mensagem: filialAlvo
            ? `O grupo e a matriz foram criados (${grupo}/${filialAlvo}), mas o OEM recusou aplicar os módulos.`
            : "O OEM recusou criar a filial.",
          resposta_grupo: semSegredos(respostaGrupo), resposta_filial: semSegredos(respostaFilial),
          payload_filial: payloadFilial,
        }, { status: 502, headers: cors });
      }

      const codFilial = codigosDaResposta(respostaFilial.corpo);
      // Na atualização o código tem que voltar IGUAL ao da matriz. Diferente
      // quer dizer que o OEM criou outra loja em vez de atualizar.
      const filialFinal = filialAlvo ?? codFilial.filial;

      // ---- conferência: quantas lojas nasceram de verdade
      // Avulsa: o grupo tem que ter UMA loja. Grupo existente: uma a mais do que
      // antes. Qualquer outro número é licença sobrando e cobrando, e vai como
      // `alerta` para o DoctorSaaS mostrar.
      const conhecidas = new Set(antes.licencas.map((l) => `${l.grupo}/${l.filial}`));
      let depois = antes;
      let novas: LicencaListada[] = [];
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500));
        depois = await listar(token, filtroBusca);
        novas = depois.licencas.filter((l) => l.grupo === grupo && !conhecidas.has(`${l.grupo}/${l.filial}`));
        if (novas.length >= 1) break;
      }
      const alertas: string[] = [];
      if (filialAlvo != null && codFilial.filial != null && codFilial.filial !== filialAlvo) {
        alertas.push(`O OEM devolveu a loja ${codFilial.filial} ao atualizar a matriz ${filialAlvo}: pode ter criado uma loja a mais.`);
      }
      if (novas.length > 1) {
        alertas.push(`Nasceram ${novas.length} lojas no grupo ${grupo} (${novas.map((n) => n.filial).join(", ")}), era para ser uma. Desative a que sobrou no portal.`);
      }

      return Response.json({
        ok: filialFinal != null,
        grupo_codigo: grupo,
        filial_codigo: filialFinal,
        confirmada_na_listagem: novas.some((n) => n.filial === filialFinal),
        alerta: alertas.length ? alertas.join(" ") : null,
        resposta_grupo: semSegredos(respostaGrupo),
        resposta_filial: semSegredos(respostaFilial),
        payload_filial: payloadFilial,
        listadas_depois: depois.licencas,
        duracaoMs: Date.now() - inicio,
      }, { headers: cors });
    }

    return Response.json({ ok: false, mensagem: "acao deve ser listas, buscar ou criar." }, { status: 400, headers: cors });
  } catch (e) {
    return Response.json({ ok: false, mensagem: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: cors });
  }
});
