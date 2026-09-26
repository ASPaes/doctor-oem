// ============================================================================
// oem-licenca-modulo — escreve na licença de UMA filial do OEM. Três modos:
//
//   módulo   modulo_codigo + nova_quantidade      dá baixa ou muda a quantidade
//   cadastro novo_nome / novo_cnpj                (desde 24/08/2026)
//   estado   novo_bloqueado / novo_desativado     (desde 01/09/2026)
//
// Os três passam pelo mesmo ler-modificar-gravar porque a API do parceiro tem
// uma rota só, que salva a filial inteira. Quem manda os campos de cadastro ou
// de estado sem modulo_codigo cai no modo correspondente: os módulos voltam
// idênticos aos lidos e só os campos pedidos mudam.
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
async function carregarCreds(db, tenantId) {
  const { data, error } = await db.rpc("obter_credenciais_oem", {
    p_tenant_id: tenantId
  });
  if (error) throw new Error(`obter_credenciais_oem: ${error.message}`);
  if (!data) throw new Error("Credenciais OEM não cadastradas para esta empresa.");
  const c = data;
  const faltando = [
    "username",
    "password",
    "client_id",
    "client_secret"
  ].filter((k)=>!c[k]);
  if (faltando.length) throw new Error(`Credenciais OEM incompletas: ${faltando.join(", ")}.`);
  return {
    baseUrl: (c.base_url ?? "https://api.pdvlegal.com.br").replace(/\/+$/, ""),
    username: c.username,
    password: c.password,
    clientId: c.client_id,
    clientSecret: c.client_secret,
    method: c.method ?? "password"
  };
}
async function obterToken(base, creds) {
  const resp = await fetch(`${base}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      username: creds.username,
      password: creds.password,
      grant_type: creds.method || "password",
      client_id: creds.clientId,
      client_secret: creds.clientSecret
    }).toString()
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=>"");
    throw new Error(`Autenticação em ${base} falhou (HTTP ${resp.status}): ${t.slice(0, 180)}`);
  }
  const j = await resp.json();
  if (!j?.access_token) throw new Error(`Resposta de token sem access_token em ${base}.`);
  return j.access_token;
}
// A leitura e a escrita não usam o mesmo nome para o mesmo campo, e nem sempre
// a mesma caixa. Em vez de adivinhar, procura por todos os apelidos plausíveis
// — e quem decide se achou é o guarda lá embaixo, não esta função.
/**
 * A licença está desativada? `true` / `false` / `undefined` (não deu para saber).
 *
 * ⚠️ ESTE HOST NÃO TEM `desativarLicenca` NA LEITURA. Medido em 01/09/2026 na
 * filial 4517/5089: o `GET /v1/licenciamento/{e}/{f}` devolve, dentro de
 * `filial`, exatamente
 *   codigo, nome, cnpj, numeroSerie, status, bloqueado, codTipoNegocio,
 *   tipoNegocio, codDetalhesTipoNegocio, detalhesTipoNegocio, codOrigemVenda,
 *   origemVenda, usuarios, pdvComandas, valorTotal
 * Nem `desativarLicenca`, nem `desativado`, nem `ativo`. Quem carrega o estado
 * é **`status`**: `"AT"` ativa, `"IN"` inativa (a `oem-espelho-sync` já
 * anotava isso: "o detalhe do pdvlegal só `status: \"AT\"`").
 *
 * É a mesma assimetria que já existe nesta rota entre ler e gravar: o GET
 * responde `cnpj`, o POST recebe `cpfCnpj`. Aqui o GET responde `status` e o
 * POST recebe `desativarLicenca`.
 *
 * POR QUE ISSO ERA UM BUG VIVO, E NÃO SÓ UMA FALTA: o payload calculava o flag
 * com `=== true`, então campo ausente virava `false`, e a rota salva a filial
 * INTEIRA. Gravar qualquer módulo numa licença desativada mandava
 * `desativarLicenca: false` e a reativaria. Nunca apareceu porque as 12
 * gravações feitas até 01/09/2026 foram todas em licença ativa, onde `false`
 * acerta por acidente. Eram 943 licenças desativadas na base naquela data.
 *
 * Devolve `undefined` para qualquer outro valor de propósito: um terceiro
 * código de status é coisa nova, e chutar entre ligada e desligada é
 * exatamente o que causou o problema.
 */
function desativadoLido(f) {
  const explicito = pega(f, "desativarLicenca", "desativado");
  if (typeof explicito === "boolean") return explicito;
  const ativo = pega(f, "ativo");
  if (typeof ativo === "boolean") return !ativo;
  const st = pega(f, "status");
  if (st === undefined) return undefined;
  const s = String(st).trim().toUpperCase();
  if (s === "AT" || s === "ATIVO") return false;
  if (s === "IN" || s === "INATIVO" || s === "DESATIVADO") return true;
  return undefined;
}
/**
 * A data em que a licença INTEIRA cai, ou `null` se não há baixa marcada.
 *
 * ⚠️ DESATIVAR NÃO DESLIGA NA HORA. Medido em 01/09/2026 na filial 39735
 * (Pizzaria Beda): `desativarLicenca: true` voltou HTTP 200, o portal do
 * parceiro passou a mostrar "Desativa em: 30/09/2026" e o `status` da licença
 * continuou `"AT"`. O OEM agenda a baixa para o fim do mês de cobrança, como já
 * faz com cancelamento de módulo. Conferir a desativação pelo `status` nunca
 * confirmaria: ele só muda no dia 30.
 *
 * Onde a data está: na `datavalidade` de cada módulo, e ela só existe na
 * leitura DOCUMENTADA. A do pdvlegal não traz esse campo.
 *
 * Mesma regra da `desativacaoProgramada` no DoctorSaaS, e ela não é "tem data /
 * não tem": TODOS os módulos ativos precisam ter data. Enquanto um módulo ativo
 * estiver sem prazo, quem vence é aquele módulo, não a licença. 2099 é
 * sentinela de "sem prazo".
 */
function baixaProgramada(modulos) {
  if (!Array.isArray(modulos)) return null;
  const ativos = modulos.filter((m)=>m && pega(m, "ativo") !== false);
  if (!ativos.length) return null;
  let maior = null;
  for (const m of ativos){
    const bruto = pega(m, "datavalidade", "dataValidade", "data_validade");
    const d = typeof bruto === "string" ? bruto.slice(0, 10) : null;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (d >= "2099-01-01") return null;
    if (!maior || d > maior) maior = d;
  }
  return maior;
}
function pega(obj, ...nomes) {
  for (const n of nomes){
    for (const k of Object.keys(obj)){
      if (k.toLowerCase() === n.toLowerCase() && obj[k] !== null && obj[k] !== undefined) {
        return obj[k];
      }
    }
  }
  return undefined;
}
/**
 * Nesta rota, 9 e 10 SÃO módulos da lista, com a quantidade certa — ao
 * contrário da rota antiga, onde eles só existem como campo próprio. Mexer
 * neles é mexer na lista; o campo de topo acompanha, para as duas
 * representações não divergirem dentro do mesmo corpo.
 *
 * Fica no escopo do ARQUIVO porque a conferência também precisa dele. Ela lia
 * um `CAMPO_DOC` que nunca existiu e, como nome só se resolve na execução,
 * toda gravação pelo caminho documentado caía no catch com "CAMPO_DOC is not
 * defined" desde 28/08/2026: a rede de segurança da gravação nunca rodou.
 */
const CAMPO_ESPELHO = { 9: "usuariosAdicionais", 10: "pdvComandas" };

/**
 * AFIRMA no corpo os módulos que o DoctorSaaS considera cancelados, em vez de
 * ecoar o que a leitura devolveu.
 *
 * ⚠️ É ISTO QUE IMPEDE UM CANCELAMENTO DE SER APAGADO POR UMA GRAVAÇÃO FUTURA.
 * O OEM registra cancelamento como `datavalidade` e continua devolvendo o
 * módulo como `ativo: true`, com a quantidade de antes — só a data diz que ele
 * está cancelado. Como o corpo nasce da leitura, qualquer gravação posterior
 * nesta filial (outro módulo, o estado da licença) reenviava o módulo
 * cancelado como ATIVO, e o OEM apagava a data: o módulo voltava a valer, sem
 * erro e sem aviso.
 *
 * Medido em 03/09/2026 na filial 28533: reenviar a `datavalidade` junto NÃO
 * preserva. A gravação mandou o PDV com a data 30/09 e a leitura seguinte
 * voltou sem data nenhuma. O que o OEM lê é o par ativo/quantidade; a data ele
 * decide. Então a única forma de manter um módulo desligado é continuar
 * pedindo que ele fique desligado, em toda gravação.
 *
 * Efeito colateral bom, e é de propósito: uma filial que já divergiu volta ao
 * lugar sozinha na próxima escrita, sem ninguém ir atrás dela.
 *
 * `jaTratados` são os códigos que a alteração pedida já resolveu — quem pediu
 * agora manda mais do que a ficha lembra, senão reativar um módulo cancelado
 * seria desfeito na linha seguinte.
 *
 * Devolve só o que MUDOU, para a lista servir de auditoria em vez de repetir a
 * licença inteira.
 */
function reafirmarCancelados(novo, cancelados, jaTratados) {
  const reafirmados = [];
  if (!Array.isArray(cancelados) || cancelados.length === 0) return reafirmados;
  for (const bruto of cancelados) {
    const codigo = num(bruto);
    // O 8 é o produto da licença, não um módulo: desligá-lo seria desligar a
    // licença inteira por um caminho que ninguém pediu.
    if (codigo === undefined || codigo === 8 || jaTratados.has(codigo)) continue;
    const idx = novo.modulos.findIndex((m)=>num(pega(m, "codigo", "codModulo", "cod")) === codigo);
    // Módulo que não está na licença não se afirma: não há o que desligar, e
    // inventar uma linha aqui criaria módulo do nada numa rota que grava tudo.
    if (idx < 0) continue;
    const m = novo.modulos[idx];
    // Já desligado no parceiro: não há o que afirmar. E não force a quantidade
    // para 0 aqui — a licença guarda `quantidade: 1` em TODO módulo inativo (é
    // o valor de prateleira dele), então zerar seria mexer em dado do parceiro
    // à toa e encher a lista de auditoria com linha que não mudou nada.
    if (pega(m, "ativo") === false) continue;
    reafirmados.push({
      codigo,
      de: { ativo: m.ativo, quantidade: m.quantidade, datavalidade: pega(m, "datavalidade") ?? null },
    });
    m.ativo = false;
    m.quantidade = 0;
    m.valorTotal = 0;
    if (CAMPO_ESPELHO[codigo]) novo[CAMPO_ESPELHO[codigo]] = 0;
  }
  return reafirmados;
}

/**
 * Confere UM módulo na releitura documentada, depois de gravar.
 *
 * ⚠️ DUAS COISAS QUE O CRITÉRIO ANTIGO ERRAVA, E AS DUAS DAVAM FALSO ALARME.
 *
 * 1. Ele julgava por QUANTIDADE. No OEM, cancelar não zera nada: registra
 *    `datavalidade` e devolve o módulo `ativo: true` com a quantidade de
 *    antes. Todo cancelamento CERTO aparecia como `confirmado: false` — foi o
 *    que aconteceu com os três da DEGUST em 05/09/2026, que estavam corretos
 *    no portal. Alarme que dispara com tudo certo ensina a ignorar alarme.
 * 2. Para os códigos 9 e 10 ele lia `usuariosAdicionais`/`pdvComandas` do
 *    TOPO da leitura documentada — e ela devolve esses cinco campos SEMPRE
 *    ZERADOS (é justamente por isso que existe a leitura complementar).
 *    Falso negativo garantido. Nesta rota 9 e 10 são módulos da lista, então
 *    é de `modulos[]` que se lê, como todos os outros.
 *
 * Continua NÃO BARRANDO NADA, e isso é decisão do Alexandre de 28/08/2026: a
 * leitura do parceiro atrasa, então ela serve para confirmar, nunca para
 * condenar. Ler o valor antigo não distingue "não aplicou" de "ainda não
 * alcançou".
 */
function conferirModulo(depois, codigo, quantidadePedida) {
  const mod = (pega(depois, "modulos") ?? []).find((m)=>num(pega(m, "codigo")) === codigo);
  const ativo = mod === undefined ? false : pega(mod, "ativo") !== false;
  const quantidade = mod === undefined ? 0 : num(pega(mod, "quantidade")) ?? 0;
  const bruto = mod ? pega(mod, "datavalidade", "dataValidade", "data_validade") : null;
  const datavalidade = typeof bruto === "string" ? bruto : null;
  const ate = datavalidade ? String(datavalidade).slice(0, 10) : null;
  // Desligado para o cliente é: sumiu da licença, veio inativo, OU tem data de
  // baixa. A terceira é a que o OEM usa de verdade e a que faltava aqui.
  const desligado = mod === undefined || !ativo || datavalidade !== null;

  const base = { codigo, campo: `modulos[${codigo}]`, esperado: quantidadePedida, encontrado: quantidade, ativo, datavalidade };

  if (quantidadePedida === 0) {
    return { ...base, desligado, confirmado: desligado, mensagem: desligado
      ? (ate ? `Baixa registrada no OEM para ${ate}. O módulo fica de pé e continua sendo cobrado até lá.`
             : "Módulo desligado no OEM: confere.")
      : "Gravado, mas o módulo continua ativo e sem data de baixa no OEM." };
  }

  // Pediu quantidade e o módulo voltou com data futura: é a REDUÇÃO AGENDADA
  // para o fim do mês de cobrança, que é como o OEM aplica tudo. A quantidade
  // antiga continua até lá porque o cliente pagou o mês.
  //
  // ⚠️ NÃO É FALHA, E CHAMAR DE FALHA JÁ CUSTOU CARO AQUI. Duas vezes se
  // concluiu, de amostra pequena, que o parceiro estaria transformando redução
  // em baixa do módulo inteiro — em 28/08/2026 e de novo em 05/09/2026. As
  // duas vezes o dado derrubou: a redução vale, ela só vale a partir da data.
  // Reprovar isto encheria a tela de vermelho em cima de gravação certa.
  if (ate && quantidade > quantidadePedida) {
    return { ...base, desligado, confirmado: true,
      mensagem: `Redução aceita e agendada para ${ate}. Até lá a licença segue com ${quantidade}, que é o mês já pago.` };
  }

  if (desligado) {
    // Aqui sim: pediu quantidade e o módulo está inativo, sem ser redução
    // agendada. Não é o mesmo que "não aplicou" — pode ser desativação da
    // licença inteira —, mas é caso para gente olhar.
    return { ...base, desligado, confirmado: false, mensagem: ate
      ? `Pedi quantidade ${quantidadePedida} e o módulo está marcado para ${ate}. Confira se a licença não foi desativada inteira.`
      : "Pedi quantidade e o módulo veio desligado no OEM." };
  }

  if (quantidade !== quantidadePedida) {
    return { ...base, desligado, confirmado: false,
      mensagem: `Gravado, mas a licença mostra ${quantidade} e não ${quantidadePedida}. A releitura do parceiro atrasa, então isto não afirma que não aplicou.` };
  }

  return { ...base, desligado, confirmado: true, mensagem: "Relido no OEM pelo caminho documentado: confere." };
}

/**
 * Monta o corpo do `saveFilial` a partir do que a leitura documentada devolveu,
 * aplicando TODAS as alterações pedidas para esta filial de uma vez.
 *
 * O payload NASCE do que foi lido — inclusive `datavalidade` e `datacadastro` de
 * cada módulo. Só os alvos mudam. É exatamente isso que o caminho antigo não
 * fazia: ele remontava cada módulo com 5 campos, e tudo o que a leitura não
 * trouxe sumia. Como a rota salva a filial INTEIRA, o que some da requisição
 * some da licença.
 *
 * ⚠️ POR QUE É UMA LISTA, E NÃO UMA ALTERAÇÃO POR CHAMADA
 * O OEM registra cancelamento como `datavalidade`: o módulo continua
 * `ativo: true`, com uma data futura, e é ela que o desliga. A gravação
 * SEGUINTE reenvia esse módulo como ativo e o OEM APAGA a data.
 *
 * Medido em 04/09/2026 na filial 28533 (DEGUST CONCEITO): quatro gravações em
 * 12 segundos — reduzir PDV, cancelar IFood, cancelar 99 Food, ativar Servidor
 * Legal. A leitura de cada uma mostrava a data posta pela anterior, e a
 * gravação a apagava. Resultado: nenhum dos três cancelamentos ficou de pé, e
 * os três voltaram `ok` com HTTP 200. No MESMO lote, as filiais 20314 e 19744
 * receberam um cancelamento e nenhuma gravação depois: as duas estão com a
 * baixa marcada para 30/09 até hoje.
 *
 * Ou seja: o que decidia se um cancelamento valia não era o cancelamento, era
 * o azar de ter outra gravação atrás dele. Uma gravação por filial fecha isso.
 *
 * Função separada de propósito: é o miolo da mudança, e é ela que o teste
 * exercita. Deixá-la embutida no handler significaria testar uma cópia.
 *
 * `alteracoes`: `[{ codigo, quantidade }]`, aplicadas na ordem recebida.
 * Devolve `{novo, alvos, diferencas, completados}` ou `{erro}`.
 */
function montarPayloadDocumentado(lido, escalares, alteracoes, cancelados) {
  if (!Array.isArray(alteracoes) || alteracoes.length === 0) {
    return { erro: { status: 400, mensagem: "Nenhuma alteração de módulo foi pedida. Nada foi enviado." } };
  }
  if (alteracoes.some((a)=>a.codigo === 8)) {
    return { erro: { status: 400, mensagem: "O código 8 é o produto da licença, não um módulo. Nada foi enviado." } };
  }
  if (alteracoes.some((a)=>a.codigo === undefined || a.codigo === null)) {
    return { erro: { status: 400, mensagem: "Alteração sem código de módulo. Nada foi enviado." } };
  }
  // Duas ordens para o MESMO módulo no mesmo corpo: a segunda apagaria a
  // primeira sem deixar rastro, que é a forma do defeito que esta função
  // existe para evitar. Quem chama tem que separar em gravações distintas —
  // e, sabendo o que se sabe hoje, decidir qual das duas ainda vale.
  const vistos = new Set();
  for (const a of alteracoes) {
    if (vistos.has(a.codigo)) {
      return { erro: {
        status: 409,
        mensagem: `O módulo ${a.codigo} aparece duas vezes no mesmo pedido. Nada foi enviado.`
      } };
    }
    vistos.add(a.codigo);
  }

  // ⚠️ A LEITURA DOCUMENTADA VEM INCOMPLETA, e isso foi medido em 28/08/2026 na
  // simulação da filial 4517/5089: ela devolve `codigoTipoNegocio`,
  // `codigoDetalhesTipoNegocio`, `codigoOrigemVenda`, `usuariosAdicionais` e
  // `pdvComandas` como ZERO, enquanto o portal mostra Varejo, Outros, Migração,
  // 4 e 1. Como a rota grava a filial inteira, mandar de volta o que ela leu
  // teria zerado os cinco numa licença de cliente real.
  //
  // Os cinco vêm da OUTRA leitura (a do host de escrita), que os traz. As duas
  // leituras são complementares: uma tem `datavalidade`, a outra tem estes.
  //
  // A guarda é sobre AUSENTE, não sobre zero. `usuariosAdicionais: 0` é legítimo
  // (cliente sem usuário extra); `codigoTipoNegocio` ausente é sintoma de nome
  // de campo divergente, e gravar levaria zero para uma licença que tem tipo.
  const OBRIGATORIOS = ["codigoTipoNegocio", "codigoDetalhesTipoNegocio", "codigoOrigemVenda"];
  const faltando = OBRIGATORIOS.filter((k)=>escalares?.[k] === undefined || escalares?.[k] === null);
  if (faltando.length) {
    return { erro: {
      status: 409,
      mensagem: `A leitura complementar não trouxe ${faltando.join(", ")}. Gravar levaria zero para a licença. Nada foi enviado.`,
      escalares
    } };
  }

  const novo = JSON.parse(JSON.stringify(lido));
  if (!Array.isArray(novo.modulos)) novo.modulos = [];

  // Completa o que a leitura documentada não traz. Fica registrado à parte da
  // alteração pedida: são coisas diferentes e misturá-las esconderia a única
  // que alguém aprovou.
  const completados = [];
  for (const k of Object.keys(escalares)) {
    if (escalares[k] === undefined) continue;
    if (JSON.stringify(novo[k]) !== JSON.stringify(escalares[k])) {
      completados.push({ campo: k, de: novo[k], para: escalares[k] });
    }
    novo[k] = escalares[k];
  }

  // Uma passada por alteração, todas no MESMO objeto. A licença que sai daqui
  // é a filial com tudo o que foi pedido já aplicado — não a filial com uma
  // mudança, gravada N vezes.
  const alvos = [];
  for (const { codigo: moduloCodigo, quantidade: novaQtd } of alteracoes) {
    const idx = novo.modulos.findIndex((m)=>num(pega(m, "codigo", "codModulo", "cod")) === moduloCodigo);
    if (idx < 0) {
      // Falta UM módulo, não grava NENHUM. Gravar o resto deixaria o pedido
      // metade feito com resposta de sucesso, que é pior do que não gravar.
      return { erro: {
        status: 404,
        mensagem: `A licença não tem o módulo ${moduloCodigo}. Nada foi enviado.`,
        modulos_na_licenca: novo.modulos.map((m)=>pega(m, "codigo"))
      } };
    }
    const antesMod = JSON.parse(JSON.stringify(novo.modulos[idx]));
    const unit = num(pega(novo.modulos[idx], "valorUnitario")) ?? 0;
    if (novaQtd > 0) {
      novo.modulos[idx].ativo = true;
      novo.modulos[idx].quantidade = novaQtd;
      novo.modulos[idx].valorTotal = Math.round(unit * novaQtd * 100) / 100;
      // O CONSERTO. Módulo cancelado carrega uma data futura, e é ela que o
      // mantém desligado para o cliente — não o `ativo`. Reativar sem limpá-la
      // foi o que falhou em 28/08 no CAMPINA VERDE. Limpar sem ligar seria pior,
      // então as duas coisas andam juntas.
      novo.modulos[idx].datavalidade = null;
    } else {
      novo.modulos[idx].ativo = false;
      novo.modulos[idx].quantidade = 0;
      novo.modulos[idx].valorTotal = 0;
      // A data da baixa quem põe é o parceiro. Inventar uma aqui seria decidir
      // por ele quando o cliente deixa de ter o módulo.
    }
    if (CAMPO_ESPELHO[moduloCodigo]) novo[CAMPO_ESPELHO[moduloCodigo]] = novaQtd;
    alvos.push({ tipo: "modulo", codigo: moduloCodigo, de: antesMod, para: novo.modulos[idx] });
  }

  // Depois das alterações, e sem tocar no que elas resolveram.
  const reafirmados = reafirmarCancelados(novo, cancelados, new Set(alteracoes.map((a)=>a.codigo)));

  // O que muda ALÉM do que foi pedido e do que foi completado. Esta lista tem
  // que ficar com a alteração pedida e nada mais: qualquer outra entrada é
  // campo se perdendo, e é para isso que ela existe — a rota grava a filial
  // inteira, e o que não vai, some.
  const completadosSet = new Set(completados.map((c)=>c.campo));
  const diferencas = [];
  for (const k of new Set([...Object.keys(lido), ...Object.keys(novo)])) {
    if (k === "modulos" || completadosSet.has(k)) continue;
    if (JSON.stringify(lido[k]) !== JSON.stringify(novo[k])) {
      diferencas.push({ campo: k, de: lido[k], para: novo[k] });
    }
  }
  // Módulo reafirmado sai de `diferencas` e vai para a lista própria. As duas
  // coisas são diferentes: `diferencas` existe para denunciar campo se
  // perdendo, e afogar isso em reafirmações rotineiras é perder o sinal que
  // custou caro para existir.
  const reafirmadosSet = new Set(reafirmados.map((r)=>r.codigo));
  const antes = Array.isArray(lido.modulos) ? lido.modulos : [];
  for (let i = 0; i < Math.max(antes.length, novo.modulos.length); i++) {
    if (JSON.stringify(antes[i]) !== JSON.stringify(novo.modulos[i])) {
      const cod = num(pega(antes[i] ?? novo.modulos[i] ?? {}, "codigo"));
      if (reafirmadosSet.has(cod)) continue;
      diferencas.push({
        campo: `modulos[${i}] (codigo ${cod})`,
        de: antes[i], para: novo.modulos[i]
      });
    }
  }

  return { novo, alvos, diferencas, completados, reafirmados };
}

const num = (v)=>{
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};
// ============================================================================
// Nenhuma resposta sai com segredo da licença (26/09/2026).
//
// O parceiro devolve, na gravação e na leitura, a SENHA do usuário master e o
// TokenWS da licença do cliente. Esta função repassava a resposta crua
// (`resposta`, `leitura_crua`), e o DoctorSaaS guardava isso em
// oem_sync_fila, oem_baixa_modulo_log e oem_estado_licenca_log: medido em
// 26/09, 241 registros com a senha de licenças de clientes reais.
//
// A limpeza é no ÚNICO ponto de saída: toda resposta passa por `responder`.
// Chave com senha/password/token, em qualquer profundidade, vira [removido].
// ============================================================================
const semSegredos = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(semSegredos);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /senha|password|token/i.test(k) ? "[removido]" : semSegredos(x);
    }
    return out;
  }
  return v;
};
const responder = (corpo: unknown, init?: ResponseInit) => Response.json(semSegredos(corpo), init);
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    headers: cors
  });
  try {
    const chave = req.headers.get("x-api-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!chave) {
      return responder({
        ok: false,
        mensagem: "Informe a chave em x-api-key."
      }, {
        status: 401,
        headers: cors
      });
    }
    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        persistSession: false
      }
    });
    const { data: registro } = await db.from("oem_api_chaves").select("id, tenant_id, ativa, revogada_em").eq("token_hash", await sha256Hex(chave)).maybeSingle();
    if (!registro || !registro.ativa || registro.revogada_em) {
      return responder({
        ok: false,
        mensagem: "Chave inválida."
      }, {
        status: 401,
        headers: cors
      });
    }
    const corpo = await req.json().catch(()=>({}));
    const empresa = String(corpo.empresa ?? "").replace(/\D/g, "");
    const filial = String(corpo.filial ?? "").replace(/\D/g, "");
    // Duas formas de pedir a mesma coisa, e a antiga continua valendo:
    //   {modulo_codigo, nova_quantidade}                    -> uma alteração
    //   {alteracoes: [{modulo_codigo, nova_quantidade}, …]}  -> várias, UMA gravação
    //
    // A forma em lista é a que fecha o buraco do `datavalidade` (ver
    // `montarPayloadDocumentado`). A forma antiga fica porque a ficha do
    // cliente e a simulação chamam com um módulo só, e trocar as duas coisas
    // no mesmo passo é como se perde a chance de saber qual delas quebrou.
    const alteracoes = Array.isArray(corpo.alteracoes) && corpo.alteracoes.length
      ? corpo.alteracoes.map((a)=>({
          codigo: num(pega(a ?? {}, "modulo_codigo", "codigo")),
          // null/0 = desliga o módulo. Número > 0 = fica ligado com essa quantidade.
          quantidade: num(pega(a ?? {}, "nova_quantidade", "quantidade")) ?? 0
        }))
      : (num(corpo.modulo_codigo) === undefined
          ? []
          : [{ codigo: num(corpo.modulo_codigo), quantidade: num(corpo.nova_quantidade) ?? 0 }]);
    // O resto do arquivo (o caminho antigo do pdvlegal, cadastro e estado)
    // continua raciocinando sobre UM módulo. Ele recebe o primeiro; o lote em
    // si é recusado mais abaixo, porque aquele caminho não sabe gravar dois.
    const moduloCodigo = alteracoes[0]?.codigo;
    const novaQtd = alteracoes[0]?.quantidade ?? 0;
    const simular = corpo.simular === true;
    // Os módulos que o DoctorSaaS dá como cancelados nesta filial. Toda
    // gravação pelo caminho documentado os reafirma desligados, porque a
    // leitura do parceiro os devolve como ativos e ecoá-la apaga a baixa.
    // Quem sabe disso é a ficha, não esta função — por isso vem no corpo.
    const cancelados = Array.isArray(corpo.cancelados)
      ? corpo.cancelados.map((v)=>num(v)).filter((v)=>v !== undefined)
      : [];
    // Modo cadastro: sem modulo_codigo e com pelo menos um campo de cadastro.
    const novoNome = corpo.novo_nome === undefined || corpo.novo_nome === null ? undefined : String(corpo.novo_nome).trim();
    const novoCnpj = corpo.novo_cnpj === undefined || corpo.novo_cnpj === null ? undefined : String(corpo.novo_cnpj).replace(/\D/g, "");
    const modoCadastro = moduloCodigo === undefined && (novoNome !== undefined || novoCnpj !== undefined);
    // Modo estado: liga/desliga a licença inteira. Só aceita booleano — mandar
    // "true" em texto e ver o campo virar false é o tipo de erro que só
    // aparece na licença do cliente.
    const boolPedido = (v)=>v === undefined || v === null ? undefined : v === true ? true : v === false ? false : "invalido";
    const novoBloqueado = boolPedido(corpo.novo_bloqueado);
    const novoDesativado = boolPedido(corpo.novo_desativado);
    const modoEstado = moduloCodigo === undefined && !modoCadastro && (novoBloqueado !== undefined || novoDesativado !== undefined);
    if (novoBloqueado === "invalido" || novoDesativado === "invalido") {
      return responder({
        ok: false,
        etapa: "entrada",
        mensagem: "novo_bloqueado e novo_desativado precisam ser true ou false. Nada foi enviado."
      }, {
        status: 400,
        headers: cors
      });
    }
    if (!empresa || !filial || (moduloCodigo === undefined && !modoCadastro && !modoEstado)) {
      return responder({
        ok: false,
        mensagem: 'Informe empresa e filial, mais modulo_codigo (módulo), novo_nome/novo_cnpj (cadastro) ou novo_bloqueado/novo_desativado (estado). Ex.: {"empresa":"32801","filial":"39751","modulo_codigo":10,"nova_quantidade":1}'
      }, {
        status: 400,
        headers: cors
      });
    }
    // Documento inválido não vai para o parceiro: é ele que fatura por este
    // número, e a rota salva a filial inteira sem validar nada.
    if (novoCnpj !== undefined && novoCnpj.length !== 11 && novoCnpj.length !== 14) {
      return responder({
        ok: false,
        etapa: "entrada",
        mensagem: `novo_cnpj precisa ter 11 (CPF) ou 14 (CNPJ) dígitos. Recebi ${novoCnpj.length}. Nada foi enviado.`
      }, {
        status: 400,
        headers: cors
      });
    }
    if (novoNome !== undefined && novoNome === "") {
      return responder({
        ok: false,
        etapa: "entrada",
        mensagem: "novo_nome vazio apagaria o nome da loja no OEM. Nada foi enviado."
      }, {
        status: 400,
        headers: cors
      });
    }
    // O lote só existe no caminho documentado. O do pdvlegal grava um módulo
    // por vez, e gravar o primeiro devolvendo sucesso deixaria o resto por
    // fazer sem ninguém saber — exatamente o que se está consertando.
    if (alteracoes.length > 1 && !(corpo.par_documentado === true)) {
      return responder({
        ok: false,
        etapa: "entrada",
        mensagem: "Lote de módulos só pelo caminho documentado. Envie par_documentado: true. Nada foi enviado."
      }, {
        status: 400,
        headers: cors
      });
    }
    const creds = await carregarCreds(db, String(registro.tenant_id));

    // ========================================================================
    // CAMINHO DOCUMENTADO (opt-in por `par_documentado: true`)
    //
    // POR QUE ELE EXISTE
    // O par que esta função usa desde sempre — GET /v1/licenciamento/{e}/{f} e
    // POST /v1/licenciamento/filial, no host pdvlegal — NÃO é documentado
    // (`/Help` responde 404) e a leitura dele NÃO devolve `datavalidade` por
    // módulo. Medido em 28/08/2026: é `datavalidade` que define se o módulo está
    // ligado para o cliente, não `ativo`. O portal mostra "desmarcado · Válido
    // até 31/08" para um módulo que a API devolve como `ativo: true`.
    //
    // Consequência: ao reativar um módulo cancelado, mandamos `ativo: true`, a
    // data continua lá porque não temos como enviá-la, e o módulo segue
    // cancelado. Foi o que aconteceu no CAMPINA VERDE.
    //
    // A API TEM um par que fecha, e é documentado:
    //   ler   GET  /licenciamento/minhaslicencas/modulos/{produto}/{grupo}/{loja}
    //   gravar POST /licenciamento/minhaslicencas/saveFilial
    // Os dois usam o MESMO objeto, com `datavalidade` e `datacadastro` por
    // módulo. Ler e devolver o mesmo modelo é o que impede campo de sumir — a
    // rota salva a filial inteira, e o que não vai, some.
    //
    // ⚠️ ENTRA DESLIGADO. Sem `par_documentado: true` no corpo, nada muda para
    // quem já chama. Isso é de propósito: a troca do caminho de gravação de
    // licença de cliente real se prova em etapas, e a primeira é simular.
    // ========================================================================
    // O MODO ESTADO ENTRA AQUI SEMPRE, SEM OPT-IN, E ISSO FOI MEDIDO.
    //
    // A primeira tentativa gravava pelo pdvlegal, como o resto do arquivo. Em
    // 01/09/2026, duas vezes, com o payload conferido campo a campo contra uma
    // gravação que aquela mesma rota aceitou em 28/08 (mesmas 12 chaves, mesma
    // forma de `modulos[]`), a única diferença sendo `bloquearLicenca: true`,
    // ela respondeu **HTTP 500 "Ocorreu um erro interno no servidor"** depois de
    // ~20 segundos. Foi o primeiro `bloquearLicenca: true` já enviado por ali.
    //
    // A rota documentada aceita os dois flags: as gravações de 29/08 e 01/09
    // foram por ela e levaram `bloquearLicenca` e `desativarLicenca` no corpo,
    // com HTTP 200. Ela também é a única que preserva `datavalidade` dos
    // módulos, então gravar o estado por ela é melhor por dois motivos, não um.
    if (corpo.par_documentado === true || modoEstado) {
      const LEITURA = (Deno.env.get("OEM_API_LEITURA_URL") ?? "https://api.tabletcloud.com.br").replace(/\/+$/, "");

      // -------------------------------------------------- de qual produto é
      // O GET documentado exige o produto no caminho. O código já está no banco
      // daqui: a carga (`oem-sync-passo`) grava o módulo CRU em
      // `clientes_oem.modulos_ativos` (ela faz `...m` antes de normalizar), e
      // cada módulo carrega `codproduto`. Nenhuma chamada extra à API, e nada a
      // mudar no DoctorSaaS.
      let codProdutoDoc = num(corpo.codproduto);
      if (codProdutoDoc === undefined) {
        const { data: linhaOem } = await db.from("clientes_oem")
          .select("modulos_ativos, produto_principal")
          .eq("tenant_id", String(registro.tenant_id))
          .eq("filial_codigo", String(filial))
          .maybeSingle();
        const mods = Array.isArray(linhaOem?.modulos_ativos) ? linhaOem.modulos_ativos : [];
        for (const m of mods) {
          const c = num(pega(m, "codproduto", "codProduto"));
          if (c !== undefined) { codProdutoDoc = c; break; }
        }
        // Reserva: o nome do produto contra o catálogo, que é o que a própria
        // carga faz quando monta a linha.
        if (codProdutoDoc === undefined && linhaOem?.produto_principal) {
          const tkCat = await obterToken(LEITURA, creds);
          const rCat = await fetch(`${LEITURA}/licenciamento/minhaslicencas/produtos`, {
            headers: { Authorization: `Bearer ${tkCat}`, Accept: "application/json" }
          });
          const cat = await rCat.json().catch(()=>null);
          const alvo = (Array.isArray(cat) ? cat : []).find((p)=>
            String(pega(p, "nome") ?? "").trim().toUpperCase() ===
            String(linhaOem.produto_principal).trim().toUpperCase());
          codProdutoDoc = num(pega(alvo ?? {}, "codigo"));
        }
      }
      if (codProdutoDoc === undefined) {
        return responder({
          ok: false, etapa: "produto",
          mensagem: `Não deu para descobrir o código do produto da filial ${empresa}/${filial}. Informe "codproduto" no corpo, ou rode a carga do OEM para esta filial.`
        }, { status: 409, headers: cors });
      }

      // ------------------------------------------------------------- ler
      const tk = await obterToken(LEITURA, creds);
      const urlLer = `${LEITURA}/licenciamento/minhaslicencas/modulos/${encodeURIComponent(String(codProdutoDoc))}/${empresa}/${filial}`;
      const rDoc = await fetch(urlLer, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
      const lido = await rDoc.json().catch(()=>null);
      if (!rDoc.ok || !lido) {
        return responder({
          ok: false, etapa: "leitura", http: rDoc.status, url: urlLer,
          mensagem: "A leitura documentada da filial não respondeu."
        }, { status: 502, headers: cors });
      }
      const modsLidos = Array.isArray(pega(lido, "modulos")) ? pega(lido, "modulos") : null;
      if (!modsLidos || modsLidos.length === 0) {
        return responder({
          ok: false, etapa: "leitura",
          mensagem: "A leitura documentada não trouxe módulos. Nada foi enviado ao OEM.",
          leitura: lido
        }, { status: 409, headers: cors });
      }

      // ------------------------------------------- a segunda leitura, e por quê
      // A documentada devolve `codigoTipoNegocio`, `codigoDetalhesTipoNegocio`,
      // `codigoOrigemVenda`, `usuariosAdicionais` e `pdvComandas` como ZERO
      // (medido em 28/08/2026 na 4517/5089, com o portal mostrando Varejo,
      // Outros, Migração, 4 e 1). A leitura do host de escrita traz esses cinco.
      // Nenhuma das duas basta sozinha: uma tem a data, a outra tem o cadastro.
      const tkPl = await obterToken(creds.baseUrl, creds);
      const rPl = await fetch(`${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`, {
        headers: { Authorization: `Bearer ${tkPl}`, Accept: "application/json" }
      });
      const cruPl = await rPl.json().catch(()=>null);
      if (!rPl.ok || !cruPl) {
        return responder({
          ok: false, etapa: "leitura_complementar", http: rPl.status,
          mensagem: "A leitura complementar da filial não respondeu. Sem ela, gravar zeraria tipo de negócio, origem da venda e os contadores. Nada foi enviado."
        }, { status: 502, headers: cors });
      }
      const fPl = cruPl.filial ?? cruPl;
      const escalares = {
        codigoTipoNegocio: num(pega(fPl, "codTipoNegocio", "codigoTipoNegocio", "codtiponegocio")),
        codigoDetalhesTipoNegocio: num(pega(fPl, "codDetalhesTipoNegocio", "codigoDetalhesTipoNegocio", "coddetalhestiponegocio")),
        codigoOrigemVenda: num(pega(fPl, "codOrigemVenda", "codigoOrigemVenda", "codorigemvenda")),
        usuariosAdicionais: num(pega(fPl, "usuarios", "usuariosAdicionais", "usuariosadicionais")),
        pdvComandas: num(pega(fPl, "pdvComandas", "pdvcomandas")),
        bloquearLicenca: pega(fPl, "bloquearLicenca", "bloqueado", "bloquear") === true,
        // `?? false` mantém o comportamento de antes quando nem o `status`
        // veio. O que mudou é que licença desativada agora é reconhecida em
        // vez de virar `false` por omissão — ver `desativadoLido`.
        desativarLicenca: desativadoLido(fPl) ?? false
      };

      // ----------------------------------------------------- modo estado
      //
      // Liga e desliga a LICENÇA INTEIRA. Duas dimensões independentes:
      // desativada não cobra, bloqueada cobra.
      //
      // O ESTADO É LIDO DO PDVLEGAL, MESMO GRAVANDO PELA DOCUMENTADA. É lá que
      // ele existe: a leitura documentada não traz esses campos, e a do
      // pdvlegal traz `bloqueado` e `status` ("AT"/"IN"). Ler de um host e
      // gravar em outro parece estranho, mas é o mesmo desenho que já sustenta
      // a gravação de módulo aqui: as duas leituras são complementares.
      //
      // A GUARDA É SEM VALOR DE RESERVA, ao contrário do `escalares` acima.
      // Num modo cujo assunto É o flag, "não sei" virando `false` desligaria ou
      // religaria a licença de um cliente sem ninguém pedir.
      if (modoEstado) {
        const boolEstrito = (v)=>typeof v === "boolean" ? v : undefined;
        const bloqLido = boolEstrito(pega(fPl, "bloquearLicenca", "bloqueado", "bloquear"));
        const desatLido = desativadoLido(fPl);
        const faltaEstado = [];
        if (bloqLido === undefined) faltaEstado.push("o bloqueio (bloqueado)");
        if (desatLido === undefined) {
          const st = pega(fPl, "status");
          faltaEstado.push(st === undefined
            ? "o estado da licença (status)"
            : `um status que dê para interpretar (veio "${String(st)}", e só AT e IN são conhecidos)`);
        }
        const podeGravar = faltaEstado.length === 0;
        // A baixa já marcada. Ela é a TERCEIRA informação do estado, e sem ela
        // "Desativada: Não" mente para uma licença que cai no fim do mês.
        const baixaAtual = baixaProgramada(pega(lido, "modulos"));
        const antes = {
          bloqueado: bloqLido ?? null,
          desativado: desatLido ?? null,
          baixa_em: baixaAtual
        };
        const depois = {
          bloqueado: novoBloqueado ?? bloqLido ?? null,
          desativado: novoDesativado ?? desatLido ?? null
        };
        // Pedir de novo uma baixa que já está marcada não é mudança: é o mesmo
        // clique repetido porque a tela não mostrava a data. Aconteceu 3 vezes
        // seguidas na filial 39735 em 01/09/2026.
        const pedeBaixaJaMarcada = novoDesativado === true && desatLido === false && baixaAtual !== null;
        // ATIVAR COM BAIXA MARCADA É MUDANÇA, mesmo com os dois flags iguais.
        // O que muda é a DATA, e comparar só os booleanos dizia "nada a fazer"
        // para a única tela que sabe desfazer uma baixa. Foi o que aconteceu na
        // Beda Pizzaria em 01/09/2026, logo depois de a baixa ser marcada.
        const cancelaBaixaMarcada = novoDesativado === false && baixaAtual !== null;
        const semMudanca = pedeBaixaJaMarcada
          || (antes.bloqueado === depois.bloqueado && antes.desativado === depois.desativado && !cancelaBaixaMarcada);
        const camposVistos = {
          filial: Object.keys(fPl ?? {}),
          raiz: Object.keys(cruPl ?? {}),
          documentada: Object.keys(lido ?? {})
        };

        // O corpo NASCE da leitura documentada, inclusive `datavalidade` e
        // `datacadastro` de cada módulo: é isso que impede campo de sumir numa
        // rota que salva a filial inteira. Os cinco escalares que a documentada
        // devolve zerados vêm da outra leitura; os dois flags são o pedido, e
        // por isso são postos depois, fora do laço de completar.
        const montarCorpo = ()=>{
          const novo = JSON.parse(JSON.stringify(lido));
          if (!Array.isArray(novo.modulos)) novo.modulos = [];
          const completados = [];
          for (const k of [
            "codigoTipoNegocio",
            "codigoDetalhesTipoNegocio",
            "codigoOrigemVenda",
            "usuariosAdicionais",
            "pdvComandas"
          ]){
            const v = escalares[k];
            if (v === undefined || v === null) continue;
            if (JSON.stringify(novo[k]) !== JSON.stringify(v)) {
              completados.push({ campo: k, de: novo[k], para: v });
            }
            novo[k] = v;
          }
          novo.bloquearLicenca = depois.bloqueado;
          novo.desativarLicenca = depois.desativado;

          // ⚠️ MANDAR `desativarLicenca: false` NÃO CANCELA A BAIXA. Quem
          // mantém a licença marcada para cair é a `datavalidade` dos módulos,
          // e ela sobrevive a uma gravação que não a toca. É o mesmo fato já
          // conhecido do módulo: cancelar registra a data, e reativar tem que
          // LIMPAR a data. Sem isto, "Ativar" devolveria HTTP 200 e a licença
          // continuaria caindo no dia marcado.
          //
          // Limpa só as datas IGUAIS à baixa da licença. Um módulo com data
          // própria e anterior foi cancelado sozinho, e ressuscitá-lo aqui
          // seria decidir por alguém que essa venda voltou.
          const datasLimpas = [];
          if (novoDesativado === false && baixaAtual) {
            for (const m of novo.modulos){
              if (pega(m, "ativo") === false) continue;
              const bruto = pega(m, "datavalidade", "dataValidade", "data_validade");
              const d = typeof bruto === "string" ? bruto.slice(0, 10) : null;
              if (d !== baixaAtual) continue;
              datasLimpas.push({ modulo: pega(m, "codigo"), de: bruto });
              // Escreve no MESMO nome que veio, para não criar uma chave nova
              // ao lado da que o parceiro lê.
              for (const k of Object.keys(m)){
                if (k.toLowerCase() === "datavalidade") m[k] = null;
              }
            }
          }

          // O estado da licença grava a filial inteira igual ao módulo, então
          // ele apagava a baixa dos módulos cancelados do mesmo jeito. Vem
          // DEPOIS do laço acima de propósito: se o "Ativar" limpou a data de
          // um módulo que a ficha dá como cancelado, isto o desliga de novo.
          // Ativar a licença não é ressuscitar venda que alguém cancelou.
          const reafirmados = reafirmarCancelados(novo, cancelados, new Set());

          // O que muda ALÉM do pedido e do que foi completado. Mais de zero
          // aqui é campo se perdendo, e é para isso que a lista existe.
          const jaContados = new Set([
            ...completados.map((c)=>c.campo),
            "bloquearLicenca",
            "desativarLicenca",
            "modulos"
          ]);
          const diferencas = [];
          for (const k of new Set([...Object.keys(lido), ...Object.keys(novo)])){
            if (jaContados.has(k)) continue;
            if (JSON.stringify(lido[k]) !== JSON.stringify(novo[k])) {
              diferencas.push({ campo: k, de: lido[k], para: novo[k] });
            }
          }
          return { novo, completados, diferencas, datas_limpas: datasLimpas, reafirmados };
        };

        // Os obrigatórios da gravação, os mesmos do modo módulo: sem eles a
        // filial inteira seria regravada com zero em tipo de negócio e origem
        // da venda.
        const faltamObrigatorios = ["codigoTipoNegocio", "codigoDetalhesTipoNegocio", "codigoOrigemVenda"]
          .filter((k)=>escalares[k] === undefined || escalares[k] === null);

        if (simular) {
          const m = podeGravar && !faltamObrigatorios.length ? montarCorpo() : null;
          return responder({
            ok: true,
            simulado: true,
            modo: "estado",
            par: "documentado",
            pode_gravar: podeGravar && faltamObrigatorios.length === 0,
            faltando: [...faltaEstado, ...faltamObrigatorios],
            campos_vistos: camposVistos,
            antes,
            depois,
            sem_mudanca: podeGravar && semMudanca,
            url_gravacao: `${LEITURA}/licenciamento/minhaslicencas/saveFilial`,
            completados: m?.completados ?? null,
            diferencas: m?.diferencas ?? null,
            datas_limpas: m?.datas_limpas ?? null,
            payload: m?.novo ?? null,
            leitura_crua: cruPl
          }, {
            headers: cors
          });
        }
        if (!podeGravar || faltamObrigatorios.length) {
          return responder({
            ok: false,
            etapa: "mapeamento",
            modo: "estado",
            mensagem: `A leitura da filial não trouxe ${[...faltaEstado, ...faltamObrigatorios].join(" nem ")}. Gravar decidiria por conta própria o estado da licença. Nada foi enviado ao OEM.`,
            faltando: [...faltaEstado, ...faltamObrigatorios],
            campos_vistos: camposVistos,
            leitura_crua: cruPl
          }, {
            status: 422,
            headers: cors
          });
        }
        if (semMudanca) {
          return responder({
            ok: true,
            modo: "estado",
            sem_mudanca: true,
            antes,
            mensagem: pedeBaixaJaMarcada
              ? `A baixa desta licença já está marcada para ${antes.baixa_em} no OEM. Nada foi enviado.`
              : "A licença já está nesse estado no OEM. Nada foi enviado."
          }, {
            headers: cors
          });
        }

        const mont = montarCorpo();
        const rEst = await fetch(`${LEITURA}/licenciamento/minhaslicencas/saveFilial`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tk}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(mont.novo)
        });
        const txtEst = await rEst.text().catch(()=>"");
        let respEst = txtEst;
        try {
          respEst = JSON.parse(txtEst);
        } catch  {}

        // ------------------------------------------------- a conferência
        //
        // ⚠️ CADA DIMENSÃO CONFIRMA POR UM SINAL DIFERENTE, e confundi-las foi
        // o defeito da primeira versão.
        //
        // BLOQUEIO aplica na hora: o `bloqueado` do pdvlegal vira `true` e a
        // releitura fecha (provado na filial 5089, com o portal na mão).
        //
        // DESATIVAÇÃO NÃO. O OEM agenda a baixa para o fim do mês de cobrança:
        // na filial 39735, em 01/09/2026, `desativarLicenca: true` voltou 200,
        // o portal passou a mostrar "Desativa em: 30/09/2026" e o `status`
        // continuou `"AT"`. Conferir isso pelo `status` NUNCA confirmaria, e a
        // primeira versão marcava âmbar em cima de uma gravação certa. Alarme
        // que dispara com tudo certo ensina a ignorar a tela: o usuário clicou
        // três vezes seguidas por causa dele.
        //
        // O sinal da desativação é a DATA, e ela só existe na leitura
        // documentada. Por isso a conferência lê os DOIS hosts.
        let conferencia = null;
        if (rEst.ok) {
          const mexeuNoBloqueio = novoBloqueado !== undefined;
          for(let i = 0; i < 3; i++){
            if (i > 0) await new Promise((r)=>setTimeout(r, 1500));
            try {
              const rConf = await fetch(`${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`, {
                headers: {
                  Authorization: `Bearer ${tkPl}`,
                  Accept: "application/json"
                }
              });
              if (!rConf.ok) throw new Error(`HTTP ${rConf.status}`);
              const depoisCru = await rConf.json().catch(()=>null);
              if (!depoisCru) throw new Error("a releitura não devolveu JSON");
              const d = depoisCru.filial ?? depoisCru;

              // A data só na releitura documentada, e só quando o pedido foi
              // sobre desativação: uma chamada a mais por bloqueio seria custo
              // sem pergunta.
              let baixaDepois = null;
              if (!mexeuNoBloqueio) {
                const rDoc2 = await fetch(urlLer, {
                  headers: {
                    Authorization: `Bearer ${tk}`,
                    Accept: "application/json"
                  }
                });
                const lido2 = rDoc2.ok ? await rDoc2.json().catch(()=>null) : null;
                baixaDepois = lido2 ? baixaProgramada(pega(lido2, "modulos")) : null;
              }

              const achado = {
                bloqueado: boolEstrito(pega(d, "bloquearLicenca", "bloqueado", "bloquear")) ?? null,
                desativado: desativadoLido(d) ?? null,
                baixa_em: baixaDepois
              };

              // Desativar: vale a baixa marcada OU o status já virado.
              // Ativar: precisa das duas coisas, senão "ativei" com uma baixa
              // pendente seria mentira.
              const bate = mexeuNoBloqueio
                ? achado.bloqueado === depois.bloqueado
                : depois.desativado === true
                  ? (achado.desativado === true || achado.baixa_em !== null)
                  : (achado.desativado === false && achado.baixa_em === null);

              conferencia = {
                par: "documentado",
                dimensao: mexeuNoBloqueio ? "bloqueio" : "desativacao",
                tentativas: i + 1,
                esperado: depois,
                encontrado: achado,
                confirmado: bate,
                baixa_em: achado.baixa_em,
                mensagem: !bate
                  ? (mexeuNoBloqueio
                      ? `Gravado, mas a licença ainda mostra bloqueado=${achado.bloqueado}. A releitura do parceiro atrasa, então isto não afirma que não aplicou.`
                      : `Gravado, mas a licença não mostra nem a baixa marcada nem o estado novo. A releitura do parceiro atrasa, então isto não afirma que não aplicou.`)
                  : mexeuNoBloqueio
                    ? "Relido no OEM: confere."
                    : achado.baixa_em && achado.desativado !== true
                      ? `Baixa marcada no OEM para ${achado.baixa_em}. A licença fica de pé e continua sendo cobrada até lá.`
                      : "Relido no OEM: confere."
              };
              if (bate) break;
            } catch (e) {
              conferencia = {
                par: "documentado",
                tentativas: i + 1,
                confirmado: null,
                mensagem: `Não deu para reler: ${e instanceof Error ? e.message : String(e)}`
              };
            }
          }
        }
        return responder({
          ok: rEst.ok,
          http: rEst.status,
          modo: "estado",
          par: "documentado",
          // A recusa precisa DIZER o que o parceiro respondeu. Na primeira
          // tentativa pelo pdvlegal a tela mostrou "O OEM recusou a alteração"
          // e o motivo (HTTP 500) só apareceu consultando o log no banco.
          mensagem: rEst.ok ? undefined : `O OEM recusou a gravação (HTTP ${rEst.status}): ${(typeof respEst === "string" ? respEst : JSON.stringify(respEst)).slice(0, 300)}`,
          antes,
          depois,
          completados: mont.completados,
          diferencas: mont.diferencas,
          datas_limpas: mont.datas_limpas,
          reafirmados: mont.reafirmados,
          payload: mont.novo,
          resposta: respEst,
          conferencia
        }, {
          status: rEst.ok ? 200 : 502,
          headers: cors
        });
      }

      // --------------------------------------------------------- modificar
      const montado = montarPayloadDocumentado(lido, escalares, alteracoes, cancelados);
      if (montado.erro) {
        return responder({
          ok: false, etapa: "modulo", ...montado.erro
        }, { status: montado.erro.status ?? 400, headers: cors });
      }
      const novo = montado.novo;
      const alvos = montado.alvos;
      // `alvo` no singular continua saindo na resposta: a aba Fila e o log
      // guardam esse campo desde antes do lote, e sumir com ele quebraria a
      // leitura do que já está gravado. Com um módulo só, é o mesmo de sempre.
      const alvoDescrito = alvos.length === 1 ? alvos[0] : alvos;
      const diferencas = montado.diferencas;
      const completados = montado.completados;

      if (simular) {
        return responder({
          ok: true, simulado: true, par: "documentado",
          codproduto: codProdutoDoc, url_leitura: urlLer,
          url_gravacao: `${LEITURA}/licenciamento/minhaslicencas/saveFilial`,
          alvo: alvoDescrito,
          alvos,
          completados,
          // O que a gravação vai DESLIGAR além do pedido, por a ficha dar como
          // cancelado. É a lista mais importante de conferir antes de gravar
          // em licença de cliente: cada linha aqui é uma cobrança que para.
          reafirmados: montado.reafirmados,
          diferencas,
          leitura: lido,
          payload: novo
        }, { headers: cors });
      }

      // ---------------------------------------------------------- gravar
      const rSave = await fetch(`${LEITURA}/licenciamento/minhaslicencas/saveFilial`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(novo)
      });
      const txtSave = await rSave.text().catch(()=>"");
      let respSave = txtSave;
      try { respSave = JSON.parse(txtSave); } catch {}

      // Releitura pelo MESMO caminho, que é o único que enxerga `datavalidade`.
      // Uma releitura só, conferindo TODOS os módulos do lote — o pedido e as
      // reafirmações, que também desligam módulo e por isso também se conferem.
      // O critério mora em `conferirModulo`.
      let conferencia = null;
      let conferencias = null;
      if (rSave.ok) {
        try {
          const rConf = await fetch(urlLer, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
          const depois = await rConf.json().catch(()=>null);
          if (depois) {
            conferencias = [
              ...alteracoes.map(({ codigo, quantidade })=>
                ({ par: "documentado", pedido: "alteracao", ...conferirModulo(depois, codigo, quantidade) })),
              ...(montado.reafirmados ?? []).map((r)=>
                ({ par: "documentado", pedido: "reafirmacao", ...conferirModulo(depois, r.codigo, 0) })),
            ];
            conferencia = conferencias.length === 1 ? conferencias[0] : {
              par: "documentado",
              // Num lote, "confirmado" é o E de todos: um módulo que não bateu
              // é o lote que não bateu. Somar como "quase certo" esconderia
              // justamente a linha que precisa de gente.
              confirmado: conferencias.every((c)=>c.confirmado),
              itens: conferencias,
              mensagem: conferencias.every((c)=>c.confirmado)
                ? `Relidos no OEM pelo caminho documentado: os ${conferencias.length} conferem.`
                : conferencias.filter((c)=>!c.confirmado).map((c)=>`módulo ${c.codigo}: ${c.mensagem}`).join(" ")
            };
          }
        } catch (e) {
          conferencia = { par: "documentado", confirmado: null, mensagem: `Não deu para reler: ${e instanceof Error ? e.message : String(e)}` };
        }
      }

      return responder({
        ok: rSave.ok, http: rSave.status, par: "documentado",
        codproduto: codProdutoDoc, alvo: alvoDescrito, alvos, completados, diferencas,
        reafirmados: montado.reafirmados,
        payload: novo, resposta: respSave, conferencia, conferencias
      }, { status: rSave.ok ? 200 : 502, headers: cors });
    }

    const token = await obterToken(creds.baseUrl, creds);
    // ------------------------------------------------------------------ ler
    const rLer = await fetch(`${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });
    const cruTexto = await rLer.text().catch(()=>"");
    let cru = {};
    try {
      cru = JSON.parse(cruTexto);
    } catch  {}
    if (!rLer.ok) {
      return responder({
        ok: false,
        etapa: "leitura",
        http: rLer.status,
        corpo: cruTexto.slice(0, 500)
      }, {
        status: 502,
        headers: cors
      });
    }
    const f = cru.filial ?? cru;
    // A leitura do host de ESCRITA chama o preço do módulo de `valor` — não de
    // `valorUnitario`. Sem esse apelido, `?? 0` zerava o preço de todos os
    // módulos da licença a cada gravação (pego na simulação de 21/08/2026, na
    // filial 4517/5089: NFCE 19,69 e Estoque 25,95 iriam a zero).
    const unitDe = (m)=>num(pega(m, "valorUnitario", "valor_unitario", "valorunitario", "valor"));
    const qtdDe = (m)=>num(pega(m, "quantidade", "qtd")) ?? 0;
    // A leitura não traz total por módulo; o total é unitário × quantidade.
    const totalDe = (m)=>num(pega(m, "valorTotal", "valor_total", "valortotal")) ?? Math.round((unitDe(m) ?? 0) * qtdDe(m) * 100) / 100;
    const modulosCrus = pega(f, "modulos") ?? pega(cru, "modulos");
    const payload = {
      codEmpresa: num(pega(f, "codEmpresa", "codempresa", "codgrupoeconomico", "codgrupo")) ?? Number(empresa),
      codFilial: num(pega(f, "codFilial", "codfilial", "codloja")) ?? Number(filial),
      // codProduto vem na RAIZ da resposta, não dentro de `filial` — foi o que
      // barrou a primeira gravação real (21/08/2026). Mesmo tratamento que
      // `modulos` já tinha: procura nos dois lugares.
      codProduto: num(pega(f, "codProduto", "codproduto") ?? pega(cru, "codProduto", "codproduto")),
      nomeLoja: pega(f, "nomeLoja", "nomeloja", "nomefilial", "nome"),
      cpfCnpj: pega(f, "cpfCnpj", "cpf_cnpj", "cnpjloja", "cnpJloja", "cnpj"),
      // Os apelidos textuais (`tipoNegocio`, `detalhesTipoNegocio`, `origemVenda`)
      // trazem "Varejo", "Outros" e "Migração" — TEXTO, não código. Eles passavam
      // pela guarda como se estivessem preenchidos e a gravação iria adiante com
      // tipo de negócio e origem errados, numa rota que salva a filial inteira.
      // Os códigos de verdade estão em codTipoNegocio / codDetalhesTipoNegocio /
      // codOrigemVenda.
      codigoTipoNegocio: num(pega(f, "codTipoNegocio", "codigoTipoNegocio", "codtiponegocio")),
      codigoDetalhesTipoNegocio: num(pega(f, "codDetalhesTipoNegocio", "codigoDetalhesTipoNegocio", "coddetalhestiponegocio")),
      codigoOrigemVenda: num(pega(f, "codOrigemVenda", "codigoOrigemVenda", "codorigemvenda")),
      bloquearLicenca: pega(f, "bloquearLicenca", "bloqueado", "bloquear") === true,
      // Vale para os modos módulo e cadastro também, e é aí que estava o bug:
      // sem isto, gravar um módulo numa licença desativada a reativava. Ver
      // `desativadoLido`.
      desativarLicenca: desativadoLido(f) ?? false,
      usuarios: num(pega(f, "usuarios", "usuariosAdicionais", "usuariosadicionais")) ?? 0,
      pdvComandas: num(pega(f, "pdvComandas", "pdvcomandas")) ?? 0
    };
    // ------------------------------------------------------------- o guarda
    const faltando = [];
    for (const k of [
      "codProduto",
      "codigoTipoNegocio",
      "codigoDetalhesTipoNegocio",
      "codigoOrigemVenda"
    ]){
      if (payload[k] === undefined) faltando.push(k);
    }
    if (!Array.isArray(modulosCrus) || modulosCrus.length === 0) faltando.push("modulos");
    // Zero legítimo existe (o NFE custa 0 de verdade). AUSENTE, não: é sintoma
    // de nome de campo divergente, e gravar mandaria zero para uma licença que
    // cobra. Como a rota salva a filial inteira, um preço perdido aqui some da
    // cobrança do parceiro sem ninguém pedir.
    if (Array.isArray(modulosCrus)) {
      const semValor = modulosCrus.filter((m)=>unitDe(m) === undefined).map((m)=>num(pega(m, "codigo", "codModulo", "cod")));
      if (semValor.length) faltando.push(`valor dos módulos ${semValor.join(", ")}`);
    }
    if (faltando.length) {
      return responder({
        ok: false,
        etapa: "mapeamento",
        mensagem: "A leitura da filial não trouxe campos obrigatórios da gravação. Nada foi enviado ao OEM.",
        faltando,
        // O payload cru é a resposta: com ele o mapeamento se conserta numa
        // tentativa, em vez de tentar nome por nome no escuro.
        leitura_crua: cru
      }, {
        status: 422,
        headers: cors
      });
    }
    // Reconstrói modulos[] igual ao que veio. A rota salva a filial inteira:
    // omitir a lista some com todos os módulos da licença.
    const espelharModulos = ()=>modulosCrus.map((m)=>({
          codigo: num(pega(m, "codigo", "codModulo", "cod")),
          ativo: pega(m, "ativo") !== false,
          quantidade: num(pega(m, "quantidade", "qtd")) ?? 0,
          valorUnitario: unitDe(m) ?? 0,
          valorTotal: totalDe(m)
        }));
    // O modo estado NÃO passa mais por aqui: ele grava pela rota documentada,
    // no bloco `par_documentado` acima. O pdvlegal respondeu HTTP 500 nas duas
    // tentativas de 01/09/2026 com `bloquearLicenca: true`, e o comentário
    // daquele bloco tem a medição.
    // ------------------------------------------------------- modo cadastro
    //
    // Corrige nome da loja e/ou CNPJ, sem tocar em módulo nenhum. A guarda
    // acima já garantiu tipo de negócio, origem da venda e preço dos módulos;
    // aqui falta a dos dois campos deste modo: o que NÃO vai ser trocado
    // precisa ter vindo na leitura, senão a gravação da filial inteira o
    // apagaria em silêncio.
    if (modoCadastro) {
      const faltaCadastro = [];
      if (novoNome === undefined && (payload.nomeLoja === undefined || payload.nomeLoja === null)) faltaCadastro.push("nomeLoja");
      if (novoCnpj === undefined && (payload.cpfCnpj === undefined || payload.cpfCnpj === null)) faltaCadastro.push("cpfCnpj");
      if (faltaCadastro.length) {
        return responder({
          ok: false,
          etapa: "mapeamento",
          mensagem: "A leitura da filial não trouxe um campo de cadastro que seria regravado. Nada foi enviado ao OEM.",
          faltando: faltaCadastro,
          leitura_crua: cru
        }, {
          status: 422,
          headers: cors
        });
      }
      const antes = {
        nomeLoja: payload.nomeLoja ?? null,
        cpfCnpj: payload.cpfCnpj ?? null
      };
      payload.modulos = espelharModulos();
      if (novoNome !== undefined) payload.nomeLoja = novoNome;
      if (novoCnpj !== undefined) payload.cpfCnpj = novoCnpj;
      const depois = {
        nomeLoja: payload.nomeLoja ?? null,
        cpfCnpj: payload.cpfCnpj ?? null
      };
      if (antes.nomeLoja === depois.nomeLoja && antes.cpfCnpj === depois.cpfCnpj) {
        return responder({
          ok: true,
          modo: "cadastro",
          sem_mudanca: true,
          antes,
          mensagem: "O OEM já está com esses valores. Nada foi enviado."
        }, {
          headers: cors
        });
      }
      if (simular) {
        return responder({
          ok: true,
          simulado: true,
          modo: "cadastro",
          antes,
          depois,
          payload,
          leitura_crua: cru
        }, {
          headers: cors
        });
      }
      const rCad = await fetch(`${creds.baseUrl}/v1/licenciamento/filial`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      });
      const txtCad = await rCad.text().catch(()=>"");
      let respCad = txtCad;
      try {
        respCad = JSON.parse(txtCad);
      } catch  {}
      return responder({
        ok: rCad.ok,
        http: rCad.status,
        modo: "cadastro",
        antes,
        depois,
        payload,
        resposta: respCad
      }, {
        status: rCad.ok ? 200 : 502,
        headers: cors
      });
    }
    // ------------------------------------------------------- a conferência
    // Gravar e receber 200 é o parceiro dizendo "aceitei o pedido", NÃO "a
    // licença ficou assim". Por isso a filial é RELIDA depois de gravar.
    //
    // ⚠️ A RELEITURA ATRASA, e isso foi medido em 28/08/2026, não suposto:
    // um cancelamento de 4 para 3 foi aceito, a releitura imediata devolveu 4,
    // e o portal do parceiro já mostrava 3. No mesmo dia, um aumento de 3 para
    // 4 releu 4 na hora. Ou seja: o atraso existe e não é constante.
    //
    // Duas consequências desenharam o que está abaixo:
    //
    //   1. TENTAR MAIS DE UMA VEZ. Uma leitura só, logo depois de gravar,
    //      transforma escrita certa em alarme.
    //   2. NÃO AFIRMAR CAUSA. A versão anterior deste código chamava
    //      "leu o valor antigo numa redução" de baixa agendada para o fim do
    //      mês. Era interpretação, e estava errada. O que dá para afirmar é o
    //      fato: pedimos X e a licença mostrava Y depois de N leituras. Por que,
    //      só o parceiro sabe.
    //
    // `confirmado: false` NÃO quer dizer "falhou" — quer dizer "não deu para
    // confirmar". Quem consome não bloqueia nada com isso (ver a
    // oem-sync-processar): marca e deixa à vista.
    const CONF_TENTATIVAS = 3;
    const CONF_ESPERA_MS = 1500;
    // O módulo cru da última leitura, para o veredito poder olhar campos que a
    // normalização do payload joga fora (e para mostrá-los quando não confirmar).
    let ultimoModuloLido = null;

    async function lerCampoAgora(campoAlvo) {
      const r = await fetch(`${creds.baseUrl}/v1/licenciamento/${empresa}/${filial}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const depois = await r.json().catch(()=>null);
      if (!depois) throw new Error("a releitura não devolveu JSON");
      const d = depois.filial ?? depois;
      if (campoAlvo === "usuarios" || campoAlvo === "pdvComandas") {
        return campoAlvo === "usuarios" ? num(pega(d, "usuarios", "usuariosAdicionais", "usuariosadicionais")) ?? 0 : num(pega(d, "pdvComandas", "pdvcomandas")) ?? 0;
      }
      const lista = pega(d, "modulos") ?? pega(depois, "modulos");
      const alvo = (Array.isArray(lista) ? lista : []).find((m)=>num(pega(m, "codigo", "codModulo", "cod")) === moduloCodigo);
      // Sumiu da lista depois de um pedido de baixa: é baixa feita, não leitura
      // incompleta. Inativo conta como zero pelo mesmo motivo.
      ultimoModuloLido = alvo ?? null;
      return alvo === undefined ? 0 : pega(alvo, "ativo") === false ? 0 : num(pega(alvo, "quantidade", "qtd")) ?? 0;
    }

    // Até quando o módulo continua valendo depois de desmarcado.
    //
    // O portal do parceiro mostra "IFood - Válido até: 31/08/2026" ao lado do
    // módulo desmarcado: desativar CANCELA, mas a licença o mantém válido até o
    // fim do mês. A leitura ainda o conta nesse intervalo, e sem isto um
    // cancelamento CERTO vira observação de alarme na tela (foi o que aconteceu
    // em 28/08/2026).
    //
    // ⚠️ Os nomes dos campos aqui são TENTATIVA, não contrato conhecido. O que
    // se sabe é que a rota de custos chama de `datavalidade`; se a leitura da
    // escrita usar outro nome, nada disto dispara e a conferência segue exatamente
    // como antes. Por isso o módulo cru vai junto no retorno quando não confirma:
    // é ele que mostra os nomes de verdade na próxima ocorrência, em vez de
    // deixar a gente adivinhando de novo.
    function validoAte(m) {
      const v = pega(m, "datavalidade", "dataValidade", "data_validade", "validade", "dataValidadeModulo");
      if (typeof v !== "string" || v.length < 10) return null;
      const d = v.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
      // Data no passado não é baixa combinada: é outra coisa, e não pode virar
      // "está tudo certo".
      return d >= new Date().toISOString().slice(0, 10) ? d : null;
    }

    async function conferir(campoAlvo, esperado, antes) {
      const alvoNum = Number(esperado);
      const antesNum = Number(antes);
      let encontrado;
      let ultimoMotivo = null;
      for(let i = 1; i <= CONF_TENTATIVAS; i++){
        if (i > 1) await new Promise((r)=>setTimeout(r, CONF_ESPERA_MS));
        try {
          encontrado = await lerCampoAgora(campoAlvo);
        } catch (e) {
          ultimoMotivo = e instanceof Error ? e.message : String(e);
          continue;
        }
        if (encontrado === alvoNum) {
          // Módulo LIGADO que continua carregando uma data de validade futura.
          //
          // O contrato de escrita não tem campo de validade: ao reativar, a
          // gente manda `ativo: true` e NÃO limpa a data que ficou do
          // cancelamento anterior. Se o parceiro também não limpar, o módulo
          // volta a funcionar e é desligado na data assim mesmo — e a
          // conferência diria "confirmado", porque a quantidade bate.
          //
          // MEDIDO em 28/08/2026, no portal: marcar o módulo de volta LIMPA a
          // data sozinho. Então, se a gravação por aqui tiver o mesmo efeito
          // que o clique no portal, este aviso nunca dispara — e é justamente
          // por não haver como provar isso daqui que ele existe. Rede de
          // segurança que custa nada quando não é necessária.
          //
          // Não dá para consertar daqui (não há campo de validade para mandar).
          // Dá para NÃO deixar passar calado, que é o que esta linha faz.
          const pendente = alvoNum > 0 && ultimoModuloLido ? validoAte(ultimoModuloLido) : null;
          if (pendente) return {
            confirmado: true,
            campo: campoAlvo,
            esperado: alvoNum,
            antes: antesNum,
            encontrado,
            valido_ate: pendente,
            tentativas: i,
            modulo_lido: ultimoModuloLido,
            mensagem: `Relido no OEM: a licença está com o valor pedido, MAS o módulo segue com validade até ${pendente.split("-").reverse().join("/")}. Enquanto essa data existir, ele será desativado nesse dia mesmo estando ativo agora. Marcar o módulo no portal do parceiro limpa a data.`
          };
          return {
            confirmado: true,
            campo: campoAlvo,
            esperado: alvoNum,
            antes: antesNum,
            encontrado,
            tentativas: i,
            mensagem: "Relido no OEM: a licença está com o valor pedido."
          };
        }
      }
      // Nunca conseguiu ler. Diferente de "leu e não bateu", e a diferença
      // importa: aqui não se sabe nada sobre a licença.
      if (encontrado === undefined) return {
        confirmado: null,
        campo: campoAlvo,
        esperado: alvoNum,
        antes: antesNum,
        tentativas: CONF_TENTATIVAS,
        mensagem: `Não deu para reler a licença depois de gravar: ${ultimoMotivo ?? "motivo desconhecido"}.`
      };
      // Desativação de módulo que o parceiro mantém válido até uma data futura:
      // ele foi cancelado, e a leitura ainda o conta até lá. Isso é o certo
      // acontecendo, não falha — ver o comentário da `validoAte`.
      const ate = alvoNum === 0 && ultimoModuloLido ? validoAte(ultimoModuloLido) : null;
      if (ate) return {
        confirmado: true,
        campo: campoAlvo,
        esperado: alvoNum,
        antes: antesNum,
        encontrado,
        valido_ate: ate,
        tentativas: CONF_TENTATIVAS,
        mensagem: `Módulo cancelado no OEM. A licença o mantém válido até ${ate.split("-").reverse().join("/")}, e até lá a leitura ainda o conta.`
      };

      return {
        confirmado: false,
        campo: campoAlvo,
        esperado: alvoNum,
        antes: antesNum,
        encontrado,
        tentativas: CONF_TENTATIVAS,
        // O módulo como o parceiro devolveu, sem normalizar. É ele que mostra os
        // nomes de campo de verdade quando a `validoAte` não achar a data.
        modulo_lido: ultimoModuloLido,
        mensagem: `O parceiro aceitou o pedido (${alvoNum}), mas a licença ainda mostrava ${encontrado} depois de ${CONF_TENTATIVAS} leituras. A leitura do parceiro às vezes atrasa: confira no portal antes de concluir que não foi.`
      };
    }
    // ------------------------------------------------- nem tudo é "módulo"
    // O contrato de gravação tem CAMPOS PRÓPRIOS para dois deles, fora de
    // modulos[]: `usuarios` e `pdvComandas`. O espelho do lado do DoctorSaaS
    // achata tudo numa lista só, então o pedido chega como "módulo 9" ou
    // "módulo 10" — mas gravar isso dentro de modulos[] não muda a quantidade
    // que o parceiro cobra: cria uma linha espúria e deixa o contador intacto.
    // Conferido na filial 4517/5089 em 21/08/2026: espelho diz Usuário Cloud
    // qtd 2 e Licença PDV qtd 1; a leitura da escrita diz usuarios 2 e
    // pdvComandas 1. São o mesmo número em nomes diferentes.
    const CAMPO_PROPRIO = {
      9: "usuarios",
      10: "pdvComandas"
    };
    // O código 8 é o produto (GESTAO LEGAL), não um módulo: mexer nele por aqui
    // não tem significado.
    if (moduloCodigo === 8) {
      return responder({
        ok: false,
        etapa: "modulo",
        mensagem: "O código 8 é o produto da licença, não um módulo. Nada foi enviado."
      }, {
        status: 400,
        headers: cors
      });
    }
    if (CAMPO_PROPRIO[moduloCodigo]) {
      const campo = CAMPO_PROPRIO[moduloCodigo];
      payload.modulos = modulosCrus.map((m)=>({
          codigo: num(pega(m, "codigo", "codModulo", "cod")),
          ativo: pega(m, "ativo") !== false,
          quantidade: num(pega(m, "quantidade", "qtd")) ?? 0,
          valorUnitario: unitDe(m) ?? 0,
          valorTotal: totalDe(m)
        }));
      // Antes de sobrescrever: é este número que diz se o pedido sobe ou desce,
      // e a régua da conferência depende disso.
      const antes = num(payload[campo]) ?? 0;
      payload[campo] = novaQtd;
      if (simular) {
        return responder({
          ok: true,
          simulado: true,
          campo,
          payload,
          leitura_crua: cru
        }, {
          headers: cors
        });
      }
      const rC = await fetch(`${creds.baseUrl}/v1/licenciamento/filial`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      });
      const txtC = await rC.text().catch(()=>"");
      let respC = txtC;
      try {
        respC = JSON.parse(txtC);
      } catch  {}
      return responder({
        ok: rC.ok,
        http: rC.status,
        campo,
        payload,
        resposta: respC,
        conferencia: rC.ok ? await conferir(campo, novaQtd, antes) : null
      }, {
        status: rC.ok ? 200 : 502,
        headers: cors
      });
    }
    // Quanto o módulo tinha ANTES, para a conferência saber se o pedido sobe ou
    // desce. Módulo que não está na licença, ou está inativo, vale zero.
    const moduloAntes = modulosCrus.find((m)=>num(pega(m, "codigo", "codModulo", "cod")) === moduloCodigo);
    const antesDoModulo = moduloAntes === undefined ? 0 : pega(moduloAntes, "ativo") === false ? 0 : qtdDe(moduloAntes);
    let achou = false;
    payload.modulos = modulosCrus.map((m)=>{
      const cod = num(pega(m, "codigo", "codModulo", "cod"));
      const qtd = num(pega(m, "quantidade", "qtd")) ?? 0;
      const unit = unitDe(m) ?? 0;
      const total = totalDe(m);
      const ativo = pega(m, "ativo") !== false;
      if (cod !== moduloCodigo) {
        return {
          codigo: cod,
          ativo,
          quantidade: qtd,
          valorUnitario: unit,
          valorTotal: total
        };
      }
      achou = true;
      if (novaQtd > 0) {
        return {
          codigo: cod,
          ativo: true,
          quantidade: novaQtd,
          valorUnitario: unit,
          valorTotal: Math.round(unit * novaQtd * 100) / 100
        };
      }
      return {
        codigo: cod,
        ativo: false,
        quantidade: 0,
        valorUnitario: unit,
        valorTotal: 0
      };
    });
    // Módulo que ainda não está na licença só entra se vier valor: sem preço,
    // ele seria acrescentado valendo zero e o parceiro deixaria de cobrar algo
    // que o cliente passou a usar.
    if (!achou && novaQtd > 0) {
      const unit = num(corpo.valor_unitario);
      if (unit === undefined) {
        return responder({
          ok: false,
          etapa: "modulo",
          mensagem: `O módulo ${moduloCodigo} não está na licença ${empresa}/${filial}. Para acrescentá-lo, informe valor_unitario.`
        }, {
          status: 400,
          headers: cors
        });
      }
      payload.modulos.push({
        codigo: moduloCodigo,
        ativo: true,
        quantidade: novaQtd,
        valorUnitario: unit,
        valorTotal: Math.round(unit * novaQtd * 100) / 100
      });
      achou = true;
    }
    if (!achou) {
      return responder({
        ok: false,
        etapa: "modulo",
        mensagem: `A licença ${empresa}/${filial} não tem o módulo ${moduloCodigo}. Nada foi enviado.`,
        modulos_na_licenca: modulosCrus.map((m)=>pega(m, "codigo", "codModulo", "cod"))
      }, {
        status: 404,
        headers: cors
      });
    }
    if (simular) {
      return responder({
        ok: true,
        simulado: true,
        payload,
        leitura_crua: cru
      }, {
        headers: cors
      });
    }
    // ---------------------------------------------------------------- gravar
    const rGravar = await fetch(`${creds.baseUrl}/v1/licenciamento/filial`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });
    const respTexto = await rGravar.text().catch(()=>"");
    let resposta = respTexto;
    try {
      resposta = JSON.parse(respTexto);
    } catch  {}
    return responder({
      ok: rGravar.ok,
      http: rGravar.status,
      payload,
      resposta,
      conferencia: rGravar.ok ? await conferir(`modulos[${moduloCodigo}]`, novaQtd, antesDoModulo) : null
    }, {
      status: rGravar.ok ? 200 : 502,
      headers: cors
    });
  } catch (e) {
    return responder({
      ok: false,
      mensagem: e instanceof Error ? e.message : String(e)
    }, {
      status: 500,
      headers: cors
    });
  }
});
