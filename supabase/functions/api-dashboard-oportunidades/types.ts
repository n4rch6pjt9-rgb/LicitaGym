import type { PortalSecao } from "../_shared/portal-compras.ts";

export interface LicitacaoFiltros {
  /** leads | monitorar (efetiva, da view). `historico` responde vazio: não é Oportunidade (é do BI). */
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
  /** Categorias canônicas do objeto (slugs de objeto_categorias, ou 'outros'). */
  objeto_categoria?: string[];
  /** Só licitações com selo de registro de preço (true) ou sem (false). */
  registro_preco?: boolean;
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

export interface ObjetoCategoriasActionParams {
  action: "objeto_categorias";
}

export interface AcompanhamentoActionParams {
  action: "acompanhamento";
  id: number | string;
  /** true só dispara a API do portal se a licitação está no pipeline. */
  atualizar?: boolean;
}

export type ActionParams =
  | ObjetoCategoriasActionParams
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
  /**
   * catalogoCodigoItem do PNCP, cru (string). Só é CATMAT (material) / CATSER (serviço) quando catalogoId = 1
   * (Catálogo do Compras.gov.br); com catalogoId = 2 ("Outros") é código próprio do órgão. null = não informado.
   */
  catalogoCodigoItem: string | null;
  /** catalogo.id do item no PNCP (1 = Compras.gov.br, 2 = Outros); null = sem catálogo. */
  catalogoId: number | null;
  catalogoNome: string | null;
  /** 'M' (material) | 'S' (serviço); null = desconhecido. */
  materialOuServico: "M" | "S" | null;
  /**
   * Situação para exibir, derivada (situacaoExibidaItem): a específica do PNCP quando não é "Em andamento"; com
   * "Em andamento", "Registro de Preço" (ata não cancelada), "Homologado" (resultado), "Suspensa" ou "Recebendo
   * Propostas" (fase da licitação); senão a do PNCP. situacaoCompraItemNome continua sendo o bruto.
   */
  situacaoExibida?: string | null;
  /**
   * PDM do item para a Inteligência de Preços (spec 0009, CA-8; precoReferencia.ts): pelo código CATMAT oficial
   * (`catalogo_pncp`) ou pelo casamento do texto com um único PDM (`casamento_texto`, derivado). null com
   * `codigoPdmMotivo` quando não há PDM único (serviço, nenhum, mais de um, consulta falha).
   */
  codigoPdm?: number | null;
  codigoPdmOrigem?: "catalogo_pncp" | "casamento_texto" | null;
  codigoPdmMotivo?: string | null;
  /**
   * Sigla de fornecimento da Pesquisa de Preço (UN, PAR, M2, RO) normalizada de `unidade` (texto livre do PNCP) por
   * dicionário fechado; null quando não dá para afirmar. Origem `normalizada_da_unidade_pncp`.
   */
  unidadeSigla?: string | null;
  unidadeSiglaOrigem?: "normalizada_da_unidade_pncp" | null;
}

export interface AtaAcompanhamento {
  numero: string | null;
  ano: number | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  dataAssinatura?: string | null;
  /** cancelado do PNCP OU dataCancelamento preenchida (o PNCP pode mandar a data com cancelado=false). */
  cancelado: boolean;
  /** dataCancelamento do PNCP (AtaRegistroPrecoPeriodoDTO), quando vier. */
  dataCancelamento?: string | null;
  objeto?: string | null;
  /**
   * Ata vigente hoje (America/Sao_Paulo): não cancelada e vigenciaInicio <= hoje <= vigenciaFim. null = sem
   * vigenciaFim (não dá para afirmar). Derivado em ataVigente.
   */
  vigente?: boolean | null;
}

export interface HistoricoEvento {
  data: string | null;
  categoria: string | null;
  tipo: string | null;
  item: number | null;
  documentoTitulo: string | null;
  justificativa: string | null;
  /** 'pncp' ou 'portal_oficial' */
  origem?: "pncp" | "portal_oficial";
}

export interface ArquivoAcompanhamento {
  titulo: string | null;
  tipo: string | null;
  url: string | null;
  sequencialDocumento?: number | null;
  /** dataPublicacaoPncp do PNCP (data do upload do arquivo), quando vem. */
  dataPublicacaoPncp?: string | null;
  /** statusAtivo do PNCP (false = arquivo inativado), quando vem. */
  statusAtivo?: boolean | null;
  /** URL do portal oficial da disputa para contornar falhas de CDN/S3 do PNCP (como erro 422) */
  url_portal_oficial?: string | null;
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
    /** licitacoes_externas.fase (fase real gravada pelo coletor); null = sem fase gravada. */
    fase?: string | null;
    compra: AcompanhamentoSection<CompraMetadata>;
    itens: AcompanhamentoSection<ItemAcompanhamento[]> & { total: number };
    atas: AcompanhamentoSection<AtaAcompanhamento[]> & { total: number };
    historico: AcompanhamentoSection<HistoricoEvento[]> & { total: number };
    arquivos: AcompanhamentoSection<ArquivoAcompanhamento[]> & { total: number; url_portal_oficial?: string | null };
    portal: PortalSecao | null;
    /** Indica se o portal oficial possui dados mais recentes ou se o PNCP está com atraso/indisponibilidade */
    pncp_em_atraso?: boolean;
    /** Metadados e estado do portal oficial da disputa identificado */
    portal_oficial?: {
      nome: string | null;
      url: string | null;
      host: string | null;
      metodo: string;
      consultado_em?: string | null;
      situacao?: string | null;
    } | null;
  };

