/**
 * Motor de oportunidade do Sistema S, no formato do blueprint.
 * Não treina rede. Baseline é frequência histórica. Plano ausente é not_observed, nunca zero.
 * A materialidade usa a linha de equipamento permanente, não o orçamento total.
 */

export const MVP_ENTIDADES = ["sestsenat", "sesc"] as const;
export const HORIZONTES_DIAS = [30, 60, 90, 180] as const;
export const TARGET_INICIAL = 90;

export type PlanoObservado = "observado" | "not_observed";

export type NotaMaterialidade =
  | { status: "not_observed"; motivo: string }
  | { status: "nota"; nota: 1 | 2 | 3; razao: number; denominador: "equipamento_permanente" };

export type Sinal = "forte" | "moderado" | "fraco" | "abstencao";

/** Corte de 20% e 10% é a forma da nota de materialidade, aplicada só à linha permanente. */
export function notaMaterialidade(
  valorItem: number | null,
  dotacaoEquipamentoPermanente: number | null,
): NotaMaterialidade {
  if (dotacaoEquipamentoPermanente == null || !(dotacaoEquipamentoPermanente > 0)) {
    return {
      status: "not_observed",
      motivo: "linha de equipamento permanente ausente; orçamento total não entra no denominador",
    };
  }
  if (valorItem == null || !(valorItem >= 0)) {
    return { status: "not_observed", motivo: "valor do item ausente" };
  }
  const razao = valorItem / dotacaoEquipamentoPermanente;
  const nota: 1 | 2 | 3 = razao >= 0.2 ? 3 : razao >= 0.1 ? 2 : 1;
  return { status: "nota", nota, razao, denominador: "equipamento_permanente" };
}

export function estadoDoPlano(publicado: boolean | null): PlanoObservado {
  return publicado === true ? "observado" : "not_observed";
}

export type Corte = {
  entidade: string;
  regional: string;
  produto: string;
  cutoff: string;
};

export type EventoEdital = {
  entidade: string;
  regional: string;
  produto: string;
  publicadoEm: string;
};

/** 1 se algum edital aderente cai na janela (cutoff, cutoff+dias]. Datas YYYY-MM-DD. */
export function rotuloHorizonte(
  corte: Corte,
  eventos: readonly EventoEdital[],
  dias: number,
): 0 | 1 {
  const inicio = dataUtc(corte.cutoff);
  const fim = inicio + dias * 86_400_000;
  for (const evento of eventos) {
    if (evento.entidade !== corte.entidade) continue;
    if (evento.regional !== corte.regional) continue;
    if (evento.produto !== corte.produto) continue;
    const quando = dataUtc(evento.publicadoEm);
    if (quando > inicio && quando <= fim) return 1;
  }
  return 0;
}

export type Frequencia = { positivos: number; total: number };

/** Frequência histórica. Sem amostra, abstenção. Não é probabilidade de modelo. */
export function baselineFrequencia(freq: Frequencia): { sinal: Sinal; frequencia: number | null } {
  if (!(freq.total > 0) || freq.positivos < 0 || freq.positivos > freq.total) {
    return { sinal: "abstencao", frequencia: null };
  }
  const frequencia = freq.positivos / freq.total;
  const sinal: Sinal = frequencia >= 0.5 ? "forte" : frequencia >= 0.2 ? "moderado" : "fraco";
  return { sinal, frequencia };
}

export type WorkerParcial = {
  nome: "orcamentario" | "plano" | "recorrencia" | "produto" | "qualidade";
  sinal: Sinal;
};

export function fusao(workers: readonly WorkerParcial[]): Sinal {
  if (workers.length === 0 || workers.some((w) => w.sinal === "abstencao")) return "abstencao";
  if (workers.some((w) => w.sinal === "fraco")) return "fraco";
  if (workers.every((w) => w.sinal === "forte")) return "forte";
  return "moderado";
}

export function contratoMotor(): {
  mvp: readonly string[];
  target: string;
  rede: "nao_treinada";
  baseline: "frequencia_historica";
  disclaimer: string;
} {
  return {
    mvp: MVP_ENTIDADES,
    target: "Y_90 edital aderente à família do produto, na entidade e na regional, nos 90 dias após o corte",
    rede: "nao_treinada",
    baseline: "frequencia_historica",
    disclaimer: "Sinal forte, moderado ou fraco. Sem percentual de modelo até calibração. Plano ausente é not_observed.",
  };
}

function dataUtc(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
