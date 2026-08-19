// ============================================================================
// oem-licenca-modulo — dá baixa (ou reduz a quantidade) de UM módulo de UMA
// filial, no OEM.
//
// POR QUE ELA É ASSIM
//
// A API do parceiro não tem rota de módulo. O que existe é
// `POST /v1/licenciamento/filial`, que salva a FILIAL INTEIRA: tipo de
// negócio, origem da venda, bloqueio, desativação, usuários, PDVs e a lista
// de módulos. Mandar um payload incompleto não dá erro — ele grava o que
// veio, e some com o resto.
//
// Por isso o desenho é LER-MODIFICAR-GRAVAR: busca a filial em
// `GET /v1/licenciamento/{empresa}/{filial}`, troca só o módulo alvo e devolve
// tudo o mais como estava. E, antes de gravar, confere se os campos que não
// temos como inventar vieram na leitura — `codigoTipoNegocio`,
// `codigoDetalhesTipoNegocio`, `codigoOrigemVenda`, `codProduto`. Faltando
// qualquer um, ela NÃO grava: devolve o que faltou e o payload cru da leitura.
// Perder o tipo de negócio de um cliente é pior do que não dar a baixa.
//
// `simular: true` devolve exatamente o que seria enviado, sem enviar. É assim
// que se confere um mapeamento de campo antes de escrever no sistema do
// parceiro.
//
// Autentica por x-api-key, igual à `oem-exportar`: quem chama é o DoctorSaaS.
// ============================================================================
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Creds = {
  baseUrl: string; username: string; password: string;
  clientId: string; clientSecret: string; method: string;
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

// A leitura e a escrita não usam o mesmo nome para o mesmo campo, e nem sempre
// a mesma caixa. Em vez de adivinhar, procura por todos os apelidos plausíveis
// — e quem decide se achou é o guarda lá embaixo, não esta função.
function pega(obj: Record<string, unknown>, ...nomes: string[]): unknown {
  for (const n of nomes) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === n.toLowerCase() && obj[k] !== null && obj[k] !== undefined) {
        return obj[k];
      }
    }
  }
  return undefined;
}
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

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
      return Response.json({ ok: false, mensagem: "Chave inválida." }, { status: 401, headers: cors });
    }

    const corpo = await req.json().catch(() => ({} as Record<string, unknown>));
    const empresa = String(corpo.empresa ?? "").replace(/\D/g, "");
    const filial = String(corpo.filial ?? "").replace(/\D/g, "");
    const moduloCodigo = num(corpo.modulo_codigo);
    // null/0 = desliga o módulo. Número > 0 = fica ligado com essa quantidade.
    const novaQtd = num(corpo.nova_quantidade) ?? 0;
    const simular = corpo.simular === true;

    if (!empresa || !filial || moduloCodigo === undefined) {
      return Response.json(
        { ok: false, mensagem: 'Informe empresa, filial e modulo_codigo. Ex.: {"empresa":"32801","filial":"39751","modulo_codigo":10,"nova_quantidade":1}' },
        { status: 400, headers: cors },
      );
    }

    const creds = await carregarCreds(db, String(registro.tenant_id));
    const token = await obterToken(creds.baseUrl, creds);

    // ------------------------------------------------------------------ ler
    const rLer = await fetch(`${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const cruTexto = await rLer.text().catch(() => "");
    let cru: Record<string, unknown> = {};
    try { cru = JSON.parse(cruTexto); } catch { /* fica o texto no erro abaixo */ }
    if (!rLer.ok) {
      return Response.json(
        { ok: false, etapa: "leitura", http: rLer.status, corpo: cruTexto.slice(0, 500) },
        { status: 502, headers: cors },
      );
    }

    const f = (cru.filial ?? cru) as Record<string, unknown>;
    const modulosCrus = (pega(f, "modulos") ?? pega(cru, "modulos")) as Record<string, unknown>[] | undefined;

    const payload: Record<string, unknown> = {
      codEmpresa: num(pega(f, "codEmpresa", "codempresa", "codgrupoeconomico", "codgrupo")) ?? Number(empresa),
      codFilial: num(pega(f, "codFilial", "codfilial", "codloja")) ?? Number(filial),
      codProduto: num(pega(f, "codProduto", "codproduto")),
      nomeLoja: pega(f, "nomeLoja", "nomeloja", "nomefilial", "nome"),
      cpfCnpj: pega(f, "cpfCnpj", "cpf_cnpj", "cnpjloja", "cnpJloja", "cnpj"),
      codigoTipoNegocio: num(pega(f, "codigoTipoNegocio", "codtiponegocio", "tipoNegocio")),
      codigoDetalhesTipoNegocio: num(pega(f, "codigoDetalhesTipoNegocio", "coddetalhestiponegocio", "detalhesTipoNegocio")),
      codigoOrigemVenda: num(pega(f, "codigoOrigemVenda", "codorigemvenda", "origemVenda")),
      bloquearLicenca: pega(f, "bloquearLicenca", "bloqueado", "bloquear") === true,
      desativarLicenca: pega(f, "desativarLicenca", "desativado") === true
        || pega(f, "ativo") === false,
      usuarios: num(pega(f, "usuarios", "usuariosAdicionais", "usuariosadicionais")) ?? 0,
      pdvComandas: num(pega(f, "pdvComandas", "pdvcomandas")) ?? 0,
    };

    // ------------------------------------------------------------- o guarda
    const faltando: string[] = [];
    for (const k of ["codProduto", "codigoTipoNegocio", "codigoDetalhesTipoNegocio", "codigoOrigemVenda"]) {
      if (payload[k] === undefined) faltando.push(k);
    }
    if (!Array.isArray(modulosCrus) || modulosCrus.length === 0) faltando.push("modulos");
    if (faltando.length) {
      return Response.json({
        ok: false,
        etapa: "mapeamento",
        mensagem: "A leitura da filial não trouxe campos obrigatórios da gravação. Nada foi enviado ao OEM.",
        faltando,
        // O payload cru é a resposta: com ele o mapeamento se conserta numa
        // tentativa, em vez de tentar nome por nome no escuro.
        leitura_crua: cru,
      }, { status: 422, headers: cors });
    }

    let achou = false;
    payload.modulos = modulosCrus.map((m) => {
      const cod = num(pega(m, "codigo", "codModulo", "cod"));
      const qtd = num(pega(m, "quantidade", "qtd")) ?? 0;
      const unit = num(pega(m, "valorUnitario", "valor_unitario", "valorunitario")) ?? 0;
      const total = num(pega(m, "valorTotal", "valor_total", "valortotal")) ?? unit * qtd;
      const ativo = pega(m, "ativo") !== false;

      if (cod !== moduloCodigo) {
        return { codigo: cod, ativo, quantidade: qtd, valorUnitario: unit, valorTotal: total };
      }
      achou = true;
      if (novaQtd > 0) {
        return {
          codigo: cod, ativo: true, quantidade: novaQtd,
          valorUnitario: unit, valorTotal: Math.round(unit * novaQtd * 100) / 100,
        };
      }
      return { codigo: cod, ativo: false, quantidade: 0, valorUnitario: unit, valorTotal: 0 };
    });

    // Módulo que ainda não está na licença só entra se vier valor: sem preço,
    // ele seria acrescentado valendo zero e o parceiro deixaria de cobrar algo
    // que o cliente passou a usar.
    if (!achou && novaQtd > 0) {
      const unit = num(corpo.valor_unitario);
      if (unit === undefined) {
        return Response.json({
          ok: false, etapa: "modulo",
          mensagem: `O módulo ${moduloCodigo} não está na licença ${empresa}/${filial}. Para acrescentá-lo, informe valor_unitario.`,
        }, { status: 400, headers: cors });
      }
      (payload.modulos as unknown[]).push({
        codigo: moduloCodigo, ativo: true, quantidade: novaQtd,
        valorUnitario: unit, valorTotal: Math.round(unit * novaQtd * 100) / 100,
      });
      achou = true;
    }

    if (!achou) {
      return Response.json({
        ok: false, etapa: "modulo",
        mensagem: `A licença ${empresa}/${filial} não tem o módulo ${moduloCodigo}. Nada foi enviado.`,
        modulos_na_licenca: modulosCrus.map((m) => pega(m, "codigo", "codModulo", "cod")),
      }, { status: 404, headers: cors });
    }

    if (simular) {
      return Response.json({ ok: true, simulado: true, payload, leitura_crua: cru }, { headers: cors });
    }

    // ---------------------------------------------------------------- gravar
    const rGravar = await fetch(`${creds.baseUrl}/v1/licenciamento/filial`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const respTexto = await rGravar.text().catch(() => "");
    let resposta: unknown = respTexto;
    try { resposta = JSON.parse(respTexto); } catch { /* texto puro serve */ }

    return Response.json(
      { ok: rGravar.ok, http: rGravar.status, payload, resposta },
      { status: rGravar.ok ? 200 : 502, headers: cors },
    );
  } catch (e) {
    return Response.json(
      { ok: false, mensagem: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: cors },
    );
  }
});
