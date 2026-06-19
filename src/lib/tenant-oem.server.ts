// ============================================================
// Motor de sincronização OEM por tenant.
// Usa as credenciais salvas em tenant_oem_settings (Cloud central),
// autentica via OAuth2 (password grant) na API OEM da empresa e
// grava clientes/logs no Cloud central com tenant_id.
// ============================================================
import {
  mapLicenciamentoToRow,
  fetchLicenciamentoOem,
  type TokenHolder,
} from "@/lib/doctoroem.functions";

type TenantCreds = {
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  method: string;
};

type TabletCloudFilialResumo = {
  ativo?: boolean;
  matriz?: boolean;
  codFilial?: number;
  nomeFilial?: string;
  cpfCnpj?: string;
  dataCadastro?: string;
  email?: string;
};

type TabletCloudGrupoResumo = {
  codGrupo?: number;
  ativo?: boolean;
  nomeGrupo?: string;
  cpfCnpj?: string;
  produto?: string;
  qtdLojasAtivas?: number;
  qtdLojasDesativadas?: number;
  dataCadastro?: string;
  filiais?: TabletCloudFilialResumo[];
};

type ListagemResponse = {
  totalRegistros?: number;
  totalGruposNaPagina?: number;
  pagina?: number;
  data?: TabletCloudGrupoResumo[];
};

export type TenantSyncResult = {
  status: "sucesso" | "erro";
  total: number;
  inseridos: number;
  atualizados: number;
  falhas: number;
  duracaoMs: number;
  mensagem: string;
};

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function buildResumoFallback(
  resumo: TabletCloudGrupoResumo,
  filial?: TabletCloudFilialResumo,
): Record<string, unknown> {
  return {
    codEmpresa: resumo.codGrupo,
    codFilial: filial?.codFilial,
    cnpjEmpresa: filial?.cpfCnpj ?? resumo.cpfCnpj,
    nomeEmpresa: filial?.nomeFilial ?? resumo.nomeGrupo,
    razaoSocial: filial?.nomeFilial ?? resumo.nomeGrupo,
    grupoEconomico: resumo.nomeGrupo,
    produto: resumo.produto,
    numeroFiliais: (resumo.qtdLojasAtivas ?? 0) + (resumo.qtdLojasDesativadas ?? 0),
    bloquearLicenca: !(filial?.ativo ?? resumo.ativo ?? true),
  };
}

async function loadTenantCreds(tenantId: string): Promise<TenantCreds> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("tenant_oem_settings")
    .select(
      "oem_api_base_url, oem_api_username, oem_api_password, oem_client_id, oem_client_secret, oem_api_method",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`tenant_oem_settings: ${error.message}`);
  if (!data) throw new Error("Credenciais OEM não cadastradas para esta empresa.");
  const missing: string[] = [];
  if (!data.oem_api_username) missing.push("usuário");
  if (!data.oem_api_password) missing.push("senha");
  if (!data.oem_client_id) missing.push("client_id");
  if (!data.oem_client_secret) missing.push("client_secret");
  if (missing.length) {
    throw new Error(
      `Credenciais OEM incompletas (faltam: ${missing.join(", ")}). Preencha em Configurações.`,
    );
  }
  return {
    baseUrl: (data.oem_api_base_url ?? "https://api.pdvlegal.com.br").replace(/\/+$/, ""),
    username: data.oem_api_username!,
    password: data.oem_api_password!,
    clientId: data.oem_client_id!,
    clientSecret: data.oem_client_secret!,
    method: data.oem_api_method ?? "password",
  };
}

// Margem de segurança antes do vencimento do token (renova 2 min antes).
const TOKEN_MARGEM_MS = 120_000;

// Solicita um token NOVO à API OEM. IMPORTANTE: faz UMA única tentativa —
// quando o /token responde 429, repetir só amplia o bloqueio do provedor.
async function solicitarTokenOem(
  creds: TenantCreds,
): Promise<{ token: string; expiraEm: string }> {
  const body = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    grant_type: creds.method || "password",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const resp = await fetch(`${creds.baseUrl}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (resp.ok) {
    const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof json.access_token === "string" ? json.access_token : null;
    if (!token) throw new Error("Resposta de token sem access_token.");
    const expiresIn = Number(json.expires_in);
    const vidaMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return { token, expiraEm: new Date(Date.now() + vidaMs).toISOString() };
  }
  const preview = await resp.text().catch(() => "");
  throw new Error(`Falha na autenticação OEM (HTTP ${resp.status}): ${preview.slice(0, 180)}`);
}

// Token com CACHE compartilhado (tabela oem_token_cache, acesso só do servidor).
// Evita pedir token novo a cada ação — principal causa do erro HTTP 429.
export async function obterTokenTenant(
  tenantId: string,
  creds: TenantCreds,
  forcarNovo = false,
): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Lê estado atual do cache (token + cooldown)
  const { data: cache } = await supabaseAdmin
    .from("oem_token_cache")
    .select("token, expira_em, cooldown_ate, atualizado_em")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!forcarNovo) {
    if (cache?.token && cache.expira_em) {
      const expira = new Date(cache.expira_em).getTime();
      if (Number.isFinite(expira) && expira - TOKEN_MARGEM_MS > Date.now()) {
        return cache.token;
      }
    }
  }
  // Cooldown ativo? Aborta sem tocar no /token (evita amplificar o 429).
  if (cache?.cooldown_ate) {
    const ate = new Date(cache.cooldown_ate).getTime();
    if (Number.isFinite(ate) && ate > Date.now()) {
      const segundos = Math.ceil((ate - Date.now()) / 1000);
      throw new Error(
        `OEM bloqueou as requisições por excesso de tentativas. Aguarde ${segundos}s e tente novamente.`,
      );
    }
  }
  try {
    const { token, expiraEm } = await solicitarTokenOem(creds);
    const { error } = await supabaseAdmin
      .from("oem_token_cache")
      .upsert(
        {
          tenant_id: tenantId,
          token,
          expira_em: expiraEm,
          cooldown_ate: null,
          atualizado_em: new Date().toISOString(),
        },
        { onConflict: "tenant_id" },
      );
    if (error) console.error("[tenant-oem] falha ao salvar cache de token:", error.message);
    return token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Se o /token devolveu 429, registra cooldown com escalonamento: começa
    // em 2 min e dobra a cada 429 consecutivo (máx. 15 min). Assim, se o
    // bloqueio do provedor for mais longo, paramos de insistir rapidamente.
    if (/HTTP 429/.test(msg)) {
      let duracao = 120_000;
      if (cache?.cooldown_ate && cache.atualizado_em) {
        const anterior =
          new Date(cache.cooldown_ate).getTime() - new Date(cache.atualizado_em).getTime();
        if (Number.isFinite(anterior) && anterior > 0) {
          duracao = Math.min(anterior * 2, 900_000);
        }
      }
      const ate = new Date(Date.now() + duracao).toISOString();
      await supabaseAdmin
        .from("oem_token_cache")
        .upsert(
          {
            tenant_id: tenantId,
            token: cache?.token ?? null,
            expira_em: cache?.expira_em ?? null,
            cooldown_ate: ate,
            atualizado_em: new Date().toISOString(),
          },
          { onConflict: "tenant_id" },
        );
    }
    throw e;
  }
}

// Holder mutável: permite que fetchLicenciamentoOem renove o token quando a
// API responder 401 no meio do loop longo (carga inicial pode levar minutos).
function criarTokenHolderTenant(
  tenantId: string,
  creds: TenantCreds,
  initial: string,
): TokenHolder {
  const holder: TokenHolder = {
    value: initial,
    clear: () => {
      holder.value = "";
    },
  };
  let pending: Promise<void> | null = null;
  holder.refresh = async (reason) => {
    if (pending) return pending;
    pending = (async () => {
      try {
        if (reason === "401") await new Promise((r) => setTimeout(r, 2000));
        holder.value = "";
        holder.value = await obterTokenTenant(tenantId, creds, true);
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return holder;
}

// ---------------------------------------------------------------
// Normalização anti-zerados: garante que toda linha gravada tenha
// contadores e módulos preenchidos (sobrescrevendo dados antigos)
// e que o custo_total NUNCA fique vazio — se a API vier sem valor,
// soma o total dos módulos ativos como fallback dinâmico.
// ---------------------------------------------------------------
function blindarRow(row: Record<string, unknown>): Record<string, unknown> {
  const modulos = Array.isArray(row.modulos_ativos)
    ? (row.modulos_ativos as Record<string, unknown>[])
    : [];
  // Sempre escreve a lista (mesmo []) para limpar módulos removidos no OEM.
  row.modulos_ativos = modulos;

  // Zera contadores quando o OEM reduziu/desativou recursos.
  row.qtd_pdv = typeof row.qtd_pdv === "number" ? row.qtd_pdv : 0;
  row.qtd_pdv_comandas =
    typeof row.qtd_pdv_comandas === "number" ? row.qtd_pdv_comandas : Number(row.qtd_pdv ?? 0);
  row.qtd_comandas = typeof row.qtd_comandas === "number" ? row.qtd_comandas : 0;
  row.usuarios_adicionais =
    typeof row.usuarios_adicionais === "number" ? row.usuarios_adicionais : 0;

  // Fallback dinâmico de custo: se a API não trouxe valorTotal (ou veio 0),
  // soma os totais dos módulos ATIVOS para nunca persistir 0/null indevido.
  const custoBruto = Number(row.custo_total ?? 0);
  if (!Number.isFinite(custoBruto) || custoBruto <= 0) {
    const somaModulos = modulos.reduce((acc, m) => {
      const ativoRaw = m.ativo ?? m.active;
      const ativo = typeof ativoRaw === "boolean" ? ativoRaw : true;
      if (!ativo) return acc;
      const total =
        Number(
          m.total ??
            m.valorTotal ??
            m.valor_total ??
            m.valor ??
            (Number(m.quantidade ?? 0) * Number(m.valorUnitario ?? m.valor_unitario ?? 0)),
        ) || 0;
      return acc + total;
    }, 0);
    row.custo_total = Math.round(somaModulos * 100) / 100;
  }
  return row;
}

export async function testTenantConnection(
  tenantId: string,
): Promise<{ ok: true; baseUrl: string } | { ok: false; mensagem: string }> {
  try {
    const creds = await loadTenantCreds(tenantId);
    // Usa o token em cache quando válido — testar a conexão não precisa
    // (e não deve) forçar um token novo no endpoint rate-limitado /token.
    await obterTokenTenant(tenantId, creds);
    return { ok: true, baseUrl: creds.baseUrl };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : String(e) };
  }
}

// Faz uma chamada autenticada à API OEM usando o token em cache;
// se o OEM responder 401 (token vencido/invalidado), renova UMA vez e repete.
async function fetchOemAutenticado(
  tenantId: string,
  creds: TenantCreds,
  url: string,
  init: { method: string; body?: string },
): Promise<Response> {
  const exec = async (token: string) =>
    fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: init.body,
    });
  let resp = await exec(await obterTokenTenant(tenantId, creds));
  if (resp.status === 401) {
    resp = await exec(await obterTokenTenant(tenantId, creds, true));
  }
  return resp;
}

async function fetchListagemPagina(
  creds: TenantCreds,
  token: string,
  pagina: number,
): Promise<ListagemResponse> {
  const url = `${creds.baseUrl}/v1/licenciamento?pagina=${pagina}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throw new Error(`Listagem OEM HTTP ${resp.status}: ${preview.slice(0, 180)}`);
  }
  const json = (await resp.json().catch(() => null)) as ListagemResponse | null;
  if (!json || !Array.isArray(json.data)) {
    throw new Error("Listagem OEM retornou payload inválido.");
  }
  return json;
}

async function inserirLog(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial",
  status: "processando" | "sucesso" | "erro",
  extras: Partial<TenantSyncResult> = {},
): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("oem_sync_logs")
    .insert({
      tenant_id: tenantId,
      origem,
      status,
      clientes_atualizados: extras.atualizados ?? 0,
      clientes_falha: extras.falhas ?? 0,
      total_clientes: extras.total ?? 0,
      duracao_ms: extras.duracaoMs ?? null,
      mensagem: extras.mensagem ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[tenant-oem] falha ao inserir log:", error.message);
    return null;
  }
  return (data?.id as string) ?? null;
}

async function finalizarLog(logId: string | null, result: TenantSyncResult): Promise<void> {
  if (!logId) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("oem_sync_logs")
    .update({
      status: result.status,
      clientes_atualizados: result.atualizados + result.inseridos,
      clientes_falha: result.falhas,
      total_clientes: result.total,
      duracao_ms: result.duracaoMs,
      mensagem: result.mensagem,
    })
    .eq("id", logId);
  if (error) console.error("[tenant-oem] falha ao finalizar log:", error.message);
}

/**
 * Carga inicial/sincronização do tenant: busca toda a listagem paginada
 * de /v1/licenciamento e gravar (upsert) no Cloud central com tenant_id.
 */
export async function runTenantOemSync(
  tenantId: string,
  origem: "manual" | "cron" | "carga-inicial",
): Promise<TenantSyncResult> {
  const inicio = Date.now();
  const logId = await inserirLog(tenantId, origem, "processando", {
    mensagem: "Sincronização iniciada — em andamento.",
  });

  try {
    const creds = await loadTenantCreds(tenantId);
    const token = await obterTokenTenant(tenantId, creds);
    const tokenHolder = criarTokenHolderTenant(tenantId, creds, token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // ---------- Fase 1: enumerar (codEmpresa, codFilial) via listagem ----------
    const candidatos: Array<{
      codEmpresa: number;
      codFilial: number;
      filialAtivo: boolean;
      numeroFiliais: number;
      resumo: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();
    let pagina = 1;
    let totalLidos = 0;
    let totalRegistros = Number.POSITIVE_INFINITY;

    while (totalLidos < totalRegistros) {
      const resp = await fetchListagemPagina(creds, token, pagina);
      const grupos = resp.data ?? [];
      totalRegistros = resp.totalRegistros ?? totalRegistros;
      if (!grupos.length) break;
      totalLidos += grupos.length;

      for (const grupo of grupos) {
        const codEmpresa = toNumber(grupo.codGrupo);
        if (codEmpresa == null) continue;
        const numFiliais =
          (grupo.qtdLojasAtivas ?? 0) + (grupo.qtdLojasDesativadas ?? 0);
        const filiais =
          Array.isArray(grupo.filiais) && grupo.filiais.length ? grupo.filiais : [undefined];
        for (const filial of filiais) {
          const codFilial = toNumber(filial?.codFilial);
          if (codFilial == null) continue;
          const key = `${codEmpresa}:${codFilial}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidatos.push({
            codEmpresa,
            codFilial,
            filialAtivo: filial?.ativo ?? grupo.ativo ?? true,
            numeroFiliais: numFiliais,
            resumo: buildResumoFallback(grupo, filial),
          });
        }
      }

      pagina += 1;
    }

    // ---------- Fase 2: buscar detalhe COMPLETO de cada filial ----------
    // /v1/licenciamento/{emp}/{fil} traz módulos, valorTotal e pdvComandas —
    // a listagem sozinha não traz esses campos (por isso clientes vinham
    // zerados). Processamos em chunks de 25 com pausa entre eles.
    const rows: Record<string, unknown>[] = [];
    let inseridos = 0;
    let atualizados = 0;
    let falhas = 0;
    const CHUNK = 25;
    const PAUSA_MS = 400;

    // pré-carrega chaves existentes para distinguir insert/update
    const { data: existentes } = await supabaseAdmin
      .from("clientes_oem")
      .select("filial_codigo")
      .eq("tenant_id", tenantId);
    const existentesSet = new Set(
      (existentes ?? []).map((r) => String((r as { filial_codigo: string | null }).filial_codigo)),
    );

    for (let i = 0; i < candidatos.length; i += CHUNK) {
      const lote = candidatos.slice(i, i + CHUNK);

      // Busca o detalhe em paralelo dentro do chunk (25 conexões simultâneas
      // é confortável para a API OEM). Fallback para o resumo se 404/erro.
      const detalhados: Array<Record<string, unknown> | null> = await Promise.all(
        lote.map(async (c) => {
          try {
            const detalhe = await fetchLicenciamentoOem(tokenHolder, c.codEmpresa, c.codFilial);
            const payload: Record<string, unknown> = { ...(detalhe ?? c.resumo) };

            const row = mapLicenciamentoToRow(payload, c.codEmpresa, c.codFilial);
            if (!row) return null;
            // Sobrescreve com fonte autoritativa da LISTAGEM:
            // - status operacional vem de filial.ativo (NÃO de bloquearLicenca,
            //   que indica apenas bloqueio comercial/licença).
            // - numero_filiais vem do grupo (detalhe não devolve esse campo).
            const blindada = blindarRow(row);
            // Status do cliente (Ativo/Desativado) vem do detalhe via mapLicenciamentoToRow
            // (filial.status "AT"/"IN"). `bloqueado` é uma dimensão SEPARADA (licença).
            // Não sobrescrevemos mais o status a partir de bloqueado.
            if (c.numeroFiliais > 0) blindada.numero_filiais = c.numeroFiliais;
            return { ...blindada, tenant_id: tenantId } as Record<string, unknown>;
          } catch (err) {
            console.error(
              `[tenant-oem] falha ao buscar detalhe ${c.codEmpresa}/${c.codFilial}:`,
              err instanceof Error ? err.message : err,
            );
            return null;
          }
        }),
      );

      const validos: Record<string, unknown>[] = detalhados.filter(
        (r): r is Record<string, unknown> => r !== null,
      );
      falhas += lote.length - validos.length;
      rows.push(...validos);

      // Upsert imediato deste chunk — falhas isoladas não derrubam o lote inteiro.
      if (validos.length) {
        const { error } = await supabaseAdmin
          .from("clientes_oem")
          // @ts-expect-error — payload dinâmico, validado em runtime
          .upsert(validos, { onConflict: "tenant_id,filial_codigo" });
        if (error) {
          console.error("[tenant-oem] falha no upsert do chunk:", error.message);
          falhas += validos.length;
        } else {
          for (const r of validos) {
            const fk = String(r.filial_codigo ?? "");
            if (existentesSet.has(fk)) atualizados += 1;
            else inseridos += 1;
          }
        }
      }

      // Pausa entre chunks para não saturar a API da TabletCloud.
      if (i + CHUNK < candidatos.length) {
        await new Promise((r) => setTimeout(r, PAUSA_MS));
      }
    }

    const result: TenantSyncResult = {
      status: "sucesso",
      total: rows.length,
      inseridos,
      atualizados,
      falhas,
      duracaoMs: Date.now() - inicio,
      mensagem: `${inseridos} novo(s), ${atualizados} atualizado(s), ${falhas} falha(s).`,
    };
    await finalizarLog(logId, result);
    return result;
  } catch (e) {
    const result: TenantSyncResult = {
      status: "erro",
      total: 0,
      inseridos: 0,
      atualizados: 0,
      falhas: 0,
      duracaoMs: Date.now() - inicio,
      mensagem: e instanceof Error ? e.message : String(e),
    };
    await finalizarLog(logId, result);
    return result;
  }
}

// ============================================================
// Bloquear / Desbloquear licença diretamente no OEM
// 1. Token compartilhado em cache (renova só quando vence ou 401)
// 2. GET /v1/licenciamento/{emp}/{fil} → body raw
// 3. PUT mesmo body com bloquearLicenca = true|false
// 4. Atualiza linha local em clientes_oem para refletir na UI
// ============================================================
export async function alterarStatusLicencaTenant(
  tenantId: string,
  codEmpresa: number,
  codFilial: number,
  bloquear: boolean,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  try {
    const creds = await loadTenantCreds(tenantId);
    const url = `${creds.baseUrl}/v1/licenciamento/${codEmpresa}/${codFilial}`;

    // ---- GET licença atual (corpo completo, sem unwrap)
    const getResp = await fetchOemAutenticado(tenantId, creds, url, { method: "GET" });
    if (!getResp.ok) {
      const preview = await getResp.text().catch(() => "");
      throw new Error(`GET licença OEM HTTP ${getResp.status}: ${preview.slice(0, 180)}`);
    }
    const raw = (await getResp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      throw new Error("GET licença OEM retornou payload inválido.");
    }

    // ---- Aplica a flag no objeto certo (pode vir embrulhado em response.data/data)
    const setFlag = (obj: Record<string, unknown>) => {
      obj.bloquearLicenca = bloquear;
    };
    setFlag(raw);
    const response = (raw.response as Record<string, unknown> | undefined) ?? undefined;
    if (response && typeof response === "object") {
      setFlag(response);
      const respData = (response.data as Record<string, unknown> | undefined) ?? undefined;
      if (respData && typeof respData === "object") setFlag(respData);
    }
    const data = (raw.data as Record<string, unknown> | undefined) ?? undefined;
    if (data && typeof data === "object") setFlag(data);

    // ---- PUT corpo completo
    const putResp = await fetchOemAutenticado(tenantId, creds, url, {
      method: "PUT",
      body: JSON.stringify(raw),
    });
    if (!putResp.ok) {
      const preview = await putResp.text().catch(() => "");
      throw new Error(`PUT licença OEM HTTP ${putResp.status}: ${preview.slice(0, 180)}`);
    }

    // ---- Reflete imediatamente no Supabase (sem esperar a sync)
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("clientes_oem")
      .update({
        bloqueado: bloquear,
        motivo_bloqueio: bloquear ? "Bloqueio manual via Nexus Hub" : null,
      })
      .eq("tenant_id", tenantId)
      .eq("empresa_codigo", String(codEmpresa))
      .eq("filial_codigo", String(codFilial));
    if (error) {
      console.error("[tenant-oem] OEM atualizado, mas falha ao refletir local:", error.message);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================
// Reparo incremental: re-puxa do OEM só os clientes que estão
// zerados (sem custo / sem módulos / sem PDV). Processa em batches
// pequenos e retorna progresso para o cliente chamar em loop até
// zerar a fila — assim cada chamada cabe no tempo do Worker.
// ============================================================
export type RepairBatchResult = {
  processados: number;
  atualizados: number;
  falhas: number;
  restantes: number;
  totalZerados: number;
};

export async function repararZeradosTenant(
  tenantId: string,
  batchSize = 40,
): Promise<RepairBatchResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Conta total de candidatos zerados (para o cliente saber o restante)
  const { count: totalZerados } = await supabaseAdmin
    .from("clientes_oem")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .or("custo_total.is.null,custo_total.eq.0,modulos_ativos.is.null");

  if (!totalZerados || totalZerados === 0) {
    return { processados: 0, atualizados: 0, falhas: 0, restantes: 0, totalZerados: 0 };
  }

  // Busca o próximo lote
  const { data: candidatos, error: selErr } = await supabaseAdmin
    .from("clientes_oem")
    .select("id, empresa_codigo, filial_codigo, numero_filiais")
    .eq("tenant_id", tenantId)
    .or("custo_total.is.null,custo_total.eq.0,modulos_ativos.is.null")
    .order("nome_fantasia", { ascending: true })
    .limit(batchSize);

  if (selErr) throw new Error(`Listagem zerados: ${selErr.message}`);
  const lote = (candidatos ?? []).filter((c) => c.empresa_codigo && c.filial_codigo);
  if (lote.length === 0) {
    return { processados: 0, atualizados: 0, falhas: 0, restantes: 0, totalZerados };
  }

  const creds = await loadTenantCreds(tenantId);
  const tokenInicial = await obterTokenTenant(tenantId, creds);
  const tokenHolder = criarTokenHolderTenant(tenantId, creds, tokenInicial);

  // Processa em sub-chunks paralelos de 10 (cuidado com rate limit da OEM)
  const CHUNK = 10;
  let atualizados = 0;
  let falhas = 0;

  for (let i = 0; i < lote.length; i += CHUNK) {
    const subLote = lote.slice(i, i + CHUNK);
    const resultados = await Promise.all(
      subLote.map(async (c) => {
        const codEmpresa = Number(c.empresa_codigo);
        const codFilial = Number(c.filial_codigo);
        if (!Number.isFinite(codEmpresa) || !Number.isFinite(codFilial)) return false;
        try {
          const detalhe = await fetchLicenciamentoOem(tokenHolder, codEmpresa, codFilial);
          if (!detalhe) return false;
          const row = mapLicenciamentoToRow(detalhe, codEmpresa, codFilial);
          if (!row) return false;
          const blindada = blindarRow(row);
          if ((c.numero_filiais ?? 0) > 0) blindada.numero_filiais = c.numero_filiais;
          const payload = { ...blindada, tenant_id: tenantId } as Record<string, unknown>;
          const { error: upErr } = await supabaseAdmin
            .from("clientes_oem")
            // @ts-expect-error — payload dinâmico
            .update(payload)
            .eq("id", c.id);
          if (upErr) {
            console.error(`[repararZerados] update ${c.id}:`, upErr.message);
            return false;
          }
          return true;
        } catch (err) {
          console.error(
            `[repararZerados] falha ${codEmpresa}/${codFilial}:`,
            err instanceof Error ? err.message : err,
          );
          return false;
        }
      }),
    );
    for (const ok of resultados) {
      if (ok) atualizados += 1;
      else falhas += 1;
    }
    // Pausa curta entre sub-chunks para não estourar rate limit
    if (i + CHUNK < lote.length) await new Promise((r) => setTimeout(r, 250));
  }

  const restantes = Math.max(0, totalZerados - atualizados);
  return {
    processados: lote.length,
    atualizados,
    falhas,
    restantes,
    totalZerados,
  };
}

// ============================================================
// Ativar / Desativar cliente diretamente no OEM
// Mesmo padrão de bloquear/desbloquear, mas alterando o status
// operacional da filial (filial.status: "AT" | "IN" e filial.ativo).
// ============================================================
export async function alterarStatusAtivacaoTenant(
  tenantId: string,
  codEmpresa: number,
  codFilial: number,
  ativar: boolean,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  try {
    const creds = await loadTenantCreds(tenantId);
    const url = `${creds.baseUrl}/v1/licenciamento/${codEmpresa}/${codFilial}`;

    const getResp = await fetchOemAutenticado(tenantId, creds, url, { method: "GET" });
    if (!getResp.ok) {
      const preview = await getResp.text().catch(() => "");
      throw new Error(`GET licença OEM HTTP ${getResp.status}: ${preview.slice(0, 180)}`);
    }
    const raw = (await getResp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      throw new Error("GET licença OEM retornou payload inválido.");
    }

    // Aplica em todos os "envelopes" possíveis + filial aninhada.
    const applyAtivar = (obj: Record<string, unknown>) => {
      obj.ativo = ativar;
      if (obj.filial && typeof obj.filial === "object" && !Array.isArray(obj.filial)) {
        const filial = obj.filial as Record<string, unknown>;
        filial.ativo = ativar;
        filial.status = ativar ? "AT" : "IN";
      }
    };
    applyAtivar(raw);
    const response = (raw.response as Record<string, unknown> | undefined) ?? undefined;
    if (response && typeof response === "object") {
      applyAtivar(response);
      const respData = (response.data as Record<string, unknown> | undefined) ?? undefined;
      if (respData && typeof respData === "object") applyAtivar(respData);
    }
    const data = (raw.data as Record<string, unknown> | undefined) ?? undefined;
    if (data && typeof data === "object") applyAtivar(data);

    const putResp = await fetchOemAutenticado(tenantId, creds, url, {
      method: "PUT",
      body: JSON.stringify(raw),
    });
    if (!putResp.ok) {
      const preview = await putResp.text().catch(() => "");
      throw new Error(`PUT licença OEM HTTP ${putResp.status}: ${preview.slice(0, 180)}`);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("clientes_oem")
      .update({ status: ativar ? "Ativo" : "Desativado" })
      .eq("tenant_id", tenantId)
      .eq("empresa_codigo", String(codEmpresa))
      .eq("filial_codigo", String(codFilial));
    if (error) {
      console.error("[tenant-oem] OEM atualizado, mas falha ao refletir local:", error.message);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : String(e) };
  }
}