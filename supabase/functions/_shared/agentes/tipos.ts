 chore/higiene-contexto-e-pipeline
export const REGRA_VERSAO = "2026-10-20.1";

export const REGRA_VERSAO = "2026-10-21.1";
 main

export type Agente = "edital" | "preco" | "juridico";
export type Severidade = "info" | "atencao" | "critico";
export type Natureza = "fato" | "analise" | "inferencia";
export type Metodo = "regra" | "modelo" | "cliente";

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
