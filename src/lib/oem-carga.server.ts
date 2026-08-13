// ============================================================================
// Motor de carga do OEM — retomável, em lotes (server-only).
//
// ---------------------------------------------------------------------------
// MAPA DE FONTES (medido contra as duas APIs em 12/08/2026, não suposto)
// ---------------------------------------------------------------------------
// O OEM expõe DOIS hosts, com as mesmas credenciais, e eles não são iguais:
//
//   api.tabletcloud.com.br  = LEITURA / relatório  (é o host documentado)
//   api.pdvlegal.com.br     = ESCRITA (criar/atualizar filial)
//
// | Dado                     | Fonte                                          |
// |--------------------------|------------------------------------------------|
// | Enumeração grupo+filiais | TC  /licenciamento/minhaslicencas/{pagina}/    |
// | Ativo / Desativado       | TC  filiais[].ativo   (equivale a status AT/IN)|
// | Custo e módulos          | TC  /licenciamento/minhaslicencas/modulos/...  |
// | Bloqueado                | PL  /v1/licenciamento/{emp}/{fil} .bloqueado   |
//
// Por que NÃO usamos a listagem do pdvlegal (que era o que o código fazia):
//   - o `ativo` dela é inconsistente — devolvia false para a PARRILLA GOLD
//     enquanto o próprio detalhe do pdvlegal dizia status "AT", bloqueado false;
//   - o `modulos[]` do detalhe vem INCOMPLETO (para a PARRILLA trazia 2 de 5,
//     faltando "Gestao" R$ 39,90 e "PDV/Comandas" 2×R$ 10,00). O total fechava,
//     a composição não. Era daí que saía o módulo sintético "Licença PDV"
//     calculado por resíduo — um número que o OEM nunca cobrou.
//
// `ativo` e `bloqueado` são dimensões INDEPENDENTES: medido em 8 filiais, entre
// as desativadas (IN) havia bloqueadas e não bloqueadas. São as duas flags que
// o endpoint de update expõe: desativarLicenca e bloquearLicenca.
//
// ---------------------------------------------------------------------------
// POR QUE EM LOTES
// ---------------------------------------------------------------------------
// São 2 chamadas ao OEM por filial (~5.100 no total). Isso não cabe em uma
// requisição em runtime serverless — Cloudflare Workers permite 50 subrequisições
// no plano free e 1.000 no pago — e o pdvlegal responde 429 por volume.
//   fase "listando"   — pagina a listagem e ENFILEIRA (empresa, filial)
//   fase "detalhando" — drena a fila em lotes, gravando em clientes_oem
//   fase "concluido"  — fecha o log
// Cada avancarCargaOem() faz UM passo e devolve quanto falta. Quem chama repete.
// Um passo que morre não perde trabalho: a fila é o estado.
// ============================================================================
import {
  loadTenantCreds,
  obterTokenTenant,
  criarTokenHolderTenant,
  inserirLog,
  finalizarLog,
  type TenantCreds,
} from "@/lib/tenant-oem.server";
import { parseModulosOficiais, type TokenHolder } from "@/lib/doctoroem.functions";

/** Host de LEITURA. O `oem_api_base_url` do tenant continua sendo o de escrita. */
const LEITURA_BASE = (process.env.OEM_API_LEITURA_URL ?? "https://api.tabletcloud.com.br").replace(
  /\/+$/,
  "",
);

function limite(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : padrao;
}
const PAGINAS_POR_PASSO = () => limite("OEM_PAGINAS_POR_PASSO", 10);
const CLIENTES_POR_PASSO = () => limite("OEM_CLIENTES_POR_PASSO", 60);
// Medido: 6 filiais em paralelo (~6 req/s) levou 429 no pdvlegal depois de ~100.
// 3 com 1s de pausa fica em ~3 req/s, e o oemGet ainda negocia se apertar.
const CHUNK_PARALELO = limite("OEM_PARALELO", 3);
const PAUSA_MS = limite("OEM_PAUSA_MS", 1000);
const RETRY_429 = 3;

/** O OEM insistiu no 429 mesmo após as esperas. Aborta o passo, sem gravar lixo. */
class RateLimitOem extends Error {
  constructor(descricao: string, corpo: string) {
    super(
      `OEM manteve o 429 em ${descricao} após ${RETRY_429} esperas (2s+4s+8s).` +
        (corpo
          ? ` Resposta da API: ${corpo}`
          : " A API não explicou o motivo nem mandou Retry-After."),
    );
    this.name = "RateLimitOem";
  }
}

// ------------------------------------------------------------------ tipos

export type PassoCarga = {
  runId: string | null;
  fase: "listando" | "detalhando" | "concluido" | "erro";
  concluido: boolean;
  enfileirados: number;
  processados: number;
  restantes: number;
  inseridos: number;
  atualizados: number;
  falhas: number;
  duracaoMs: number;
  mensagem: string;
};

type RunRow = {
  id: string;
  log_id: string | null;
  origem: string;
  fase: string;
  proxima_pagina: number;
  grupos_lidos: number;
  total_registros: number | null;
  produtos: Record<string, string> | null;
  enfileirados: number;
  processados: number;
  inseridos: number;
  atualizados: number;
  falhas: number;
};

/** O que a listagem do tabletcloud entrega e guardamos na fila. */
type ResumoFilial = {
  nomegrupo: string | null;
  nomefilial: string | null;
  cpf_cnpj: string | null;
  ativo: boolean;
  matriz: boolean;
  email: string | null;
  datacadastro: string | null;
};

type FilaRow = {
  id: number;
  empresa_codigo: string;
  filial_codigo: string;
  produto: string | null;
  numero_filiais: number | null;
  resumo: ResumoFilial | null;
};

type GrupoTC = {
  codgrupo?: number;
  ativo?: boolean;
  nomegrupo?: string;
  cpf_cnpj?: string;
  produto?: string;
  qtdLojasAtivas?: number;
  qtdLojasDesativadas?: number;
  filiais?: Array<{
    ativo?: boolean;
    matriz?: boolean;
    codfilial?: number;
    nomefilial?: string;
    cpf_cnpj?: string;
    datacadastro?: string;
    email?: string;
  }>;
};

// ---------------------------------------------------------------- helpers

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function inteiro(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * GET autenticado que NEGOCIA o ritmo em vez de desistir.
 * 401 → renova o token uma vez. 429 → respeita Retry-After (ou 2s/4s/8s) e
 * repete; só desiste do passo depois de esgotar as tentativas.
 */
export async function oemGet(holder: TokenHolder, url: string, descricao: string): Promise<Response> {
  let espera = 2000;
  for (let tentativa = 0; ; tentativa++) {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
    });

    if (resp.status === 401 && holder.refresh && tentativa === 0) {
      await holder.refresh("401");
      continue;
    }
    if (resp.status !== 429) return resp;

    // O corpo do 429 é a única pista do limite real — a API não manda Retry-After.
    const corpo = (await resp.text().catch(() => "")).trim().slice(0, 300);
    if (tentativa >= RETRY_429) throw new RateLimitOem(descricao, corpo);

    const cabecalho = Number(resp.headers.get("retry-after"));
    const pausa = Number.isFinite(cabecalho) && cabecalho > 0 ? cabecalho * 1000 : espera;
    console.warn(
      `[oem-carga] 429 em ${descricao} — aguardando ${Math.round(pausa / 1000)}s ` +
        `(tentativa ${tentativa + 1}/${RETRY_429}).`,
    );
    await new Promise((r) => setTimeout(r, pausa));
    espera = Math.min(espera * 2, 30_000);
  }
}

/**
 * Token do host de LEITURA. Não usa o cache de oem_token_cache, que guarda o
 * token do host de escrita — são hosts distintos e um token não vale no outro.
 * Vale ~12h e um passo dura segundos, então basta um por passo.
 */
export async function tokenLeitura(creds: TenantCreds): Promise<TokenHolder> {
  const pedir = async () => {
    const resp = await fetch(`${LEITURA_BASE}/token`, {
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
      const corpo = await resp.text().catch(() => "");
      throw new Error(
        `Falha na autenticação em ${LEITURA_BASE} (HTTP ${resp.status}): ${corpo.slice(0, 180)}`,
      );
    }
    const json = (await resp.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Resposta de token sem access_token.");
    return json.access_token;
  };

  const holder: TokenHolder = { value: await pedir(), clear: () => (holder.value = "") };
  holder.refresh = async () => {
    holder.value = await pedir();
  };
  return holder;
}

// ------------------------------------------------- chamadas às duas APIs

/** Listagem oficial. `pagina` começa em 1 (0 devolve a página 1). */
async function buscarPagina(
  holder: TokenHolder,
  pagina: number,
): Promise<{ grupos: GrupoTC[]; totalFiliais: number | null }> {
  const alvo = `listagem página ${pagina}`;
  const resp = await oemGet(holder, `${LEITURA_BASE}/licenciamento/minhaslicencas/${pagina}/`, alvo);
  if (!resp.ok) throw new Error(`Listagem do OEM HTTP ${resp.status} na ${alvo}.`);
  const json = (await resp.json().catch(() => null)) as
    | { data?: GrupoTC[]; total?: number }
    | null;
  if (!json || !Array.isArray(json.data)) throw new Error(`Listagem do OEM inválida na ${alvo}.`);
  return { grupos: json.data, totalFiliais: typeof json.total === "number" ? json.total : null };
}

/** Catálogo de produtos (nome → código), necessário para pedir os módulos. */
export async function buscarProdutos(holder: TokenHolder): Promise<Record<string, string>> {
  const resp = await oemGet(holder, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`, "produtos");
  if (!resp.ok) throw new Error(`Catálogo de produtos HTTP ${resp.status}.`);
  const lista = (await resp.json().catch(() => [])) as Array<{ codigo?: string; nome?: string }>;
  const mapa: Record<string, string> = {};
  for (const p of Array.isArray(lista) ? lista : []) {
    if (p.nome && p.codigo) mapa[String(p.nome).trim().toUpperCase()] = String(p.codigo);
  }
  return mapa;
}

/** Módulos oficiais + valor total da filial. É a fonte de custo. */
export async function buscarModulos(
  holder: TokenHolder,
  codProduto: string,
  codGrupo: number,
  codFilial: number,
): Promise<{ valorTotal: number | null; modulos: Record<string, unknown>[] }> {
  const alvo = `módulos ${codProduto}/${codGrupo}/${codFilial}`;
  const url = `${LEITURA_BASE}/licenciamento/minhaslicencas/modulos/${encodeURIComponent(
    codProduto,
  )}/${codGrupo}/${codFilial}`;
  const resp = await oemGet(holder, url, alvo);
  if (!resp.ok) throw new Error(`Módulos do OEM HTTP ${resp.status} em ${alvo}.`);
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw) throw new Error(`Módulos do OEM vieram vazios em ${alvo}.`);
  const valorTotal = Number(raw.valorTotal);
  return {
    valorTotal: Number.isFinite(valorTotal) ? valorTotal : null,
    modulos: parseModulosOficiais(raw),
  };
}

/** Único dado que só existe no host de escrita: o bloqueio da licença. */
async function buscarBloqueio(
  creds: TenantCreds,
  holder: TokenHolder,
  codGrupo: number,
  codFilial: number,
): Promise<{ bloqueado: boolean; usuarios: number | null; pdvComandas: number | null }> {
  const alvo = `licença ${codGrupo}/${codFilial}`;
  const resp = await oemGet(holder, `${creds.baseUrl}/v1/licenciamento/${codGrupo}/${codFilial}`, alvo);
  if (!resp.ok) throw new Error(`Detalhe da licença HTTP ${resp.status} em ${alvo}.`);
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  const filial = (raw?.filial ?? {}) as Record<string, unknown>;
  return {
    bloqueado: filial.bloqueado === true,
    usuarios: inteiro(filial.usuarios),
    pdvComandas: inteiro(filial.pdvComandas),
  };
}

// ------------------------------------------------------------ run e fila

async function salvarRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  const db = await admin();
  const { error } = await db
    .from("oem_sync_runs")
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq("id", runId);
  if (error) console.error("[oem-carga] falha ao salvar run:", error.message);
}

async function contar(runId: string, status: "pendente" | "erro"): Promise<number> {
  const db = await admin();
  const { count } = await db
    .from("oem_sync_fila")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", status);
  return count ?? 0;
}

async function obterOuCriarRun(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial",
): Promise<RunRow> {
  const db = await admin();

  const buscarAtivo = async () => {
    const { data } = await db
      .from("oem_sync_runs")
      .select("*")
      .eq("tenant_id", tenantId)
      .in("fase", ["listando", "detalhando"])
      .order("iniciado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as RunRow | null) ?? null;
  };

  const existente = await buscarAtivo();
  if (existente) return existente;

  // Um run pode ter sido fechado e DEPOIS receber linhas de volta na fila
  // (reprocessamento de erro). Reabre em vez de refazer a enumeração inteira.
  const { data: ultimo } = await db
    .from("oem_sync_runs")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (ultimo && (await contar((ultimo as RunRow).id, "pendente")) > 0) {
    await salvarRun((ultimo as RunRow).id, { fase: "detalhando", finalizado_em: null });
    return { ...(ultimo as RunRow), fase: "detalhando" };
  }

  const logId = await inserirLog(tenantId, origem, "processando", {
    mensagem: "Carga iniciada — enumerando clientes no OEM.",
  });
  const { data, error } = await db
    .from("oem_sync_runs")
    .insert({ tenant_id: tenantId, origem, log_id: logId, fase: "listando", proxima_pagina: 1 })
    .select("*")
    .maybeSingle();

  if (error) {
    const concorrente = await buscarAtivo();
    if (concorrente) return concorrente;
    throw new Error(`oem_sync_runs: ${error.message}`);
  }
  return data as RunRow;
}

// ------------------------------------------------------- fase 1: listando

async function passoListagem(
  tenantId: string,
  run: RunRow,
  leitura: TokenHolder,
): Promise<{ enfileirados: number; terminou: boolean }> {
  const db = await admin();
  let pagina = Math.max(1, run.proxima_pagina);
  let gruposLidos = run.grupos_lidos;
  let totalFiliais = run.total_registros;
  let enfileirados = 0;
  let terminou = false;

  for (let p = 0; p < PAGINAS_POR_PASSO(); p++) {
    const { grupos, totalFiliais: total } = await buscarPagina(leitura, pagina);
    if (total != null) totalFiliais = total;

    if (!grupos.length) {
      terminou = true;
      break;
    }
    gruposLidos += grupos.length;
    pagina += 1;

    const itens: Record<string, unknown>[] = [];
    for (const grupo of grupos) {
      const codGrupo = inteiro(grupo.codgrupo);
      if (codGrupo == null) continue;
      const numFiliais = (grupo.qtdLojasAtivas ?? 0) + (grupo.qtdLojasDesativadas ?? 0);
      const filiais = Array.isArray(grupo.filiais) ? grupo.filiais : [];

      if (!filiais.length) {
        // Entra na fila como erro para APARECER no diagnóstico. O código antigo
        // descartava esses grupos em silêncio e eles sumiam da contagem.
        itens.push({
          run_id: run.id,
          tenant_id: tenantId,
          empresa_codigo: String(codGrupo),
          filial_codigo: "",
          produto: grupo.produto ?? null,
          numero_filiais: numFiliais || null,
          status: "erro",
          erro: "Grupo sem filiais na listagem do OEM — não há codfilial para consultar.",
          processado_em: new Date().toISOString(),
        });
        continue;
      }

      for (const filial of filiais) {
        const codFilial = inteiro(filial?.codfilial);
        if (codFilial == null) continue;
        const resumo: ResumoFilial = {
          nomegrupo: grupo.nomegrupo ?? null,
          nomefilial: filial.nomefilial ?? null,
          cpf_cnpj: filial.cpf_cnpj ?? grupo.cpf_cnpj ?? null,
          // Fonte do status operacional: equivale ao AT/IN do detalhe.
          ativo: filial.ativo ?? grupo.ativo ?? true,
          matriz: filial.matriz ?? false,
          email: filial.email ?? null,
          datacadastro: filial.datacadastro ?? null,
        };
        itens.push({
          run_id: run.id,
          tenant_id: tenantId,
          empresa_codigo: String(codGrupo),
          filial_codigo: String(codFilial),
          produto: grupo.produto ?? null,
          numero_filiais: numFiliais || null,
          resumo,
          status: "pendente",
        });
      }
    }

    if (itens.length) {
      const { error } = await db
        .from("oem_sync_fila")
        // @ts-expect-error — payload dinâmico, validado em runtime
        .upsert(itens, {
          onConflict: "run_id,empresa_codigo,filial_codigo",
          ignoreDuplicates: true,
        });
      if (error) throw new Error(`oem_sync_fila: ${error.message}`);
      enfileirados += itens.filter((i) => i.status === "pendente").length;
    }
  }

  const totalNaFila = await contar(run.id, "pendente");
  await salvarRun(run.id, {
    proxima_pagina: pagina,
    grupos_lidos: gruposLidos,
    total_registros: totalFiliais,
    enfileirados: run.enfileirados + enfileirados,
    ...(terminou ? { fase: "detalhando" } : {}),
  });
  void totalNaFila;

  return { enfileirados, terminou };
}

// ----------------------------------------------------- fase 2: detalhando

async function obterProdutos(run: RunRow, leitura: TokenHolder): Promise<Record<string, string>> {
  if (run.produtos && Object.keys(run.produtos).length) return run.produtos;
  const mapa = await buscarProdutos(leitura);
  await salvarRun(run.id, { produtos: mapa });
  return mapa;
}

async function montarLinha(
  tenantId: string,
  item: FilaRow,
  produtos: Record<string, string>,
  creds: TenantCreds,
  leitura: TokenHolder,
  escrita: TokenHolder,
): Promise<Record<string, unknown>> {
  const codGrupo = Number(item.empresa_codigo);
  const codFilial = Number(item.filial_codigo);
  if (!Number.isFinite(codGrupo) || !Number.isFinite(codFilial)) {
    throw new Error(`Códigos inválidos: ${item.empresa_codigo}/${item.filial_codigo}`);
  }

  const resumo = item.resumo;
  if (!resumo) throw new Error("Linha da fila sem os dados da listagem.");

  const nomeProduto = String(item.produto ?? "").trim().toUpperCase();
  const codProduto = produtos[nomeProduto];
  if (!codProduto) {
    throw new Error(
      `Produto "${item.produto ?? "(vazio)"}" não está no catálogo do OEM — sem ele não dá para pedir os módulos.`,
    );
  }

  // Custo e módulos: fonte oficial, sem cálculo por resíduo.
  const { valorTotal, modulos } = await buscarModulos(leitura, codProduto, codGrupo, codFilial);
  // Bloqueio: única informação que não existe no host de leitura.
  const licenca = await buscarBloqueio(creds, escrita, codGrupo, codFilial);

  const quantidadeDe = (padrao: RegExp): number | null => {
    for (const m of modulos) {
      if (padrao.test(String(m.nome ?? "").toUpperCase())) {
        const ativo = m.ativo === undefined ? true : Boolean(m.ativo);
        if (!ativo) return 0;
        const q = Number(m.quantidade ?? 0);
        return Number.isFinite(q) ? q : null;
      }
    }
    return null;
  };

  const qtdPdv = quantidadeDe(/PDV|COMANDA/) ?? licenca.pdvComandas ?? 0;

  return {
    tenant_id: tenantId,
    empresa_codigo: String(codGrupo),
    filial_codigo: String(codFilial),
    cnpj_cpf: resumo.cpf_cnpj ?? `${codGrupo}/${codFilial}`,
    nome_fantasia: resumo.nomefilial ?? `Empresa ${codGrupo}/${codFilial}`,
    razao_social: resumo.nomefilial ?? null,
    grupo_economico: resumo.nomegrupo ?? null,
    produto_principal: item.produto ?? null,
    numero_filiais: item.numero_filiais ?? null,
    // Duas dimensões INDEPENDENTES — nunca mais uma cópia da outra.
    status: resumo.ativo ? "Ativo" : "Desativado",
    bloqueado: licenca.bloqueado,
    motivo_bloqueio: licenca.bloqueado ? "Bloqueado no OEM" : null,
    custo_total: valorTotal ?? 0,
    modulos_ativos: modulos,
    qtd_pdv: qtdPdv,
    qtd_pdv_comandas: qtdPdv,
    qtd_comandas: quantidadeDe(/MESA|FICHA/) ?? 0,
    usuarios_adicionais: quantidadeDe(/USU[ÁA]RIO/) ?? licenca.usuarios ?? 0,
    last_sync: new Date().toISOString(),
  };
}

async function passoDetalhe(
  tenantId: string,
  run: RunRow,
  creds: TenantCreds,
  leitura: TokenHolder,
  escrita: TokenHolder,
): Promise<{
  processados: number;
  inseridos: number;
  atualizados: number;
  falhas: number;
  barrado: string | null;
}> {
  const db = await admin();

  const { data: loteRaw, error: selErr } = await db
    .from("oem_sync_fila")
    .select("id, empresa_codigo, filial_codigo, produto, numero_filiais, resumo")
    .eq("run_id", run.id)
    .eq("status", "pendente")
    .order("id", { ascending: true })
    .limit(CLIENTES_POR_PASSO());
  if (selErr) throw new Error(`oem_sync_fila: ${selErr.message}`);

  const lote = (loteRaw ?? []) as unknown as FilaRow[];
  if (!lote.length)
    return { processados: 0, inseridos: 0, atualizados: 0, falhas: 0, barrado: null };

  const produtos = await obterProdutos(run, leitura);

  const { data: jaExistem } = await db
    .from("clientes_oem")
    .select("filial_codigo")
    .eq("tenant_id", tenantId)
    .in(
      "filial_codigo",
      lote.map((i) => i.filial_codigo),
    );
  const existentes = new Set(
    (jaExistem ?? []).map((r) => String((r as { filial_codigo: string }).filial_codigo)),
  );

  const okIds: number[] = [];
  const erros: Array<{ id: number; erro: string }> = [];
  let inseridos = 0;
  let atualizados = 0;
  let barrado: string | null = null;

  for (let i = 0; i < lote.length && !barrado; i += CHUNK_PARALELO) {
    const chunk = lote.slice(i, i + CHUNK_PARALELO);
    const resultados = await Promise.all(
      chunk.map(async (item) => {
        try {
          return {
            item,
            linha: await montarLinha(tenantId, item, produtos, creds, leitura, escrita),
          };
        } catch (err) {
          // 429 não é culpa do cliente: a linha continua PENDENTE.
          if (err instanceof RateLimitOem) return { item, barrado: err.message };
          return { item, erro: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    const bloqueio = resultados.find((r) => "barrado" in r) as { barrado: string } | undefined;
    if (bloqueio) barrado = bloqueio.barrado;

    const linhas = resultados.filter((r) => "linha" in r) as Array<{
      item: FilaRow;
      linha: Record<string, unknown>;
    }>;
    for (const r of resultados) {
      if ("erro" in r && r.erro) erros.push({ id: r.item.id, erro: String(r.erro).slice(0, 400) });
    }

    if (linhas.length) {
      const { error } = await db
        .from("clientes_oem")
        // @ts-expect-error — payload dinâmico, validado em runtime
        .upsert(linhas.map((l) => l.linha), { onConflict: "tenant_id,filial_codigo" });
      if (error) {
        // Um registro ruim derruba o INSERT do lote inteiro. Refaz um a um
        // para isolar quem realmente falhou — os demais entram normalmente.
        console.warn(`[oem-carga] lote rejeitado (${error.message}) — refazendo individualmente.`);
        for (const l of linhas) {
          const { error: erroUnico } = await db
            .from("clientes_oem")
            // @ts-expect-error — payload dinâmico
            .upsert([l.linha], { onConflict: "tenant_id,filial_codigo" });
          if (erroUnico) {
            erros.push({ id: l.item.id, erro: `Gravação: ${erroUnico.message}`.slice(0, 400) });
          } else {
            okIds.push(l.item.id);
            if (existentes.has(String(l.item.filial_codigo))) atualizados += 1;
            else inseridos += 1;
          }
        }
      } else {
        for (const l of linhas) {
          okIds.push(l.item.id);
          if (existentes.has(String(l.item.filial_codigo))) atualizados += 1;
          else inseridos += 1;
        }
      }
    }

    if (i + CHUNK_PARALELO < lote.length && !barrado) {
      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
  }

  const agora = new Date().toISOString();
  if (okIds.length) {
    await db
      .from("oem_sync_fila")
      .update({ status: "ok", erro: null, processado_em: agora })
      .in("id", okIds);
  }
  for (const e of erros) {
    await db
      .from("oem_sync_fila")
      .update({ status: "erro", erro: e.erro, processado_em: agora })
      .eq("id", e.id);
  }

  // `falhas` vem da FILA, não de um acumulador: linha que voltou para pendente
  // e depois deu certo não pode continuar contando como falha.
  const falhas = await contar(run.id, "erro");

  await salvarRun(run.id, {
    processados: run.processados + okIds.length + erros.length,
    inseridos: run.inseridos + inseridos,
    atualizados: run.atualizados + atualizados,
    falhas,
  });

  return { processados: okIds.length + erros.length, inseridos, atualizados, falhas, barrado };
}

// -------------------------------------------------------------- orquestra

/**
 * Executa UM passo da carga. Chame repetidamente até `concluido === true`.
 * Nunca escreve no OEM — só GET nos dois hosts.
 */
export async function avancarCargaOem(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial" = "manual",
): Promise<PassoCarga> {
  const inicio = Date.now();
  let run: RunRow | null = null;

  try {
    run = await obterOuCriarRun(tenantId, origem);
    const creds = await loadTenantCreds(tenantId);
    const leitura = await tokenLeitura(creds);

    if (run.fase === "listando") {
      const { enfileirados, terminou } = await passoListagem(tenantId, run, leitura);
      const restantes = await contar(run.id, "pendente");
      const total = run.enfileirados + enfileirados;
      return {
        runId: run.id,
        fase: terminou ? "detalhando" : "listando",
        concluido: false,
        enfileirados: total,
        processados: run.processados,
        restantes,
        inseridos: run.inseridos,
        atualizados: run.atualizados,
        falhas: run.falhas,
        duracaoMs: Date.now() - inicio,
        mensagem: terminou
          ? `Enumeração concluída: ${total} filial(is) na fila.`
          : `Enumerando… ${total} filial(is) na fila até agora.`,
      };
    }

    const escrita = criarTokenHolderTenant(
      tenantId,
      creds,
      await obterTokenTenant(tenantId, creds),
    );
    const passo = await passoDetalhe(tenantId, run, creds, leitura, escrita);
    const restantes = await contar(run.id, "pendente");
    const processados = run.processados + passo.processados;
    const inseridos = run.inseridos + passo.inseridos;
    const atualizados = run.atualizados + passo.atualizados;
    const falhas = passo.falhas;

    if (passo.barrado) {
      return {
        runId: run.id,
        fase: "erro",
        concluido: false,
        enfileirados: run.enfileirados,
        processados,
        restantes,
        inseridos,
        atualizados,
        falhas,
        duracaoMs: Date.now() - inicio,
        mensagem:
          `O OEM barrou as requisições. ${processados} de ${run.enfileirados} já foram ` +
          `processados e ${restantes} continuam na fila. Nada do que já foi feito se perde. ` +
          `Detalhe: ${passo.barrado}`,
      };
    }

    if (restantes === 0) {
      const mensagem =
        `${inseridos} novo(s), ${atualizados} atualizado(s), ${falhas} falha(s) ` +
        `de ${run.enfileirados} filial(is).`;
      await salvarRun(run.id, { fase: "concluido", finalizado_em: new Date().toISOString() });
      await finalizarLog(run.log_id, {
        status: falhas >= run.enfileirados && run.enfileirados > 0 ? "erro" : "sucesso",
        total: run.enfileirados,
        inseridos,
        atualizados,
        falhas,
        duracaoMs: Date.now() - inicio,
        mensagem,
      });
      return {
        runId: run.id,
        fase: "concluido",
        concluido: true,
        enfileirados: run.enfileirados,
        processados,
        restantes: 0,
        inseridos,
        atualizados,
        falhas,
        duracaoMs: Date.now() - inicio,
        mensagem,
      };
    }

    await finalizarLog(run.log_id, {
      status: "processando" as never,
      total: run.enfileirados,
      inseridos,
      atualizados,
      falhas,
      duracaoMs: Date.now() - inicio,
      mensagem: `Em andamento: ${processados} de ${run.enfileirados} · ${restantes} restante(s).`,
    });

    return {
      runId: run.id,
      fase: "detalhando",
      concluido: false,
      enfileirados: run.enfileirados,
      processados,
      restantes,
      inseridos,
      atualizados,
      falhas,
      duracaoMs: Date.now() - inicio,
      mensagem: `${processados} de ${run.enfileirados} processado(s) · ${restantes} restante(s).`,
    };
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    // Rede, 429 ou token: NÃO mata o run. A fila guarda o progresso.
    if (run) await salvarRun(run.id, { erro: mensagem.slice(0, 500) });
    return {
      runId: run?.id ?? null,
      fase: "erro",
      concluido: false,
      enfileirados: run?.enfileirados ?? 0,
      processados: run?.processados ?? 0,
      restantes: run ? await contar(run.id, "pendente").catch(() => 0) : 0,
      inseridos: run?.inseridos ?? 0,
      atualizados: run?.atualizados ?? 0,
      falhas: run?.falhas ?? 0,
      duracaoMs: Date.now() - inicio,
      mensagem,
    };
  }
}

/** Cancela o run ativo da empresa (libera o índice de "um ativo por vez"). */
export async function cancelarCargaOem(tenantId: string): Promise<{ cancelados: number }> {
  const db = await admin();
  const { data } = await db
    .from("oem_sync_runs")
    .update({
      fase: "erro",
      erro: "Cancelado manualmente.",
      finalizado_em: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .in("fase", ["listando", "detalhando"])
    .select("id");
  return { cancelados: (data ?? []).length };
}
