export type Role = "admin" | "financeiro" | "suporte";

export interface UserAccount {
  id: string;
  nome: string;
  email: string;
  role: Role;
  ativo: boolean;
  ultimoAcesso: string;
}

export interface Modulo {
  id: string;
  nome: string;
  descricao: string;
  ativo: boolean;
  valor: number;
}

export interface Licenca {
  id: string;
  descricao: string;
  tipo: string;
  valor: number;
}

export interface Cliente {
  id: string;
  codigoEmpresa: string;
  codigoFilial: string;
  cnpj: string;
  grupoEconomico: string;
  nomeFantasia: string;
  produtoPrincipal: string;
  filiaisAtivas: number;
  dataCadastro: string;
  dataAtivacao: string;
  qtdPdv: number;
  qtdComandas: number;
  usuariosAdicionais: number;
  ativo: boolean;
  bloqueado: boolean;
  motivoBloqueio?: string;
  custoMensal: number;
  modulos: Modulo[];
  licencas: Licenca[];
}

export const usuariosMock: UserAccount[] = [
  { id: "u1", nome: "Marina Castro", email: "marina@hub.io", role: "admin", ativo: true, ultimoAcesso: "2025-06-09T08:42:00Z" },
  { id: "u2", nome: "Diego Almeida", email: "diego@hub.io", role: "financeiro", ativo: true, ultimoAcesso: "2025-06-08T19:10:00Z" },
  { id: "u3", nome: "Paula Nakamura", email: "paula@hub.io", role: "suporte", ativo: true, ultimoAcesso: "2025-06-09T07:55:00Z" },
  { id: "u4", nome: "Renato Vieira", email: "renato@hub.io", role: "suporte", ativo: false, ultimoAcesso: "2025-05-30T14:00:00Z" },
  { id: "u5", nome: "Camila Souza", email: "camila@hub.io", role: "financeiro", ativo: true, ultimoAcesso: "2025-06-09T06:30:00Z" },
];

const baseModulos = (overrides: Partial<Record<string, { ativo: boolean; valor: number }>> = {}): Modulo[] => [
  { id: "nfce", nome: "NFC-e", descricao: "Emissão de cupom fiscal eletrônico", ativo: true, valor: 89.9, ...overrides.nfce },
  { id: "nfe", nome: "NF-e", descricao: "Nota fiscal eletrônica", ativo: true, valor: 129.9, ...overrides.nfe },
  { id: "estoque", nome: "Estoque", descricao: "Controle e movimentações", ativo: true, valor: 79.9, ...overrides.estoque },
  { id: "financeiro", nome: "Financeiro", descricao: "Contas, fluxo e conciliação", ativo: true, valor: 149.9, ...overrides.financeiro },
  { id: "crm", nome: "CRM", descricao: "Relacionamento e fidelidade", ativo: false, valor: 99.9, ...overrides.crm },
  { id: "delivery", nome: "Delivery", descricao: "Integração de pedidos online", ativo: false, valor: 119.9, ...overrides.delivery },
];

export const clientesMock: Cliente[] = [
  {
    id: "c1",
    codigoEmpresa: "0001",
    codigoFilial: "01",
    cnpj: "12.345.678/0001-90",
    grupoEconomico: "Grupo Aurora",
    nomeFantasia: "Aurora Mercados",
    produtoPrincipal: "Retail Cloud OEM",
    filiaisAtivas: 12,
    dataCadastro: "2022-03-14",
    dataAtivacao: "2022-03-18T10:32:00Z",
    qtdPdv: 48,
    qtdComandas: 0,
    usuariosAdicionais: 35,
    ativo: true,
    bloqueado: false,
    custoMensal: 4890.5,
    modulos: baseModulos({ crm: { ativo: true, valor: 99.9 } }),
    licencas: [
      { id: "l1", descricao: "Licença Servidor Central", tipo: "core", valor: 890.0 },
      { id: "l2", descricao: "PDV Frente de Caixa x48", tipo: "pdv", valor: 2400.0 },
      { id: "l3", descricao: "Usuário Adicional x35", tipo: "user", valor: 1050.0 },
      { id: "l4", descricao: "Conector Fiscal NF-e", tipo: "addon", valor: 280.5 },
      { id: "l5", descricao: "Módulo CRM Plus", tipo: "addon", valor: 270.0 },
    ],
  },
  {
    id: "c2",
    codigoEmpresa: "0002",
    codigoFilial: "01",
    cnpj: "98.765.432/0001-11",
    grupoEconomico: "Holding Vértice",
    nomeFantasia: "Vértice Restaurantes",
    produtoPrincipal: "Food Service OEM",
    filiaisAtivas: 6,
    dataCadastro: "2023-08-02",
    dataAtivacao: "2023-08-05T09:00:00Z",
    qtdPdv: 18,
    qtdComandas: 240,
    usuariosAdicionais: 22,
    ativo: true,
    bloqueado: true,
    motivoBloqueio: "Inadimplência - fatura #4821 vencida há 12 dias",
    custoMensal: 2310.0,
    modulos: baseModulos({ delivery: { ativo: true, valor: 119.9 }, crm: { ativo: true, valor: 99.9 } }),
    licencas: [
      { id: "l1", descricao: "Licença Servidor Central", tipo: "core", valor: 890.0 },
      { id: "l2", descricao: "PDV Frente de Caixa x18", tipo: "pdv", valor: 900.0 },
      { id: "l3", descricao: "Comandas Eletrônicas x240", tipo: "comanda", valor: 360.0 },
      { id: "l4", descricao: "Conector Delivery Hub", tipo: "addon", valor: 160.0 },
    ],
  },
  {
    id: "c3",
    codigoEmpresa: "0003",
    codigoFilial: "02",
    cnpj: "45.123.789/0001-22",
    grupoEconomico: "Independente",
    nomeFantasia: "Farmácia Pulse",
    produtoPrincipal: "Retail Cloud OEM",
    filiaisAtivas: 1,
    dataCadastro: "2024-11-20",
    dataAtivacao: "2024-11-22T15:21:00Z",
    qtdPdv: 3,
    qtdComandas: 0,
    usuariosAdicionais: 4,
    ativo: false,
    bloqueado: false,
    custoMensal: 580.0,
    modulos: baseModulos({ financeiro: { ativo: false, valor: 149.9 }, nfe: { ativo: false, valor: 129.9 } }),
    licencas: [
      { id: "l1", descricao: "Licença Servidor Central", tipo: "core", valor: 390.0 },
      { id: "l2", descricao: "PDV Frente de Caixa x3", tipo: "pdv", valor: 150.0 },
      { id: "l3", descricao: "Usuário Adicional x4", tipo: "user", valor: 40.0 },
    ],
  },
];

export interface ApiToken {
  id: string;
  nome: string;
  token: string;
  criadoEm: string;
  ultimoUso: string;
  ativo: boolean;
}

export const apiTokensMock: ApiToken[] = [
  { id: "t1", nome: "Integração ERP Parceiro", token: "xak_live_8f2c•••••••••••••a91", criadoEm: "2025-02-12", ultimoUso: "2025-06-09T07:01:00Z", ativo: true },
  { id: "t2", nome: "Portal do Cliente", token: "xak_live_22e1•••••••••••••f04", criadoEm: "2024-10-03", ultimoUso: "2025-06-08T22:14:00Z", ativo: true },
  { id: "t3", nome: "Sandbox - QA", token: "xak_test_aa00•••••••••••••b71", criadoEm: "2025-05-22", ultimoUso: "2025-06-01T11:00:00Z", ativo: false },
];

export interface Webhook {
  id: string;
  url: string;
  eventos: string[];
  ativo: boolean;
}

export const webhooksMock: Webhook[] = [
  { id: "w1", url: "https://erp.parceiro.com/hooks/hub", eventos: ["cliente.ativado", "cliente.bloqueado"], ativo: true },
  { id: "w2", url: "https://billing.internal/notify", eventos: ["licenca.atualizada", "cliente.bloqueado"], ativo: true },
  { id: "w3", url: "https://legacy.sistema.com/in", eventos: ["cliente.ativado"], ativo: false },
];

export interface WebhookLog {
  id: string;
  webhook: string;
  evento: string;
  status: number;
  duracaoMs: number;
  timestamp: string;
}

export const webhookLogsMock: WebhookLog[] = [
  { id: "lg1", webhook: "erp.parceiro.com", evento: "cliente.ativado", status: 200, duracaoMs: 184, timestamp: "2025-06-09T09:12:00Z" },
  { id: "lg2", webhook: "billing.internal", evento: "licenca.atualizada", status: 200, duracaoMs: 92, timestamp: "2025-06-09T09:10:00Z" },
  { id: "lg3", webhook: "erp.parceiro.com", evento: "cliente.bloqueado", status: 500, duracaoMs: 4302, timestamp: "2025-06-09T08:58:00Z" },
  { id: "lg4", webhook: "legacy.sistema.com", evento: "cliente.ativado", status: 404, duracaoMs: 1201, timestamp: "2025-06-09T08:41:00Z" },
  { id: "lg5", webhook: "billing.internal", evento: "cliente.bloqueado", status: 200, duracaoMs: 110, timestamp: "2025-06-09T08:30:00Z" },
];

export const formatBRL = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
