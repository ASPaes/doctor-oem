// ============================================================================
// Escrita no OEM — bloquear/desbloquear licença e ativar/desativar cliente.
//
// ---------------------------------------------------------------------------
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------------------------------------------------------
// O contrato correto está na documentação da API, não no e-mail:
//
//   POST https://api.tabletcloud.com.br/licenciamento/minhaslicencas/saveFilial
//   corpo = modelo Fiweb.Models.Licenciamentos.ModulosAPI
//
// E o detalhe que fecha o desenho: o GET
// /licenciamento/minhaslicencas/modulos/{codproduto}/{codgrupo}/{codloja}
// devolve EXATAMENTE esse mesmo modelo. A escrita é "leia o objeto, troque a
// flag, devolva o objeto" — por isso aqui se espalha o payload original e se
// acrescentam só as 7 flags que o GET não traz.
//
// ---------------------------------------------------------------------------
// DOIS ERROS QUE CUSTARAM CARO E NÃO PODEM VOLTAR
// ---------------------------------------------------------------------------
// 1. O e-mail do desenvolvedor indicava POST {pdvlegal}/v1/licenciamento/filial
//    com um corpo plano (codEmpresa/codFilial/nomeLoja/usuarios...). Esse
//    endpoint existe, mas valida diferente e NÃO é o documentado. Tentativa
//    real em 14/08 devolveu:
//        HTTP 400 ["Módulo 8 inválido para o produto 1"]
//    porque cada módulo precisa levar o `codproduto` e o `nome` que vieram da
//    API, e o corpo remontado à mão os descartava. Nada foi gravado.
//
// 2. NÃO montar o `modulos[]` a partir do detalhe do pdvlegal. Ele vem
//    incompleto (2 de 5 na PARRILLA GOLD) e às vezes VAZIO (`[]` na
//    VAPT-VUPT 10320/12312). Enviar isso apagaria os módulos do cliente.
//    A lista completa só existe no host documentado.
//
// ---------------------------------------------------------------------------
// 🚫 NÃO LIGUE ISTO. Teste real em 14/08/2026 destruiu a licença de um cliente.
// ---------------------------------------------------------------------------
// Testado na filial 12312 (grupo 10320, VAPT-VUPT CONVENIENCIA), que estava
// desativada e bloqueada. Duas escritas, ambas com HTTP 201:
//
//   1ª — objeto do GET com bloquearLicenca trocado para false.
//        Resultado: os 54 módulos ficaram INATIVOS e valorTotal foi a 0.
//   2ª — restauração: só os 4 módulos contratados, valores originais.
//        Resultado imediato: os 4 voltaram, MAS com preço de tabela —
//        Gestao 28,32 -> 39,90 e PDV/Comandas 16,88 -> 10,00. A API descarta
//        o valorUnitario enviado. O cliente tinha preço negociado; perdeu.
//        Minutos depois, sozinho, voltou tudo a zero de novo.
//
// Estado final: portal do OEM mostra zerado e não deixa editar; tabletcloud
// devolve 0 módulos ativos; pdvlegal devolve valorTotal 59,90 e pdvComandas 0.
// As três fontes divergem. Caso aberto com o fornecedor.
//
// CONCLUSÕES QUE IMPORTAM:
//   * saveFilial NÃO é uma operação pontual. Ele regrava a filial inteira, e
//     um efeito assíncrono do lado do OEM zera a licença depois.
//   * A lista de módulos enviada É a lista de contratados (mandar o catálogo
//     inteiro desativa tudo) — mas isso não salva o recurso, porque:
//   * O PREÇO enviado é ignorado e substituído pela tabela padrão. Bloquear um
//     cliente com preço negociado apagaria o preço dele em silêncio. Com 862
//     clientes ativos, seria um estrago comercial em série.
//
// Enquanto o fornecedor não indicar um caminho que altere SÓ a flag, este
// arquivo fica desligado. OEM_ESCRITA_HABILITADA="true" não é decisão técnica.
// ============================================================================
import { loadTenantCreds, obterTokenTenant, criarTokenHolderTenant } from "@/lib/tenant-oem.server";
import {
  tokenLeitura,
  buscarProdutos,
  buscarModulosBruto,
  oemGet,
  LEITURA_BASE,
} from "@/lib/oem-carga.server";

export type MudancaLicenca = {
  /** true = licença bloqueada (sistema do cliente indisponível). */
  bloquear?: boolean;
  /** true = cliente desativado (deixa de ser cobrado). */
  desativar?: boolean;
};

function escritaHabilitada(): boolean {
  return String(process.env.OEM_ESCRITA_HABILITADA ?? "").toLowerCase() === "true";
}

type DetalheFilial = {
  codEmpresa?: number;
  codProduto?: number;
  nomeProduto?: string;
  filial?: {
    codigo?: number;
    nome?: string;
    cnpj?: string;
    status?: string;
    bloqueado?: boolean;
    codTipoNegocio?: number;
    codDetalhesTipoNegocio?: number;
    codOrigemVenda?: number;
    usuarios?: number;
    pdvComandas?: number;
  };
};

/**
 * Aplica bloqueio e/ou desativação numa filial do OEM.
 * O que não for informado em `mudanca` é preservado como está hoje.
 */
export async function atualizarFilialOem(
  tenantId: string,
  codEmpresa: number,
  codFilial: number,
  mudanca: MudancaLicenca,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  if (!escritaHabilitada()) {
    return {
      ok: false,
      mensagem:
        "Escrita no OEM está desligada (OEM_ESCRITA_HABILITADA). Enquanto a estruturação " +
        "não terminar, o sistema só lê do OEM. Fale com o Alexandre para liberar.",
    };
  }

  try {
    const creds = await loadTenantCreds(tenantId);
    const escrita = criarTokenHolderTenant(tenantId, creds, await obterTokenTenant(tenantId, creds));

    // 1) Estado atual da filial — é a base do corpo, conforme o e-mail.
    const alvo = `licença ${codEmpresa}/${codFilial}`;
    const respGet = await oemGet(
      escrita,
      `${creds.baseUrl}/v1/licenciamento/${codEmpresa}/${codFilial}`,
      alvo,
    );
    if (!respGet.ok) throw new Error(`GET ${alvo} devolveu HTTP ${respGet.status}.`);
    const detalhe = (await respGet.json().catch(() => null)) as DetalheFilial | null;
    const filial = detalhe?.filial;
    if (!detalhe || !filial) throw new Error(`GET ${alvo} devolveu payload inesperado.`);

    // 2) O objeto da licença, BRUTO, do host documentado.
    const leitura = await tokenLeitura(creds);
    const produtos = await buscarProdutos(leitura);
    const nomeProduto = String(detalhe.nomeProduto ?? "").trim().toUpperCase();
    const codProduto =
      produtos[nomeProduto] ?? (detalhe.codProduto != null ? String(detalhe.codProduto) : null);
    if (!codProduto) {
      throw new Error(
        `Não foi possível resolver o código do produto "${detalhe.nomeProduto ?? "(vazio)"}".`,
      );
    }
    const bruto = await buscarModulosBruto(leitura, codProduto, codEmpresa, codFilial);
    const modulos = Array.isArray(bruto.modulos) ? bruto.modulos : [];
    if (!modulos.length) {
      throw new Error(
        "O OEM não devolveu a lista de módulos desta filial. Enviar o update sem ela poderia " +
          "apagar os módulos do cliente — operação abortada.",
      );
    }

    // 3) Corpo = o objeto lido, com as flags trocadas.
    //
    // O GET de /minhaslicencas/modulos devolve exatamente o modelo que o
    // saveFilial espera (ModulosAPI). Por isso NÃO remontamos nada campo a
    // campo: espalhamos o objeto original e acrescentamos só as 7 flags que o
    // GET não traz. Remontar à mão foi o que causou o HTTP 400
    // "Módulo 8 inválido para o produto 1" — cada módulo precisa levar o
    // `codproduto` e o `nome` que vieram da API, e eu os estava descartando.
    const corpo = {
      ...bruto,
      codigoTipoNegocio: filial.codTipoNegocio ?? 0,
      codigoDetalhesTipoNegocio: filial.codDetalhesTipoNegocio ?? 0,
      codigoOrigemVenda: filial.codOrigemVenda ?? 0,
      // O que não foi pedido continua como está hoje.
      bloquearLicenca: mudanca.bloquear ?? filial.bloqueado === true,
      desativarLicenca: mudanca.desativar ?? String(filial.status).toUpperCase() !== "AT",
      usuariosAdicionais: filial.usuarios ?? 0,
      pdvComandas: filial.pdvComandas ?? 0,
    };

    // 4) POST no endpoint DOCUMENTADO, no host documentado.
    // O e-mail citava POST {pdvlegal}/v1/licenciamento/filial; esse endpoint
    // existe, mas valida diferente e não é o da documentação.
    const respPost = await fetch(`${LEITURA_BASE}/licenciamento/minhaslicencas/saveFilial`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${leitura.value}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(corpo),
    });
    if (!respPost.ok) {
      const preview = (await respPost.text().catch(() => "")).slice(0, 240);
      throw new Error(`POST /minhaslicencas/saveFilial devolveu HTTP ${respPost.status}: ${preview}`);
    }

    // 5) Reflete localmente só o que foi realmente pedido.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: { bloqueado?: boolean; motivo_bloqueio?: string | null; status?: string } = {};
    if (mudanca.bloquear !== undefined) {
      patch.bloqueado = mudanca.bloquear;
      patch.motivo_bloqueio = mudanca.bloquear ? "Bloqueio manual via Nexus Hub" : null;
    }
    if (mudanca.desativar !== undefined) {
      patch.status = mudanca.desativar ? "Desativado" : "Ativo";
    }
    if (Object.keys(patch).length) {
      const { error } = await supabaseAdmin
        .from("clientes_oem")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("empresa_codigo", String(codEmpresa))
        .eq("filial_codigo", String(codFilial));
      if (error) {
        console.error("[oem-escrita] OEM atualizado, mas falha ao refletir local:", error.message);
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : String(e) };
  }
}
