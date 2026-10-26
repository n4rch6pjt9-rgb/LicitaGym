export const REGRA_VERSAO = "2026-10-26.2";

export type Agente = "edital" | "preco" | "juridico" | "concorrencia" | "recomendacao";
export type Severidade = "info" | "atencao" | "critico";
export type Natureza = "fato" | "analise" | "inferencia";
export type Metodo = "regra" | "modelo" | "cliente";

// ============================================================
// Spec 0039: contrato de recomendação v4
// ============================================================
export type Decisao = "disputar" | "aguardar_aprovacao" | "nao_disputar";

export interface ScoreComponentes {
  [componente: string]: number;
}

export interface Score {
  score_total: number; // 0.00 a 1.00
  componentes: ScoreComponentes;
  peso: ScoreComponentes;
  detalhes?: Record<string, unknown>;
}

export type ScoreAderencia = Score;
export type ScoreRisco = Score;
export type ScoreViabilidade = Score;
export interface ScoreConcorrencia extends Score {
  detalhes: {
    num_concorrentes: number;
    marcas: string[];
    mediana_historica: number | null;
    razao_preco: number | null;
    tem_so_premium: boolean;
  };
}

export interface RecomendacaoLanceV4 {
  decisao: Decisao;
  motivos: string[];
  alertas: string[];
  scores: {
    aderencia: ScoreAderencia;
    risco: ScoreRisco;
    viabilidade: ScoreViabilidade;
    concorrencia: ScoreConcorrencia;
    final: number;
  };
  regra_versao: string;
  gerado_em: string;
}

export const REGRA_VERSAO_RECOMENDACAO = "2026-10-26.1";

export const THRESHOLDS = {
  ADERENCIA_MIN: 0.60,
  RISCO_MAX: 0.70,
  VIABILIDADE_MIN: 0.50,
  CONCORRENCIA_MIN: 0.40,
} as const;

export type Fonte =
  | {
    tipo: "chunk";
    chunk_id: number;
    documento_id: number;
    pagina: number | null;
    trecho: string;
    /** Spec 0038 (K-4): item/cláusula no início da frase do trecho ("8.4.2"); null sem numeração reconhecida. */
    item?: string | null;
    /** Spec 0038 (K-4): frases inteiras em volta do trecho, até ~300 caracteres, sem palavra cortada. */
    trecho_limpo?: string;
  }
  | { tipo: "registro"; tabela: string; id: string }
  | { tipo: "dispositivo"; norma: string; artigo: number; conferido_oficial: boolean }
  | { tipo: "calculo"; regra: string; versao: string }
  | { tipo: "cliente"; campo: string };

export interface Achado {
  codigo: string;
  natureza: Natureza;
  metodo: Metodo;
  severidade: Severidade;
  titulo: string;
  detalhe: string;
  dados: Record<string, unknown>;
  fontes: Fonte[];
}

export type Situacao = "ok" | "sem_documento" | "sem_referencia" | "sem_proposta";

export interface ResultadoAgente {
  agente: Agente;
  situacao: Situacao;
  achados: Achado[];
  regra_versao: string;
}
