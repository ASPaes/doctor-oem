// ============================================================================
// oem-provisionar — o DoctorSaaS liga uma empresa ao OEM sem ninguém abrir o
// DoctorOEM (DEM-0516).
//
// Duas formas de chamar, e a autenticação decide qual:
//
//   x-provisionamento-secret  — segredo de PLATAFORMA (Vault dos dois lados).
//       Acha a empresa pelo de-para (tenant DS, unidade) ou CRIA uma nova,
//       grava as credenciais e devolve uma chave oem_live_ nova. A chave
//       anterior emitida por este caminho é revogada.
//
//   x-api-key                 — chave de uma empresa que já existe.
//       Só troca as credenciais dela. Não cria nada e não emite chave.
//
// A ORDEM É O QUE IMPEDE LIXO: as credenciais são testadas no /token do
// parceiro ANTES de qualquer escrita aqui. Senha errada não deixa empresa
// órfã. O token obtido vai para o oem_token_cache, para o oem-sync-passo não
// pedir outro em seguida (o /token responde 429 com facilidade).
//
// A empresa nunca é casada por CNPJ — ver a migration 20261005120000.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, x-provisionamento-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BASE_PADRAO = "https://api.pdvlegal.com.br";

function json(corpo: Record<string, unknown>, status = 200) {
  return Response.json(corpo, { status, headers: cors });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexAleatorio(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slugDe(nome: string): string {
  const base = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "empresa";
  return `${base}-${hexAleatorio(2)}`;
}

function texto(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

type Creds = { baseUrl: string; username: string; password: string; clientId: string; clientSecret: string };

/** UMA tentativa só: repetir no 429 amplia o bloqueio do parceiro. */
async function pedirToken(c: Creds): Promise<{ token: string; expiraEm: string }> {
  const resp = await fetch(`${c.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      username: c.username, password: c.password, grant_type: "password",
      client_id: c.clientId, client_secret: c.clientSecret,
    }).toString(),
  });
  if (resp.status === 429) {
    throw new Error("O parceiro bloqueou por excesso de tentativas. Aguarde alguns minutos e tente de novo.");
  }
  if (resp.status === 400 || resp.status === 401) {
    throw new Error("O PDV Legal recusou o usuário, a senha, o Client ID ou o Client Secret.");
  }
  if (!resp.ok) {
    const prev = await resp.text().catch(() => "");
    throw new Error(`PDV Legal respondeu HTTP ${resp.status}: ${prev.slice(0, 160)}`);
  }
  const j = await resp.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof j.access_token !== "string") throw new Error("O PDV Legal respondeu sem access_token.");
  const vida = Number(j.expires_in);
  return {
    token: j.access_token,
    expiraEm: new Date(Date.now() + (Number.isFinite(vida) && vida > 0 ? vida : 3600) * 1000).toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, mensagem: "Use POST." }, 405);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const corpo = await req.json().catch(() => ({})) as Record<string, unknown>;
    const cred = (corpo.credenciais ?? {}) as Record<string, unknown>;
    const segredo = req.headers.get("x-provisionamento-secret") ?? "";
    const chaveEmpresa = req.headers.get("x-api-key") ?? "";

    // ------------------------------------------------------------ quem chama
    let tenantId: string | null = null;
    let provisionamento: { id: string; chave_id: string | null } | null = null;
    let porPlataforma = false;
    let adotada = false;
    const origemTenant = texto(corpo.origem_tenant_id, 36);
    const origemUnidade = Number(corpo.origem_unidade_id);

    if (segredo) {
      const { data: ok, error } = await db.rpc("fn_provisionamento_segredo_ok", { p_segredo: segredo });
      if (error || ok !== true) return json({ ok: false, mensagem: "Não autorizado." }, 401);
      if (!/^[0-9a-f-]{36}$/i.test(origemTenant) || !Number.isSafeInteger(origemUnidade) || origemUnidade <= 0) {
        return json({ ok: false, mensagem: "origem_tenant_id e origem_unidade_id são obrigatórios." }, 400);
      }
      porPlataforma = true;
      const { data: mapa, error: errMapa } = await db.from("oem_provisionamento")
        .select("id, tenant_id, chave_id")
        .eq("origem", "doctorsaas").eq("origem_tenant_id", origemTenant).eq("origem_unidade_id", origemUnidade)
        .maybeSingle();
      if (errMapa) throw new Error(`oem_provisionamento: ${errMapa.message}`);
      if (mapa) {
        tenantId = String(mapa.tenant_id);
        provisionamento = { id: String(mapa.id), chave_id: mapa.chave_id as string | null };
      } else if (chaveEmpresa) {
        // ADOÇÃO: empresa criada à mão aqui e ligada no DS pela chave colada
        // (Digi, Delvale). Ter a chave prova que a empresa é de quem chama —
        // é o que o CNPJ NÃO prova. Registra o de-para e segue como se ela
        // tivesse nascido por este caminho.
        const { data: reg } = await db.from("oem_api_chaves")
          .select("id, tenant_id, ativa, revogada_em").eq("token_hash", await sha256Hex(chaveEmpresa)).maybeSingle();
        if (!reg || !reg.ativa || reg.revogada_em) return json({ ok: false, mensagem: "Chave inválida." }, 401);
        tenantId = String(reg.tenant_id);
        const { data: m, error: errM } = await db.from("oem_provisionamento").insert({
          origem_tenant_id: origemTenant, origem_unidade_id: origemUnidade,
          tenant_id: tenantId, chave_id: reg.id,
        }).select("id").single();
        if (errM) throw new Error(`oem_provisionamento: ${errM.message}`);
        provisionamento = { id: String(m.id), chave_id: String(reg.id) };
        adotada = true;
      }
    } else if (chaveEmpresa) {
      const { data: reg } = await db.from("oem_api_chaves")
        .select("tenant_id, ativa, revogada_em").eq("token_hash", await sha256Hex(chaveEmpresa)).maybeSingle();
      if (!reg || !reg.ativa || reg.revogada_em) return json({ ok: false, mensagem: "Chave inválida." }, 401);
      tenantId = String(reg.tenant_id);
    } else {
      return json({ ok: false, mensagem: "Não autorizado." }, 401);
    }

    // ------------------------------------------- credenciais: monta e testa
    // Senha e secret em branco = manter as atuais (só existe se a empresa já existe).
    let atuais: Record<string, string | null> = {};
    if (tenantId) {
      const { data } = await db.rpc("obter_credenciais_oem", { p_tenant_id: tenantId });
      atuais = (data ?? {}) as Record<string, string | null>;
    }
    const creds: Creds = {
      baseUrl: (texto(cred.base_url) || atuais.base_url || BASE_PADRAO).replace(/\/+$/, ""),
      username: texto(cred.username) || atuais.username || "",
      password: texto(cred.password) || atuais.password || "",
      clientId: texto(cred.client_id) || atuais.client_id || "",
      clientSecret: texto(cred.client_secret) || atuais.client_secret || "",
    };
    if (!/^https:\/\/[^\s/]+/i.test(creds.baseUrl)) {
      return json({ ok: false, etapa: "validacao", mensagem: "A URL base precisa começar com https://." }, 400);
    }
    const faltando = [
      !creds.username && "usuário", !creds.password && "senha",
      !creds.clientId && "Client ID", !creds.clientSecret && "Client Secret",
    ].filter(Boolean);
    if (faltando.length) {
      return json({ ok: false, etapa: "validacao", mensagem: `Preencha: ${faltando.join(", ")}.` }, 400);
    }

    let token: { token: string; expiraEm: string };
    try {
      token = await pedirToken(creds);
    } catch (e) {
      // Nada foi gravado até aqui.
      return json({ ok: false, etapa: "credenciais", mensagem: e instanceof Error ? e.message : String(e) }, 422);
    }

    // --------------------------------------------- empresa (só pela plataforma)
    let criada = false;
    if (!tenantId) {
      const nome = texto(corpo.nome, 120);
      if (nome.length < 2) return json({ ok: false, etapa: "validacao", mensagem: "Informe o nome da empresa." }, 400);
      const cnpj = texto(corpo.cnpj, 20).replace(/\D/g, "") || null;
      const { data: t, error: errT } = await db.from("tenants")
        .insert({ nome, slug: slugDe(nome), cnpj }).select("id").single();
      if (errT) throw new Error(`tenants: ${errT.message}`);
      tenantId = String(t.id);
      criada = true;

      // O de-para entra JÁ: se algo abaixo falhar, a repetição acha esta
      // empresa em vez de criar uma segunda.
      const { data: m, error: errM } = await db.from("oem_provisionamento").insert({
        origem_tenant_id: origemTenant, origem_unidade_id: origemUnidade, tenant_id: tenantId,
      }).select("id").single();
      if (errM) throw new Error(`oem_provisionamento: ${errM.message}`);
      provisionamento = { id: String(m.id), chave_id: null };
    }

    const { error: errC } = await db.rpc("salvar_credenciais_oem_servico", {
      p_tenant_id: tenantId,
      p_base_url: creds.baseUrl,
      p_username: creds.username,
      p_client_id: creds.clientId,
      p_password: creds.password,
      p_client_secret: creds.clientSecret,
      p_method: "password",
    });
    if (errC) throw new Error(`salvar_credenciais_oem_servico: ${errC.message}`);

    const { error: errTk } = await db.from("oem_token_cache").upsert({
      tenant_id: tenantId, token: token.token, expira_em: token.expiraEm,
      cooldown_ate: null, atualizado_em: new Date().toISOString(),
    }, { onConflict: "tenant_id" });
    if (errTk) console.error("[oem-provisionar] oem_token_cache:", errTk.message);

    // ----------------------------------------------------- chave de integração
    let chave: string | null = null;
    // Adotada: a chave colada continua valendo — trocá-la agora só daria ao DS
    // mais um ponto onde a gravação pode falhar no meio.
    if (porPlataforma && provisionamento && !adotada) {
      chave = "oem_live_" + hexAleatorio(24);
      const { data: k, error: errK } = await db.from("oem_api_chaves").insert({
        tenant_id: tenantId,
        nome: "DoctorSaaS (conectada pelo DoctorSaaS)",
        token_hash: await sha256Hex(chave),
        prefixo: chave.slice(0, 17),
      }).select("id").single();
      if (errK) throw new Error(`oem_api_chaves: ${errK.message}`);

      if (provisionamento.chave_id) {
        await db.from("oem_api_chaves")
          .update({ ativa: false, revogada_em: new Date().toISOString() })
          .eq("id", provisionamento.chave_id);
      }
      await db.from("oem_provisionamento")
        .update({ chave_id: k.id, atualizado_em: new Date().toISOString() })
        .eq("id", provisionamento.id);
    }

    return json({ ok: true, tenant_id: tenantId, empresa_criada: criada, empresa_adotada: adotada, chave });
  } catch (e) {
    console.error("[oem-provisionar]", e);
    return json({ ok: false, etapa: "interno", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
});
