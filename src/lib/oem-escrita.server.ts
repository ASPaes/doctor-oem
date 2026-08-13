// ============================================================================
// Escrita no OEM — bloquear/desbloquear licença e ativar/desativar cliente.
//
// ---------------------------------------------------------------------------
// POR QUE ESTE ARQUIVO EXISTE
// ---------------------------------------------------------------------------
// O código anterior fazia `PUT /v1/licenciamento/{emp}/{fil}` devolvendo o
// payload inteiro do GET com uma flag trocada, e para ativar/desativar mexia em
// `filial.ativo` e `filial.status` — campos que NÃO existem no contrato de
// atualização. O desenvolvedor do OEM documentou por e-mail o caminho correto:
//
//   POST {base}/v1/licenciamento/filial
//   { codEmpresa, codFilial, codProduto, nomeLoja, cpfCnpj,
//     codigoTipoNegocio, codigoDetalhesTipoNegocio, codigoOrigemVenda,
//     bloquearLicenca, desativarLicenca, usuarios, pdvComandas,
//     modulos: [{ codigo, ativo, quantidade, valorUnitario, valorTotal }] }
//
// "Se você for atualizar, você pode pegar os dados da filial em
//  v1/licenciamento/{codempresa}/{codfilial} e depois passar os dados como
//  parâmetro no endpoint acima."
//
// ---------------------------------------------------------------------------
// ⚠️ O CUIDADO QUE NÃO PODE SER PERDIDO
// ---------------------------------------------------------------------------
// O corpo do update leva a lista de módulos INTEIRA. E o `modulos[]` que o
// detalhe do pdvlegal devolve vem INCOMPLETO — para a PARRILLA GOLD ele traz
// 2 de 5, faltando "Gestao" (R$ 39,90) e "PDV/Comandas" (2 × R$ 10,00).
// Montar o corpo com essa lista provavelmente APAGARIA os módulos ausentes da
// licença do cliente. Por isso os módulos vêm do host de LEITURA
// (/minhaslicencas/modulos), que devolve a lista completa com valor unitário.
//
// ---------------------------------------------------------------------------
// TRAVA DE SEGURANÇA
// ---------------------------------------------------------------------------
// Nada aqui roda sem OEM_ESCRITA_HABILITADA="true". A regra vigente do projeto
// é não alterar nada no OEM enquanto a estruturação não termina, e essa regra
// passa a ser garantida pelo código, não pela disciplina de não clicar.
// ============================================================================
import { loadTenantCreds, obterTokenTenant, criarTokenHolderTenant } from "@/lib/tenant-oem.server";
import { tokenLeitura, buscarProdutos, buscarModulos, oemGet } from "@/lib/oem-carga.server";

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

    // 2) Módulos COMPLETOS, do host de leitura. Ver o aviso no topo do arquivo.
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
    const { modulos } = await buscarModulos(leitura, codProduto, codEmpresa, codFilial);
    if (!modulos.length) {
      throw new Error(
        "O OEM não devolveu a lista de módulos desta filial. Enviar o update sem ela poderia " +
          "apagar os módulos do cliente — operação abortada.",
      );
    }

    // 3) Corpo exatamente no formato documentado.
    const corpo = {
      codEmpresa,
      codFilial,
      codProduto: Number(codProduto),
      nomeLoja: filial.nome ?? "",
      cpfCnpj: filial.cnpj ?? "",
      codigoTipoNegocio: filial.codTipoNegocio ?? 0,
      codigoDetalhesTipoNegocio: filial.codDetalhesTipoNegocio ?? 0,
      codigoOrigemVenda: filial.codOrigemVenda ?? 0,
      // O que não foi pedido continua como está.
      bloquearLicenca: mudanca.bloquear ?? filial.bloqueado === true,
      desativarLicenca: mudanca.desativar ?? String(filial.status).toUpperCase() !== "AT",
      usuarios: filial.usuarios ?? 0,
      pdvComandas: filial.pdvComandas ?? 0,
      modulos: modulos.map((m) => ({
        codigo: Number(m.codigo ?? 0),
        ativo: m.ativo === undefined ? true : Boolean(m.ativo),
        quantidade: Number(m.quantidade ?? 0),
        valorUnitario: Number(m.valorUnitario ?? 0),
        valorTotal: Number(m.valorTotal ?? m.total ?? 0),
      })),
    };

    // 4) POST no endpoint correto.
    const respPost = await fetch(`${creds.baseUrl}/v1/licenciamento/filial`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${escrita.value}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(corpo),
    });
    if (!respPost.ok) {
      const preview = (await respPost.text().catch(() => "")).slice(0, 240);
      throw new Error(`POST /v1/licenciamento/filial devolveu HTTP ${respPost.status}: ${preview}`);
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
