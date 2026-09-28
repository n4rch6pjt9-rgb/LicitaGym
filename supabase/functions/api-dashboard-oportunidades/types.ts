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
}

export interface ReadinessActionParams {
  action: "readiness";
}

export type ActionParams = ListActionParams | GetActionParams | ReadinessActionParams;
