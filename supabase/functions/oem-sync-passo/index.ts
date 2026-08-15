// ============================================================================
// oem-sync-passo — um passo da carga do OEM, dentro do Supabase.
//
// Porte do motor que vivia em src/lib/oem-carga.server.ts (TanStack/Worker)
// para Edge Function Deno, no mesmo modelo do DoctorOMIE: a integração roda
// dentro do Supabase e o pg_cron chama direto, sem app hospedado no meio.
//
// ---------------------------------------------------------------------------
// MAPA DE FONTES (medido contra as duas APIs em 12/08/2026, não suposto)
// ---------------------------------------------------------------------------
//   api.tabletcloud.com.br = LEITURA (host documentado)
//   api.pdvlegal.com.br    = ESCRITA (esta função só LÊ dele o `bloqueado`)
//
//   Enumeração grupo+filiais | TC  /licenciamento/minhaslicencas/{pagina}/
//   Ativo / Desativado       | TC  filiais[].ativo   (equivale ao AT/IN)
//   Custo e módulos          | TC  /licenciamento/minhaslicencas/modulos/...
//   Bloqueado                | PL  /v1/licenciamento/{emp}/{fil} .bloqueado
//
// NÃO usar a listagem nem o modulos[] do pdvlegal: o `ativo` dela é
// inconsistente e a lista de módulos vem incompleta (2 de 5 na PARRILLA GOLD).
//
// ---------------------------------------------------------------------------
// REGRAS QUE NÃO PODEM SE PERDER
// ---------------------------------------------------------------------------
//  1. NUNCA gravar registro degradado. Se o detalhe do OEM falhar, a linha da
//     fila vira ERRO com o motivo escrito e o registro atual fica intacto.
//     Foi o fallback silencioso "detalhe ?? resumo" que corrompeu ~2.300
//     clientes em 12/08 — zerou custo e módulos de quem estava correto.
//  2. 429 não é culpa do cliente: a linha continua PENDENTE, para ser tentada
//     de novo. Marcá-la como erro perderia o cliente por um limite temporário.
//  3. Um passo que morre não perde trabalho: a fila (oem_sync_fila) é o estado.
// ============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const LEITURA_BASE = (Deno.env.get("OEM_API_LEITURA_URL") ?? "https://api.tabletcloud.com.br")
  .replace(/\/+$/, "");

function limite(nome: string, padrao: number): number {
  const v = Number(Deno.env.get(nome));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : padrao;
}
// A Edge Function não tem o teto de subrequisições do Cloudflare Workers, mas
// tem **150s de tempo de parede**. Medido: são 2 chamadas ao OEM por cliente a
// ~3 req/s, ou seja ~1,5 cliente por segundo. 60 clientes ≈ 40s, com folga
// larga. O primeiro teste morreu em IDLE_TIMEOUT com 150 clientes × 2 passos.
const CLIENTES_POR_PASSO = () => limite("OEM_CLIENTES_POR_PASSO", 60);
// Margem para devolver a resposta antes do corte da plataforma. Parar no meio
// não custa nada: a fila guarda o progresso e a próxima chamada continua.
const PRAZO_MS = () => limite("OEM_PRAZO_MS", 110_000);
const PAGINAS_POR_PASSO = () => limite("OEM_PAGINAS_POR_PASSO", 15);
const CHUNK_PARALELO = () => limite("OEM_PARALELO", 3);
const PAUSA_MS = () => limite("OEM_PAUSA_MS", 1000);
const RETRY_429 = 3;

class RateLimitOem extends Error {
  constructor(descricao: string, corpo: string) {
    super(
      `OEM manteve o 429 em ${descricao} após ${RETRY_429} esperas (2s+4s+8s).` +
        (corpo ? ` Resposta: ${corpo}` : " A API não mandou Retry-After."),
    );
    this.name = "RateLimitOem";
  }
}

type Creds = {
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  method: string;
};
type Holder = { value: string; refresh: () => Promise<void> };
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
type RunRow = {
  id: string;
  log_id: string | null;
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

const inteiro = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ HTTP no OEM

/** GET que negocia o ritmo: 401 renova o token, 429 espera e repete. */
async function oemGet(holder: Holder, url: string, descricao: string): Promise<Response> {
  let espera = 2000;
  for (let tentativa = 0; ; tentativa++) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${holder.value}`, Accept: "application/json" },
    });
    if (resp.status === 401 && tentativa === 0) {
      await holder.refresh();
      continue;
    }
    if (resp.status !== 429) return resp;

    const corpo = (await resp.text().catch(() => "")).trim().slice(0, 300);
    if (tentativa >= RETRY_429) throw new RateLimitOem(descricao, corpo);
    const cab = Number(resp.headers.get("retry-after"));
    const pausa = Number.isFinite(cab) && cab > 0 ? cab * 1000 : espera;
    console.warn(`[oem-sync] 429 em ${descricao} — aguardando ${Math.round(pausa / 1000)}s`);
    await dormir(pausa);
    espera = Math.min(espera * 2, 30_000);
  }
}

async function criarHolder(base: string, creds: Creds): Promise<Holder> {
  const pedir = async (): Promise<string> => {
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
  };
  const holder: Holder = { value: await pedir(), refresh: async () => {} };
  holder.refresh = async () => {
    holder.value = await pedir();
  };
  return holder;
}

/** Normaliza um módulo da API para o formato gravado em modulos_ativos. */
function normalizarModulo(m: Record<string, unknown>, i: number): Record<string, unknown> {
  const quantidade = Number(m.quantidade ?? 0) || 0;
  const valorTotal = Number(m.valorTotal ?? m.valor ?? 0) || 0;
  let valorUnitario = Number(m.valorUnitario ?? 0) || 0;
  if (valorUnitario === 0 && quantidade > 0 && valorTotal > 0) {
    valorUnitario = Math.round((valorTotal / quantidade) * 100) / 100;
  }
  let nome = String(m.nome ?? `Módulo ${i + 1}`);
  // Regra de negócio herdada: PDV/Comandas aparece como "Licença PDV".
  if (/PDV|COMANDA/i.test(nome)) nome = "Licença PDV";
  const ativo = m.ativo === undefined ? true : Boolean(m.ativo);
  return {
    ...m,
    id: String(m.codigo ?? i),
    nome,
    ativo,
    status: ativo ? "Ativo" : "Inativo",
    descricao: `Qtde ${quantidade} × R$ ${valorUnitario.toFixed(2)} (unitário)`,
    quantidade,
    valorUnitario,
    valor_unitario: valorUnitario,
    total: valorTotal,
    valorTotal,
    valor_total: valorTotal,
    valor: valorTotal,
  };
}

async function buscarPagina(h: Holder, pagina: number) {
  const alvo = `listagem página ${pagina}`;
  const r = await oemGet(h, `${LEITURA_BASE}/licenciamento/minhaslicencas/${pagina}/`, alvo);
  if (!r.ok) throw new Error(`Listagem HTTP ${r.status} na ${alvo}.`);
  const j = await r.json().catch(() => null);
  if (!j || !Array.isArray(j.data)) throw new Error(`Listagem inválida na ${alvo}.`);
  return { grupos: j.data as Record<string, any>[], total: typeof j.total === "number" ? j.total : null };
}

async function buscarProdutos(h: Holder): Promise<Record<string, string>> {
  const r = await oemGet(h, `${LEITURA_BASE}/licenciamento/minhaslicencas/produtos`, "produtos");
  if (!r.ok) throw new Error(`Catálogo de produtos HTTP ${r.status}.`);
  const lista = await r.json().catch(() => []);
  const mapa: Record<string, string> = {};
  for (const p of Array.isArray(lista) ? lista : []) {
    if (p?.nome && p?.codigo) mapa[String(p.nome).trim().toUpperCase()] = String(p.codigo);
  }
  return mapa;
}

async function buscarModulos(h: Holder, prod: string, grupo: number, filial: number) {
  const alvo = `módulos ${prod}/${grupo}/${filial}`;
  const url = `${LEITURA_BASE}/licenciamento/minhaslicencas/modulos/${encodeURIComponent(prod)}/${grupo}/${filial}`;
  const r = await oemGet(h, url, alvo);
  if (!r.ok) throw new Error(`Módulos HTTP ${r.status} em ${alvo}.`);
  const raw = await r.json().catch(() => null);
  if (!raw) throw new Error(`Módulos vieram vazios em ${alvo}.`);
  const lista: Record<string, unknown>[] = Array.isArray(raw?.modulos) ? raw.modulos : [];
  const valorTotal = Number(raw?.valorTotal);
  return {
    valorTotal: Number.isFinite(valorTotal) ? valorTotal : null,
    modulos: lista.map(normalizarModulo),
  };
}

async function buscarBloqueio(creds: Creds, h: Holder, grupo: number, filial: number) {
  const alvo = `licença ${grupo}/${filial}`;
  const r = await oemGet(h, `${creds.baseUrl}/v1/licenciamento/${grupo}/${filial}`, alvo);
  if (!r.ok) throw new Error(`Detalhe da licença HTTP ${r.status} em ${alvo}.`);
  const raw = await r.json().catch(() => null);
  const f = raw?.filial ?? {};
  return {
    bloqueado: f.bloqueado === true,
    usuarios: inteiro(f.usuarios),
    pdvComandas: inteiro(f.pdvComandas),
  };
}

// --------------------------------------------------------------- o passo

// Senha e client_secret vivem no Vault desde 15/08/2026 — as colunas em claro
// não existem mais. A RPC é o único caminho, e só o service_role a executa.
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

async function contar(db: SupabaseClient, runId: string, status: string): Promise<number> {
  const { count } = await db
    .from("oem_sync_fila")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", status);
  return count ?? 0;
}

async function salvarRun(db: SupabaseClient, runId: string, patch: Record<string, unknown>) {
  const { error } = await db
    .from("oem_sync_runs")
    .update({ ...patch, atualizado_em: new Date().toISOString() })
    .eq("id", runId);
  if (error) console.error("[oem-sync] salvar run:", error.message);
}

async function obterOuCriarRun(db: SupabaseClient, tenantId: string, origem: string): Promise<RunRow> {
  const ativo = async () => {
    const { data } = await db
      .from("oem_sync_runs").select("*").eq("tenant_id", tenantId)
      .in("fase", ["listando", "detalhando"])
      .order("iniciado_em", { ascending: false }).limit(1).maybeSingle();
    return (data as RunRow | null) ?? null;
  };
  const existente = await ativo();
  if (existente) return existente;

  // Run fechado que voltou a ter pendente (reprocessamento) é REABERTO, para
  // não refazer a enumeração inteira e deixar as linhas devolvidas órfãs.
  const { data: ultimo } = await db
    .from("oem_sync_runs").select("*").eq("tenant_id", tenantId)
    .order("iniciado_em", { ascending: false }).limit(1).maybeSingle();
  if (ultimo && (await contar(db, (ultimo as RunRow).id, "pendente")) > 0) {
    await salvarRun(db, (ultimo as RunRow).id, { fase: "detalhando", finalizado_em: null });
    return { ...(ultimo as RunRow), fase: "detalhando" };
  }

  const { data: log } = await db
    .from("oem_sync_logs")
    .insert({ tenant_id: tenantId, origem, status: "processando", mensagem: "Carga iniciada — enumerando no OEM." })
    .select("id").maybeSingle();
  const { data, error } = await db
    .from("oem_sync_runs")
    .insert({ tenant_id: tenantId, origem, log_id: log?.id ?? null, fase: "listando", proxima_pagina: 1 })
    .select("*").maybeSingle();
  if (error) {
    const concorrente = await ativo();
    if (concorrente) return concorrente;
    throw new Error(`oem_sync_runs: ${error.message}`);
  }
  return data as RunRow;
}

async function passoListagem(db: SupabaseClient, tenantId: string, run: RunRow, tc: Holder) {
  let pagina = Math.max(1, run.proxima_pagina);
  let gruposLidos = run.grupos_lidos;
  let total = run.total_registros;
  let enfileirados = 0;
  let terminou = false;

  for (let p = 0; p < PAGINAS_POR_PASSO(); p++) {
    const { grupos, total: t } = await buscarPagina(tc, pagina);
    if (t != null) total = t;
    if (!grupos.length) { terminou = true; break; }
    gruposLidos += grupos.length;
    pagina += 1;

    const itens: Record<string, unknown>[] = [];
    for (const g of grupos) {
      const codGrupo = inteiro(g.codgrupo);
      if (codGrupo == null) continue;
      const numFiliais = (g.qtdLojasAtivas ?? 0) + (g.qtdLojasDesativadas ?? 0);
      const filiais = Array.isArray(g.filiais) ? g.filiais : [];
      if (!filiais.length) {
        // Entra como erro para APARECER no diagnóstico em vez de sumir.
        itens.push({
          run_id: run.id, tenant_id: tenantId, empresa_codigo: String(codGrupo),
          filial_codigo: "", produto: g.produto ?? null, numero_filiais: numFiliais || null,
          status: "erro", erro: "Grupo sem filiais na listagem do OEM.",
          processado_em: new Date().toISOString(),
        });
        continue;
      }
      for (const f of filiais) {
        const codFilial = inteiro(f?.codfilial);
        if (codFilial == null) continue;
        itens.push({
          run_id: run.id, tenant_id: tenantId,
          empresa_codigo: String(codGrupo), filial_codigo: String(codFilial),
          produto: g.produto ?? null, numero_filiais: numFiliais || null,
          resumo: {
            nomegrupo: g.nomegrupo ?? null, nomefilial: f.nomefilial ?? null,
            cpf_cnpj: f.cpf_cnpj ?? g.cpf_cnpj ?? null,
            ativo: f.ativo ?? g.ativo ?? true, matriz: f.matriz ?? false,
            email: f.email ?? null, datacadastro: f.datacadastro ?? null,
          } satisfies ResumoFilial,
          status: "pendente",
        });
      }
    }

    if (itens.length) {
      const { error } = await db.from("oem_sync_fila")
        .upsert(itens, { onConflict: "run_id,empresa_codigo,filial_codigo", ignoreDuplicates: true });
      if (error) throw new Error(`oem_sync_fila: ${error.message}`);
      enfileirados += itens.filter((i) => i.status === "pendente").length;
    }
  }

  await salvarRun(db, run.id, {
    proxima_pagina: pagina, grupos_lidos: gruposLidos, total_registros: total,
    enfileirados: run.enfileirados + enfileirados,
    ...(terminou ? { fase: "detalhando" } : {}),
  });
  return { enfileirados, terminou };
}

async function montarLinha(
  tenantId: string, item: FilaRow, produtos: Record<string, string>,
  creds: Creds, tc: Holder, pl: Holder,
): Promise<Record<string, unknown>> {
  const codGrupo = Number(item.empresa_codigo);
  const codFilial = Number(item.filial_codigo);
  if (!Number.isFinite(codGrupo) || !Number.isFinite(codFilial)) {
    throw new Error(`Códigos inválidos: ${item.empresa_codigo}/${item.filial_codigo}`);
  }
  const resumo = item.resumo;
  if (!resumo) throw new Error("Linha da fila sem os dados da listagem.");

  const codProduto = produtos[String(item.produto ?? "").trim().toUpperCase()];
  if (!codProduto) {
    throw new Error(`Produto "${item.produto ?? "(vazio)"}" não está no catálogo do OEM.`);
  }

  const { valorTotal, modulos } = await buscarModulos(tc, codProduto, codGrupo, codFilial);
  const licenca = await buscarBloqueio(creds, pl, codGrupo, codFilial);

  const qtdDe = (re: RegExp): number | null => {
    for (const m of modulos) {
      if (re.test(String(m.nome ?? "").toUpperCase())) {
        if (m.ativo === false) return 0;
        const q = Number(m.quantidade ?? 0);
        return Number.isFinite(q) ? q : null;
      }
    }
    return null;
  };
  const qtdPdv = qtdDe(/PDV|COMANDA/) ?? licenca.pdvComandas ?? 0;

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
    // Dimensões INDEPENDENTES — status nunca é cópia de bloqueado.
    status: resumo.ativo ? "Ativo" : "Desativado",
    bloqueado: licenca.bloqueado,
    motivo_bloqueio: licenca.bloqueado ? "Bloqueado no OEM" : null,
    custo_total: valorTotal ?? 0,
    modulos_ativos: modulos,
    qtd_pdv: qtdPdv,
    qtd_pdv_comandas: qtdPdv,
    qtd_comandas: qtdDe(/MESA|FICHA/) ?? 0,
    usuarios_adicionais: qtdDe(/USU[ÁA]RIO/) ?? licenca.usuarios ?? 0,
    last_sync: new Date().toISOString(),
  };
}

async function passoDetalhe(
  db: SupabaseClient, tenantId: string, run: RunRow, creds: Creds, tc: Holder, pl: Holder,
) {
  const { data: loteRaw, error } = await db
    .from("oem_sync_fila")
    .select("id, empresa_codigo, filial_codigo, produto, numero_filiais, resumo")
    .eq("run_id", run.id).eq("status", "pendente")
    .order("id", { ascending: true }).limit(CLIENTES_POR_PASSO());
  if (error) throw new Error(`oem_sync_fila: ${error.message}`);
  const lote = (loteRaw ?? []) as unknown as FilaRow[];
  if (!lote.length) return { processados: 0, inseridos: 0, atualizados: 0, falhas: 0, barrado: null };

  let produtos = run.produtos;
  if (!produtos || !Object.keys(produtos).length) {
    produtos = await buscarProdutos(tc);
    await salvarRun(db, run.id, { produtos });
  }

  const { data: jaExistem } = await db
    .from("clientes_oem").select("filial_codigo")
    .eq("tenant_id", tenantId).in("filial_codigo", lote.map((i) => i.filial_codigo));
  const existentes = new Set((jaExistem ?? []).map((r: any) => String(r.filial_codigo)));

  const okIds: number[] = [];
  const erros: Array<{ id: number; erro: string }> = [];
  let inseridos = 0, atualizados = 0;
  let barrado: string | null = null;
  const paralelo = CHUNK_PARALELO();

  const prazo = Date.now() + PRAZO_MS();
  for (let i = 0; i < lote.length && !barrado; i += paralelo) {
    // Relógio interno: devolve a resposta antes de a plataforma cortar em 150s.
    if (Date.now() > prazo) {
      console.warn(`[oem-sync] prazo do passo atingido em ${i}/${lote.length} — devolvendo parcial.`);
      break;
    }
    const chunk = lote.slice(i, i + paralelo);
    const res = await Promise.all(chunk.map(async (item) => {
      try {
        return { item, linha: await montarLinha(tenantId, item, produtos!, creds, tc, pl) };
      } catch (e) {
        // 429 mantém a linha PENDENTE — não é falha do cliente.
        if (e instanceof RateLimitOem) return { item, barrado: e.message };
        return { item, erro: e instanceof Error ? e.message : String(e) };
      }
    }));

    const bloqueio = res.find((r: any) => "barrado" in r) as { barrado: string } | undefined;
    if (bloqueio) barrado = bloqueio.barrado;
    const linhas = res.filter((r: any) => "linha" in r) as Array<{ item: FilaRow; linha: Record<string, unknown> }>;
    for (const r of res as any[]) {
      if (r.erro) erros.push({ id: r.item.id, erro: String(r.erro).slice(0, 400) });
    }

    if (linhas.length) {
      const { error: errUp } = await db.from("clientes_oem")
        .upsert(linhas.map((l) => l.linha), { onConflict: "tenant_id,filial_codigo" });
      if (errUp) {
        // Um registro ruim derruba o lote inteiro: refaz um a um para isolar.
        console.warn(`[oem-sync] lote rejeitado (${errUp.message}) — refazendo individualmente.`);
        for (const l of linhas) {
          const { error: e1 } = await db.from("clientes_oem")
            .upsert([l.linha], { onConflict: "tenant_id,filial_codigo" });
          if (e1) erros.push({ id: l.item.id, erro: `Gravação: ${e1.message}`.slice(0, 400) });
          else {
            okIds.push(l.item.id);
            existentes.has(String(l.item.filial_codigo)) ? atualizados++ : inseridos++;
          }
        }
      } else {
        for (const l of linhas) {
          okIds.push(l.item.id);
          existentes.has(String(l.item.filial_codigo)) ? atualizados++ : inseridos++;
        }
      }
    }
    if (i + paralelo < lote.length && !barrado) await dormir(PAUSA_MS());
  }

  const agora = new Date().toISOString();
  if (okIds.length) {
    await db.from("oem_sync_fila").update({ status: "ok", erro: null, processado_em: agora }).in("id", okIds);
  }
  for (const e of erros) {
    await db.from("oem_sync_fila").update({ status: "erro", erro: e.erro, processado_em: agora }).eq("id", e.id);
  }

  // `falhas` vem da FILA, não de acumulador: linha que voltou para pendente e
  // depois deu certo não pode continuar contando como falha.
  const falhas = await contar(db, run.id, "erro");
  await salvarRun(db, run.id, {
    processados: run.processados + okIds.length + erros.length,
    inseridos: run.inseridos + inseridos,
    atualizados: run.atualizados + atualizados,
    falhas,
  });
  return { processados: okIds.length + erros.length, inseridos, atualizados, falhas, barrado };
}

async function avancar(db: SupabaseClient, tenantId: string, origem: string) {
  const inicio = Date.now();
  const run = await obterOuCriarRun(db, tenantId, origem);
  const creds = await carregarCreds(db, tenantId);
  const tc = await criarHolder(LEITURA_BASE, creds);

  if (run.fase === "listando") {
    const { enfileirados, terminou } = await passoListagem(db, tenantId, run, tc);
    return {
      fase: terminou ? "detalhando" : "listando", concluido: false,
      enfileirados: run.enfileirados + enfileirados,
      restantes: await contar(db, run.id, "pendente"),
      duracaoMs: Date.now() - inicio,
      mensagem: `${run.enfileirados + enfileirados} filial(is) na fila.`,
    };
  }

  const pl = await criarHolder(creds.baseUrl, creds);
  const passo = await passoDetalhe(db, tenantId, run, creds, tc, pl);
  const restantes = await contar(db, run.id, "pendente");
  const processados = run.processados + passo.processados;
  const inseridos = run.inseridos + passo.inseridos;
  const atualizados = run.atualizados + passo.atualizados;

  if (passo.barrado) {
    return {
      fase: "erro", concluido: false, enfileirados: run.enfileirados, processados, restantes,
      duracaoMs: Date.now() - inicio,
      mensagem: `OEM barrou as requisições. ${restantes} continuam na fila. ${passo.barrado}`,
    };
  }

  if (restantes === 0) {
    const mensagem = `${inseridos} novo(s), ${atualizados} atualizado(s), ${passo.falhas} falha(s) de ${run.enfileirados}.`;
    await salvarRun(db, run.id, { fase: "concluido", finalizado_em: new Date().toISOString() });
    if (run.log_id) {
      await db.from("oem_sync_logs").update({
        status: passo.falhas >= run.enfileirados && run.enfileirados > 0 ? "erro" : "sucesso",
        total_clientes: run.enfileirados, clientes_atualizados: inseridos + atualizados,
        clientes_falha: passo.falhas, duracao_ms: Date.now() - inicio, mensagem,
      }).eq("id", run.log_id);
    }
    return { fase: "concluido", concluido: true, enfileirados: run.enfileirados, processados, restantes: 0, duracaoMs: Date.now() - inicio, mensagem };
  }

  if (run.log_id) {
    await db.from("oem_sync_logs").update({
      status: "processando", total_clientes: run.enfileirados,
      clientes_atualizados: inseridos + atualizados, clientes_falha: passo.falhas,
      mensagem: `Em andamento: ${processados} de ${run.enfileirados} · ${restantes} restante(s).`,
    }).eq("id", run.log_id);
  }
  return {
    fase: "detalhando", concluido: false, enfileirados: run.enfileirados, processados, restantes,
    duracaoMs: Date.now() - inicio,
    mensagem: `${processados} de ${run.enfileirados} · ${restantes} restante(s).`,
  };
}

// ------------------------------------------------------------------ HTTP

Deno.serve(async (req) => {
  const inicio = Date.now();
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    const origem = typeof corpo.origem === "string" ? corpo.origem : "cron";
    // Sem tenantId = todas as empresas elegíveis (é o caso do cron).
    // Com tenantId = só aquela — é o botão "Sincronizar" da tela.
    const soTenant = typeof corpo.tenantId === "string" ? corpo.tenantId : null;
    // UM passo por invocação é o padrão: dois já estouram os 150s de parede.
    // Quem quiser mais assume o risco explicitamente pelo corpo da requisição.
    const maxPassos = Number(corpo.passos) > 0 ? Math.min(Number(corpo.passos), 5) : 1;

    // Empresas ativas, com sincronização ligada e credenciais preenchidas.
    const { data: tenants, error: errT } = await db.from("tenants").select("id, nome").eq("ativo", true);
    if (errT) throw new Error(`tenants: ${errT.message}`);
    const { data: cfgs } = await db.from("oem_sync_config").select("tenant_id, ativo, intervalo_horas");
    // Os segredos estão no cofre: aqui só dá para conferir se existe cofre.
    // O conteúdo é validado no carregarCreds, já dentro do passo da empresa.
    const { data: sets } = await db.from("tenant_oem_settings")
      .select("tenant_id, oem_api_username, oem_client_id, vault_secret_id");

    const desligados = new Set((cfgs ?? []).filter((c: any) => c.ativo === false).map((c: any) => String(c.tenant_id)));
    const comCreds = new Set((sets ?? []).filter((s: any) =>
      s.oem_api_username && s.oem_client_id && s.vault_secret_id,
    ).map((s: any) => String(s.tenant_id)));

    const resultados: Record<string, unknown>[] = [];
    for (const t of tenants ?? []) {
      const tenantId = String(t.id);
      if (soTenant && tenantId !== soTenant) continue;
      if (desligados.has(tenantId) || !comCreds.has(tenantId)) continue;
      try {
        // Sem carga em andamento? Respeita o intervalo configurado.
        const { data: emAndamento } = await db.from("oem_sync_runs").select("id")
          .eq("tenant_id", tenantId).in("fase", ["listando", "detalhando"]).limit(1).maybeSingle();
        if (!emAndamento && origem === "cron") {
          const horas = Number((cfgs ?? []).find((c: any) => String(c.tenant_id) === tenantId)?.intervalo_horas ?? 24);
          const { data: ultimo } = await db.from("oem_sync_logs").select("executado_em")
            .eq("tenant_id", tenantId).eq("status", "sucesso")
            .order("executado_em", { ascending: false }).limit(1).maybeSingle();
          if (ultimo?.executado_em) {
            const decorrido = Date.now() - new Date(ultimo.executado_em).getTime();
            if (decorrido < horas * 3_600_000 - 300_000) {
              resultados.push({ tenant: t.nome, status: "ignorado",
                mensagem: `Última carga há ${(decorrido / 3_600_000).toFixed(1)}h — intervalo de ${horas}h não decorrido.` });
              continue;
            }
          }
        }

        let passo = await avancar(db, tenantId, origem);
        for (let i = 1; i < maxPassos && !passo.concluido && passo.fase !== "erro"; i++) {
          passo = await avancar(db, tenantId, origem);
        }
        resultados.push({ tenant: t.nome, status: passo.fase === "erro" ? "erro" : passo.concluido ? "sucesso" : "em-andamento", ...passo });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[oem-sync] tenant ${tenantId}:`, msg);
        resultados.push({ tenant: t.nome, status: "erro", mensagem: msg });
      }
    }

    return Response.json({ ok: true, duracaoMs: Date.now() - inicio, resultados });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[oem-sync] falhou:", msg);
    return Response.json({ ok: false, duracaoMs: Date.now() - inicio, mensagem: msg }, { status: 500 });
  }
});
