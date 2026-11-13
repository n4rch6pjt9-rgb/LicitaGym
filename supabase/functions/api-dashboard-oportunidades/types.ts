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

/** Recorte aceito pelo resumo executivo: só catálogo/CATMAT, os mesmos parâmetros da action=list (spec 0048 K-2). */
export interface RecorteResumo {
  catmat_grupo?: number[];
  catmat_classe?: number[];
  catmat_pdm?: number[];
  catmat_item?: number[];
  catalogo?: boolean;
}

export interface ResumoExecutivoActionParams {
  action: "resumo_executivo";
  recorte: RecorteResumo;
}

/**
 * Linha de public.dashboard_resumo_executivo (K-1). Desde a spec 0050, os valores somam só os itens no escopo
 * (categorias forte, catmat, borracha, piso, obra_piso e manutencao); null quando nenhum desses itens tem valor.
 */
export interface ResumoExecutivo {
  leads_total: number;
  monitoradas_total: number;
  valor_potencial_total: number | null;
  com_valor_total: number;
  prazo_amanha_total: number;
  prazo_amanha_valor: number | null;
  prazo_7_dias_total: number;
  prazo_7_dias_valor: number | null;
  calculado_em: string | null;
}

export type ActionParams =
  | ObjetoCategoriasActionParams
  | ListActionParams
  | GetActionParams
  | ReadinessActionParams
  | AcompanhamentoActionParams
  | ResumoExecutivoActionParams;

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
    /**
     * Pela Consulta: `dataAtualizacaoGlobal` (senão `dataAtualizacao`), sem offset. Pela busca (spec 0049,
     * `origem: "busca_pncp"`): `dataAtualizacao` da compra, em ISO -03:00. Não tratar como "global" sem olhar a origem.
     */
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
  /**
   * Só no Paradigma (spec 0061, K-1), do registro do item no mural (PesquisarProcessoDetalheItemProduto): melhor
   * lance (moeda do vencedor; senão a do processo), marca e modelo do vencedor. null = o portal não publicou.
   */
  melhorLance?: number | null;
  marcaVencedor?: string | null;
  modeloVencedor?: string | null;
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
  /** Spec 0049: `permite_adesao` do índice de busca (só nas atas com `origem: "busca_pncp"`). */
  permiteAdesao?: boolean | null;
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
  /**
   * Ausente = dados do PNCP ao vivo. "copia_local" = o PNCP falhou (`erro` mantido) e `dados` vêm da cópia gravada
   * pelo coletor (licitacao_itens / licitacao_documentos), de `copia_gravada_em`. Só Itens e Documentos têm cópia.
   */
  origem?: "copia_local" | "busca_pncp";
  /**
   * Quando o coletor viu os dados no PNCP pela última vez (ISO). Documentos: maior last_seen_at. Itens: null, porque
   * licitacao_itens não guarda essa data (desconhecida, não inventada).
   */
  copia_gravada_em?: string | null;
  /**
   * Spec 0049. Com `origem: "busca_pncp"` (só Resumo e Atas): `data_atualizacao_pncp` do índice de busca do PNCP, em
   * ISO -03:00 (Atas: a mais recente). null quando a busca não trouxe data.
   */
  busca_atualizado_em?: string | null;
  /** Spec 0049. Com `origem: "copia_local"` e a busca respondendo: a compra mudou no PNCP depois da cópia? */
  conferencia_busca?: ConferenciaBusca;
}

/**
 * Atualização da compra no índice de busca × a gravada pelo coletor (`licitacoes_externas.pncp_data_atualizacao`).
 * É a `dataAtualizacao` da compra, não a global: `compra_mudou: false` não prova que itens e documentos não mudaram.
 */
export interface ConferenciaBusca {
  /** ISO -03:00; null quando a busca não trouxe data. */
  pncp_atualizado_em: string | null;
  /** ISO UTC; null quando o coletor não gravou a data. */
  gravado_em: string | null;
  /** Índice posterior à gravada (comparado em segundos inteiros); null quando falta uma das duas. */
  compra_mudou: boolean | null;
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


// -----------------------------------------------------------------------------
// Spec 0061, K-1: acompanhamento do Paradigma (Sistema S) lido do banco
// -----------------------------------------------------------------------------

/**
 * Seção lida do banco (formato do K-4 da spec 0029). `gravado_em`: quando o coletor gravou (ISO; null =
 * desconhecido). Sem linha gravada ou falha de leitura: `dados: null` com `erro` explícito, nunca lista vazia.
 */
export interface SecaoBanco<T> {
  dados: T | null;
  total?: number;
  erro: string | null;
  origem: "banco";
  gravado_em: string | null;
}

/** Datas do processo no mural (raw da licitação), em ISO UTC; null = o portal não publicou (data zerada). */
export interface DatasProcessoParadigma {
  inicio: string | null;
  fim: string | null;
  publicacao: string | null;
  aberturaSessao: string | null;
  homologacao: string | null;
  finalizacao: string | null;
}

/** CompraMetadata (campos lidos pela tela do PNCP) + o que é só do Paradigma. */
export interface CompraParadigma extends CompraMetadata {
  fase: string | null;
  numeroProcesso: string | null;
  numeroEdital: string | null;
  datasProcesso: DatasProcessoParadigma;
}

/** Linha de licitacao_resultados (só posições finais de processo concluído). */
export interface ResultadoParadigma extends ItemResultado {
  numeroItem: number;
  ranking: number | null;
  vencedor: boolean;
  valorProposta: number | null;
  marca: string | null;
  modelo: string | null;
  situacao: string | null;
}

/** Lance da disputa (licitacao_lances), como o portal publica. */
export interface LanceHistorico {
  numeroItem: number;
  data: string | null;
  valor: number | null;
  moeda: string | null;
  fornecedorNome: string | null;
  fornecedorCnpj: string | null;
  marca: string | null;
  modelo: string | null;
  /** Posição final no ranking; null = lance da disputa sem posição final. */
  posicao: number | null;
  vencedor: boolean;
  origem: "portal_oficial";
}

/** Documento do processo (licitacao_documentos). Sem caminho do Storage: abrir usa a URL assinada (K-2). */
export interface ArquivoParadigma {
  documentoId: number | null;
  titulo: string | null;
  /** "resumo" = Resumo do processo (vem primeiro); "anexo" = anexo publicado no mural. */
  tipo: "resumo" | "anexo";
  url: null;
  mimeType: string | null;
  dataDocumento: string | null;
  /** status_processamento do coletor (ex.: "baixado", "pendente"). */
  status: string | null;
}

export interface AcompanhamentoParadigmaResponse {
  disponivel: true;
  id: number | string;
  origem: "banco";
  fonte: string;
  /** Sem chave PNCP: campos nulos (objeto, não null, para a tela do PNCP publicada antes do K-3). */
  pncp: { cnpj: null; ano: null; sequencial: null; numero_controle_pncp: null };
  url_edital: string | null;
  /** Mural público da fonte (o processo não tem URL própria no Paradigma). */
  url_acompanhamento: string | null;
  fase: string | null;
  compra: SecaoBanco<CompraParadigma>;
  itens: SecaoBanco<ItemAcompanhamento[]>;
  resultados: SecaoBanco<ResultadoParadigma[]>;
  /** Sempre em erro: o Paradigma não publica atas (mantida para a tela do PNCP não quebrar). */
  atas: SecaoBanco<AtaAcompanhamento[]>;
  historico: SecaoBanco<LanceHistorico[]>;
  arquivos: SecaoBanco<ArquivoParadigma[]>;
}
