export interface LicitacaoFiltros {
  prioridade?: string;
  uf?: string;
  municipio?: string;
  orgao_cnpj?: string;
  orgao_nome?: string;
  modalidade?: string[];
  situacao?: string;
  fase?: string;
  categoria_escopo?: string;
  interesse_borracha?: boolean;
  fonte?: string;
  data_publicacao_inicio?: string;
  data_publicacao_fim?: string;
  data_inicio_min?: string;
  data_inicio_max?: string;
  data_fim_min?: string;
  data_fim_max?: string;
  data_homologacao_min?: string;
  data_homologacao_max?: string;
  valor_min?: number;
  valor_max?: number;
  busca?: string; // termo livre em objeto, numero_processo, numero_edital
  // Recorte CATMAT (Grupo -> Classe -> PDM -> Item), resolvido por public.licitacoes_ids_por_catmat
  catmat_grupo?: number[];
  catmat_classe?: number[];
  catmat_pdm?: number[];
  catmat_item?: number[];
  catalogo?: boolean; // somente o catálogo CATMAT da empresa
  /** Uso interno: ids resolvidos pelo recorte CATMAT (nunca vem do cliente). */
  ids?: number[];
}

export type SortField = "data_fim" | "data_publicacao" | "valor_total";
export type SortOrder = "asc" | "desc";

export interface PaginationParams {
  page: number;
  limit: number;
  order_by: SortField;
  order_direction: SortOrder;
}

export interface ListActionParams extends PaginationParams {
  action: "list";
  filtros: LicitacaoFiltros;
}

export interface GetActionParams {
  action: "get";
  id?: number | string;
  codigo_externo?: string;
  fonte?: string;
  orgao_cnpj?: string;
  processo_norm?: string;
  page?: number;
  limit?: number;
}

export interface ReadinessActionParams {
  action: "readiness";
}

export interface AcompanhamentoActionParams {
  action: "acompanhamento";
  id: number | string;
}

export type ActionParams =
  | ListActionParams
  | GetActionParams
  | ReadinessActionParams
  | AcompanhamentoActionParams;

export interface CompraMetadata {
  situacao: string | null;
  situacaoCompraId?: number | null;
  modalidade: string | null;
  modalidadeId?: number | null;
  objeto: string | null;
  valorEstimado: number | null;
  valorHomologado: number | null;
  datas: {
    publicacao: string | null;
    aberturaProposta: string | null;
    encerramentoProposta: string | null;
    inclusao: string | null;
    atualizacao: string | null;
  };
  linkSistemaOrigem: string | null;
  numeroCompra?: string | null;
  processo?: string | null;
  srp?: boolean | null;
  existeResultado?: boolean | null;
  orgaoEntidade?: unknown;
  unidadeOrgao?: unknown;
}

export interface ItemResultado {
  fornecedorCnpj: string | null;
  fornecedorNome: string | null;
  valorUnitarioHomologado: number | null;
  quantidadeHomologada: number | null;
  dataResultado: string | null;
}

export interface ItemAcompanhamento {
  numeroItem: number;
  descricao: string | null;
  quantidade: number | null;
  unidade: string | null;
  valorUnitarioEstimado: number | null;
  situacaoCompraItemNome: string | null;
  temResultado: boolean;
  resultados: ItemResultado[];
  resultadosErro?: string | null;
}

export interface AtaAcompanhamento {
  numero: string | null;
  ano: number | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  dataAssinatura?: string | null;
  cancelado: boolean;
  objeto?: string | null;
}

export interface HistoricoEvento {
  data: string | null;
  categoria: string | null;
  tipo: string | null;
  item: number | null;
  documentoTitulo: string | null;
  justificativa: string | null;
}

export interface ArquivoAcompanhamento {
  titulo: string | null;
  tipo: string | null;
  url: string | null;
  sequencialDocumento?: number | null;
}

export interface AcompanhamentoSection<T> {
  dados: T | null;
  total?: number;
  erro: string | null;
}

export type AcompanhamentoResponse =
  | {
    disponivel: false;
    id: number | string;
    motivo: string;
    razao: string;
  }
  | {
    disponivel: true;
    id: number | string;
    pncp: {
      cnpj: string;
      ano: number;
      sequencial: number;
      numero_controle_pncp?: string | null;
    };
    url_edital: string | null;
    url_acompanhamento: string | null;
    compra: AcompanhamentoSection<CompraMetadata>;
    itens: AcompanhamentoSection<ItemAcompanhamento[]> & { total: number };
    atas: AcompanhamentoSection<AtaAcompanhamento[]> & { total: number };
    historico: AcompanhamentoSection<HistoricoEvento[]> & { total: number };
    arquivos: AcompanhamentoSection<ArquivoAcompanhamento[]> & { total: number };
  };

