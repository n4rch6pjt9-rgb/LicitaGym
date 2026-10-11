/** Tipos da api-tarefas (#252, spec 0019): tarefas da equipe por licitação, em cima do catálogo 14.133. */

export const STATUS = ["aberta", "em_andamento", "concluida", "cancelada"] as const;
export type Status = (typeof STATUS)[number];

export type PrazoSituacao = "nao_calculado" | "definido_no_edital" | "sem_prazo_legal" | "imediato" | "manual" | "calculado";

/** bloqueio devolvido por tarefas_equipe_liberar (nada gravado). */
export type Bloqueio = "fora_do_pipeline" | "regulamento_nao_informado" | "regulamento_sem_catalogo";

/** Campos do catálogo lidos junto com a instância (não copiados para tarefas_equipe). */
export interface CatalogoResumo {
  titulo: string;
  descricao: string;
  fase_codigo: string;
  natureza: string;
  prazo_quantidade: number | null;
  prazo_unidade: string;
  prazo_sentido: string | null;
  prazo_evento: string | null;
}

export interface Tarefa {
  id: number;
  tenant_id: number;
  licitacao_id: number;
  origem: "catalogo" | "empresa";
  tarefa_codigo: string | null;
  titulo: string | null;
  descricao: string | null;
  liberada_por_fase: string | null;
  liberada_por_evento: string | null;
  /** true ou null ("condição não verificada"); false nunca existe. */
  condicao_verificada: boolean | null;
  contexto: Record<string, unknown>;
  prazo_situacao: PrazoSituacao;
  prazo_em: string | null;
  /** Quem informou o prazo manual, e quando. */
  prazo_informado_por: string | null;
  prazo_informado_em: string | null;
  status: Status;
  responsavel_papel: "admin" | "operacao";
  responsavel_user_id: string | null;
  criada_em: string;
  atualizada_em: string;
  concluida_em: string | null;
  catalogo: CatalogoResumo | null;
}

/** Linha da prévia (mesmo formato por fase ou por evento): tarefa liberada, com a condição avaliada (true ou null). */
export interface TarefaPrevia {
  codigo: string;
  fase_codigo: string;
  parent_codigo: string | null;
  titulo: string;
  natureza: string;
  prazo_quantidade: number | null;
  prazo_unidade: string;
  prazo_sentido: string | null;
  prazo_evento: string | null;
  aplicavel: boolean | null;
  /** "art. 165 (§ 1º, I); ..." ou null quando o catálogo não liga artigo. */
  base_legal: string | null;
}

export type Acao =
  | { action: "catalogo_liberadas"; licitacao_id: number; fase: string | null; evento: string | null }
  | { action: "tarefas_liberar"; licitacao_id: number; fase: string | null; evento: string | null }
  | { action: "tarefas_listar"; licitacao_id: number | null; status: Status | null; minhas: boolean }
  | { action: "tarefa_atualizar"; id: number; status?: Status; prazo_em?: string }
  | { action: "tarefa_atribuir"; id: number; user_id: string | null };
