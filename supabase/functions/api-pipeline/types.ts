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
  /** Preparação da Triagem (fila): pending/processing = "análise em preparação"; completed com resultado; failed. */
  preparacao?: { status: string; resultado: string | null; erro: string | null; atualizado_em: string } | null;
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

export const ACOES_ADMIN = new Set(["etapa_criar", "etapa_atualizar", "etapa_excluir", "etapa_tarefas_salvar"]);

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
  | { action: "etapa_criar"; nome: string; fase: Fase; ordem: number | null; desfecho: Desfecho | null; exige_motivo: boolean }
  | {
    action: "etapa_atualizar";
    id: number;
    nome?: string;
    fase?: Fase;
    ordem?: number;
    desfecho?: Desfecho | null;
    exige_motivo?: boolean;
  }
  | { action: "etapa_excluir"; id: number; mover_para: number | null }
  | { action: "etapa_tarefas_listar"; etapa_id: number }
  | { action: "etapa_tarefas_salvar"; etapa_id: number; tarefas: ItemModelo[] }
  | { action: "tarefas_reaplicar"; licitacao_id: number };
