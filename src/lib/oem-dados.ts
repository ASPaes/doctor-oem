// ============================================================================
// Leitura direta do Supabase, pelo NAVEGADOR — sem passar pelo Worker.
//
// POR QUE ISSO EXISTE
// As telas liam por função de servidor: navegador -> Worker -> Supabase ->
// Worker -> navegador. O Worker buscava as 2.564 filiais, montava os objetos e
// serializava tudo em JSON. No plano grátis do Cloudflare são 10ms de CPU por
// requisição, e isso estourava:
//
//     22x "Worker exceeded CPU time limit."  ·  21x HTTP 503
//
// Metade das requisições morria, a consulta falhava e a tela — que tratava
// erro como lista vazia — desenhava "0 clientes". Daí o comportamento de
// "abre zerado, F5 traz os dados".
//
// O Worker no meio não acrescentava segurança nenhuma: quem protege é o RLS do
// Supabase, e ele vale igual para o navegador. Tirando o salto, some o gasto de
// CPU e a tela fica mais rápida.
//
// O que CONTINUA em função de servidor: escrita e o que precisa de segredo
// (disparar a carga, salvar credenciais, bloquear licença). Essas são leves.
// ============================================================================
import { supabase } from "@/integrations/supabase/client";
import type { Cliente, Modulo, Licenca } from "@/lib/mock-data";

/**
 * O PostgREST corta em 1000 linhas e `.limit()` do cliente NÃO sobrescreve —
 * o servidor trunca calado. Paginar com range é a única forma de trazer tudo.
 * Recebe uma FUNÇÃO que constrói a query, para cada página sair de um builder
 * limpo em vez de encadear range sobre range.
 */
export async function buscarTudo<T>(
  construir: () => any,
  tamanho = 1000,
): Promise<T[]> {
  const tudo: T[] = [];
  for (let de = 0; de < 100_000; de += tamanho) {
    const { data, error } = await construir().range(de, de + tamanho - 1);
    if (error) throw new Error(error.message);
    const lote = (data ?? []) as T[];
    tudo.push(...lote);
    if (lote.length < tamanho) break;
  }
  return tudo;
}

type LinhaOem = {
  id: string;
  empresa_codigo: string | null;
  filial_codigo: string | null;
  razao_social: string | null;
  nome_fantasia: string;
  grupo_economico: string | null;
  cnpj_cpf: string;
  produto_principal: string | null;
  numero_filiais: number | null;
  status: string | null;
  bloqueado: boolean | null;
  usuarios_adicionais: number | null;
  qtd_pdv_comandas: number | null;
  qtd_pdv: number | null;
  qtd_comandas: number | null;
  motivo_bloqueio: string | null;
  custo_total: number | string | null;
  modulos_ativos: unknown;
  licencas_detalhe: unknown;
  last_sync: string | null;
};

function paraModulos(v: unknown): Modulo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m, i) => ({
      id: String(m.id ?? `mod-${i}`),
      nome: String(m.nome ?? m.descricao ?? `Módulo ${i + 1}`),
      descricao: String(m.descricao ?? m.description ?? ""),
      ativo: m.ativo == null ? true : Boolean(m.ativo),
      valor: Number(
        (m.total as number | undefined) ??
          (m.valorTotal as number | undefined) ??
          (m.valor as number | undefined) ??
          0,
      ),
    }));
}

function paraLicencas(v: unknown): Licenca[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l, i) => ({
      id: String(l.id ?? `lic-${i}`),
      descricao: String(l.descricao ?? l.description ?? "Licença"),
      tipo: String(l.tipo ?? l.type ?? "core"),
      valor: Number(l.valor ?? l.value ?? 0),
    }));
}

export function paraCliente(row: LinhaOem): Cliente {
  const ativacao = row.last_sync ?? new Date().toISOString();
  return {
    id: row.id,
    codigoEmpresa: row.empresa_codigo ?? "",
    codigoFilial: row.filial_codigo ?? "",
    cnpj: row.cnpj_cpf,
    grupoEconomico: row.grupo_economico ?? "—",
    nomeFantasia: row.nome_fantasia,
    produtoPrincipal: row.produto_principal ?? "—",
    filiaisAtivas: row.numero_filiais ?? 0,
    dataCadastro: ativacao.slice(0, 10),
    dataAtivacao: ativacao,
    qtdPdv: row.qtd_pdv ?? row.qtd_pdv_comandas ?? 0,
    qtdComandas: row.qtd_comandas ?? 0,
    usuariosAdicionais: row.usuarios_adicionais ?? 0,
    // Duas dimensões INDEPENDENTES: `status` é operacional (Ativo/Desativado)
    // e `bloqueado` é a licença. Uma nunca é cópia da outra.
    ativo: (row.status ?? "Ativo").toLowerCase() === "ativo",
    bloqueado: Boolean(row.bloqueado),
    motivoBloqueio: row.motivo_bloqueio ?? undefined,
    custoMensal: Number(row.custo_total ?? 0),
    modulos: paraModulos(row.modulos_ativos),
    licencas: paraLicencas(row.licencas_detalhe),
  };
}

const COLUNAS =
  "id, empresa_codigo, filial_codigo, razao_social, nome_fantasia, grupo_economico, " +
  "cnpj_cpf, produto_principal, numero_filiais, status, bloqueado, usuarios_adicionais, " +
  "qtd_pdv_comandas, qtd_pdv, qtd_comandas, motivo_bloqueio, custo_total, " +
  "modulos_ativos, licencas_detalhe, last_sync";

/** Todas as filiais da empresa. O RLS já limita ao que o usuário pode ver. */
export async function listarClientes(tenantId: string): Promise<Cliente[]> {
  const linhas = await buscarTudo<LinhaOem>(() =>
    supabase
      .from("clientes_oem")
      .select(COLUNAS)
      .eq("tenant_id", tenantId)
      .order("nome_fantasia", { ascending: true }),
  );
  return linhas.map(paraCliente);
}

export async function obterCliente(tenantId: string, id: string): Promise<Cliente | null> {
  const { data, error } = await supabase
    .from("clientes_oem")
    .select(COLUNAS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? paraCliente(data as unknown as LinhaOem) : null;
}

export type SyncSettings = {
  intervaloHoras: number;
  ativo: boolean;
  logs: Array<{
    id: string;
    executadoEm: string;
    origem: string;
    status: string;
    clientesAtualizados: number;
    clientesFalha: number;
    totalClientes: number;
    duracaoMs: number | null;
    mensagem: string | null;
  }>;
};

export async function obterSyncSettings(tenantId: string): Promise<SyncSettings> {
  const [{ data: cfg }, { data: logs }] = await Promise.all([
    supabase
      .from("oem_sync_config")
      .select("intervalo_horas, ativo")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabase
      .from("oem_sync_logs")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("executado_em", { ascending: false })
      .limit(10),
  ]);

  return {
    intervaloHoras: cfg?.intervalo_horas ?? 24,
    ativo: cfg?.ativo ?? true,
    logs: (logs ?? []).map((l: any) => ({
      id: String(l.id),
      executadoEm: String(l.executado_em),
      origem: String(l.origem),
      status: String(l.status),
      clientesAtualizados: Number(l.clientes_atualizados ?? 0),
      clientesFalha: Number(l.clientes_falha ?? 0),
      totalClientes: Number(l.total_clientes ?? 0),
      duracaoMs: l.duracao_ms == null ? null : Number(l.duracao_ms),
      mensagem: (l.mensagem as string | null) ?? null,
    })),
  };
}

export type ChaveIntegracao = {
  id: string;
  nome: string;
  prefixo: string;
  ativa: boolean;
  criada_em: string;
  ultimo_uso_em: string | null;
  revogada_em: string | null;
};

/**
 * Chaves de integração da empresa. Lê direto do Supabase (RLS já limita ao
 * tenant) e NUNCA seleciona `token_hash` — a tela não tem o que fazer com ele.
 */
export async function listarChaves(tenantId: string): Promise<ChaveIntegracao[]> {
  const { data, error } = await supabase
    .from("oem_api_chaves")
    .select("id, nome, prefixo, ativa, criada_em, ultimo_uso_em, revogada_em")
    .eq("tenant_id", tenantId)
    .order("criada_em", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChaveIntegracao[];
}
