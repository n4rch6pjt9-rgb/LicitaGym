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

export const ACOES_ADMIN = new Set(["etapa_criar", "etapa_atualizar", "etapa_excluir"]);

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
  | { action: "etapa_excluir"; id: number; mover_para: number | null };
