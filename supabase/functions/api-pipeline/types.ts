/** Tipos da api-pipeline (Dashboard #29): pipeline comercial da equipe, com etapas configuráveis. */

export const FASES = ["prospeccao", "proposta", "disputa", "conclusao"] as const;
export type Fase = (typeof FASES)[number];

export const DESFECHOS = ["vencida", "perdida", "descartada"] as const;
export type Desfecho = (typeof DESFECHOS)[number];

export interface Etapa {
  id: number;
  nome: string;
  fase: Fase;
  ordem: number;
  desfecho: Desfecho | null;
  exige_motivo: boolean;
  padrao: boolean;
}

export interface EtapaComTotal extends Etapa {
  total: number;
}

/** Etapas na ordem do Kanban e a versão da lista (pipeline_etapas_versao), lidas no mesmo comando (spec 0034, K-6).
 * O cliente devolve `versao` como veio em etapas_reordenar. null só se a empresa não tem etapa. */
export interface ListaEtapas {
  etapas: EtapaComTotal[];
  versao: string | null;
}

/** Fila de preparação da Triagem (spec 0018, decisão 12). */
export type StatusPreparacao = "pending" | "processing" | "completed" | "failed";
export type ResultadoPreparacao = "ok" | "sem_documento" | "regulamento_nao_informado_pela_fonte";

/** Licitação no pipeline, com os campos da licitação que o Kanban mostra. */
export interface ItemPipeline {
  licitacao_id: number;
  etapa_id: number;
  motivo: string | null;
  atualizada_em: string;
  atualizada_por: string;
  licitacao: Record<string, unknown> | null;
  /** Tarefas da lei que não puderam ser criadas quando o regulamento chegou (private.pipeline_tarefas_pendencias). */
  tarefas_pendencia?: { motivo: string; erro: string | null; em: string } | null;
  /** Tarefas da empresa nesta licitação em aberta/em_andamento (tarefas_equipe); a lista fica na api-tarefas. */
  tarefas_abertas?: number;
  /** Preparação da Triagem (fila): pending/processing = "análise em preparação"; completed com resultado; failed. */
  preparacao?: {
    status: StatusPreparacao;
    resultado: ResultadoPreparacao | null;
    erro: string | null;
    atualizado_em: string;
  } | null;
}

export interface EventoHistorico {
  id: number;
  licitacao_id: number;
  etapa_de: number | null;
  etapa_para: number | null;
  nome_de: string | null;
  nome_para: string | null;
  motivo: string | null;
  user_id: string;
  em: string;
}

export const ACOES_ADMIN = new Set(["etapa_criar", "etapa_atualizar", "etapas_reordenar", "etapa_excluir", "etapa_tarefas_salvar"]);

/** Tarefa do modelo de uma etapa (spec 0018): do catálogo 14.133 ou escrita pela empresa. */
export interface ModeloTarefa {
  id: number;
  etapa_id: number;
  origem: "catalogo" | "empresa";
  tarefa_codigo: string | null;
  chave: string | null;
  titulo: string | null;
  descricao: string | null;
  prazo_horas: number | null;
  ordem: number;
  ativo: boolean;
  /** Resumo do catálogo (só origem = catalogo). */
  catalogo: { titulo: string; fase_codigo: string; natureza: string; prazo_unidade: string; ativo: boolean } | null;
}

/** Tarefa ativa do catálogo 14.133, para escolher no modelo da etapa (agrupada por fase, com base legal). */
export interface TarefaCatalogo {
  codigo: string;
  fase_codigo: string;
  fase_nome: string | null;
  fase_ordem: number | null;
  parent_codigo: string | null;
  ordem: number;
  titulo: string;
  natureza: string;
  ator: string;
  prazo_unidade: string;
  /** "art. 165 (§ 1º, I); ..." a partir de tarefas_catalogo_base_legal; null se não houver. */
  base_legal: string | null;
}

/** Item da lista completa de etapa_tarefas_salvar. */
export type ItemModelo =
  | { origem: "catalogo"; tarefa_codigo: string }
  | { origem: "empresa"; chave: string | null; titulo: string; descricao: string | null; prazo_horas: number | null };

export type Acao =
  | { action: "etapas_listar" }
  | { action: "pipeline_listar"; etapa_id: number | null }
  | { action: "pipeline_estado"; licitacao_ids: number[] }
  | { action: "pipeline_adicionar"; licitacao_ids: number[] }
  | { action: "pipeline_mover"; licitacao_ids: number[]; etapa_id: number; motivo: string | null }
  | { action: "pipeline_remover"; licitacao_ids: number[] }
  | { action: "pipeline_historico"; licitacao_id: number }
  | { action: "etapa_criar"; nome: string; fase: Fase; desfecho: Desfecho | null; exige_motivo: boolean }
  | {
    action: "etapa_atualizar";
    id: number;
    nome?: string;
    fase?: Fase;
    desfecho?: Desfecho | null;
    exige_motivo?: boolean;
  }
  | { action: "etapas_reordenar"; ids: number[]; versao: string }
  | { action: "etapa_excluir"; id: number; mover_para: number | null }
  | { action: "etapa_tarefas_listar"; etapa_id: number }
  | { action: "catalogo_listar" }
  | { action: "etapa_tarefas_salvar"; etapa_id: number; tarefas: ItemModelo[] }
  | { action: "tarefas_reaplicar"; licitacao_id: number };
