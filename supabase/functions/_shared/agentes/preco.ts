import { REGRA_VERSAO, type Achado, type ResultadoAgente } from "./tipos.ts";

export type NaturezaObjeto = "bens_servicos_gerais" | "obras_servicos_engenharia";
/** null: nenhum dado oficial gravado diz a natureza da contratação. Não se presume uma. */
export type NaturezaContratacao = NaturezaObjeto | null;
export type Faixa =
  | "sem_referencia"
  | "acima_do_estimado"
  | "normal"
  | "garantia_adicional"
  | "indicio_inexequibilidade"
  | "inexequivel_presumida"
  | "natureza_nao_verificada";

export function classificarExequibilidade(
  precoCentavos: number,
  estimadoCentavos: number | null,
  natureza: NaturezaContratacao,
): Faixa {
  const e = estimadoCentavos;
  if (e === null || e <= 0) return "sem_referencia";
  // Acima do estimado não depende da natureza; os limites inferiores (50%, 75%, 85%) dependem.
  if (precoCentavos > e) return "acima_do_estimado";
  if (natureza === null) return "natureza_nao_verificada";
  if (natureza === "obras_servicos_engenharia") {
    if (precoCentavos * 100 < e * 75) return "inexequivel_presumida";
    if (precoCentavos * 100 < e * 85) return "garantia_adicional";
    return "normal";
  }
  if (precoCentavos * 100 < e * 50) return "indicio_inexequibilidade";
  return "normal";
}

export interface AmostraPreco {
  id_compra_item: string;
  preco_centavos: number;
  unidade: string | null;
}

export interface ReferenciaPreco {
  situacao: "ok" | "amostra_insuficiente" | "referencia_ausente";
  /** Só em referencia_ausente. */
  motivo?: string;
  n: number;
  descartadas: number;
  mediana_centavos: number | null;
  min_centavos: number | null;
  max_centavos: number | null;
  /** Amostras usadas no cálculo (mesma unidade, preço > 0), na ordem recebida. */
  amostras: AmostraPreco[];
}

export const MIN_AMOSTRAS = 5;
/** Amostra lida de precos_praticados_itens: as LIMITE_AMOSTRAS homologações mais recentes dos últimos JANELA_MESES. */
export const LIMITE_AMOSTRAS = 200;
export const JANELA_MESES = 24;
export const MOTIVO_SEM_UNIDADE = "unidade do item não informada";

function unidadeNorm(u: string | null): string | null {
  if (u === null) return null;
  const t = u.trim().toUpperCase();
  return t.length === 0 ? null : t;
}

function mediana(valores: number[]): number {
  const s = [...valores].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  const a = s[n / 2 - 1];
  const b = s[n / 2];
  return Math.floor((a + b) / 2 + 0.5);
}

export function referenciaPraticada(amostras: AmostraPreco[], unidade: string | null): ReferenciaPreco {
  const alvo = unidadeNorm(unidade);
  // Sem unidade no item não há como comparar UN com KIT ou CAIXA: nenhuma amostra vale.
  if (alvo === null) {
    return {
      situacao: "referencia_ausente",
      motivo: MOTIVO_SEM_UNIDADE,
      n: 0,
      descartadas: amostras.length,
      mediana_centavos: null,
      min_centavos: null,
      max_centavos: null,
      amostras: [],
    };
  }
  const mantidas: AmostraPreco[] = [];
  let descartadas = 0;
  for (const amostra of amostras) {
    const uni = unidadeNorm(amostra.unidade);
    if (uni !== alvo || amostra.preco_centavos <= 0) {
      descartadas++;
      continue;
    }
    mantidas.push(amostra);
  }
  if (mantidas.length < MIN_AMOSTRAS) {
    return {
      situacao: "amostra_insuficiente",
      n: mantidas.length,
      descartadas,
      mediana_centavos: null,
      min_centavos: null,
      max_centavos: null,
      amostras: mantidas,
    };
  }
  const precos = mantidas.map((a) => a.preco_centavos);
  return {
    situacao: "ok",
    n: mantidas.length,
    descartadas,
    mediana_centavos: mediana(precos),
    min_centavos: Math.min(...precos),
    max_centavos: Math.max(...precos),
    amostras: mantidas,
  };
}

export function pisoTenantCentavos(precoTabelaCentavos: number, descontoMaxPct: number): number {
  return Math.floor(precoTabelaCentavos * (100 - descontoMaxPct) / 100 + 0.5);
}

export interface ItemPreco {
  numero_item: number;
  unidade: string | null;
  estimado_centavos: number | null;
  amostras: AmostraPreco[];
  piso_centavos: number | null;
}

export interface PropostaItem {
  numero_item: number;
  preco_unitario_centavos: number;
  custo_zero?: boolean;
}

const FAIXA_ACHADO: Partial<Record<Faixa, { codigo: string; severidade: Achado["severidade"] }>> = {
  indicio_inexequibilidade: { codigo: "preco.indicio_inexequibilidade", severidade: "atencao" },
  inexequivel_presumida: { codigo: "preco.inexequivel_presumida", severidade: "critico" },
  garantia_adicional: { codigo: "preco.garantia_adicional", severidade: "atencao" },
  acima_do_estimado: { codigo: "preco.acima_do_estimado", severidade: "critico" },
};

const DETALHE_INDICIO =
  "Preço abaixo de 50% do estimado. Não é desclassificação automática: prepare a demonstração de exequibilidade (art. 59, § 2º).";
const DETALHE_NATUREZA =
  "Natureza da contratação não verificada; exequibilidade não classificada. Confira no edital se é obra/serviço de engenharia ou bem/serviço comum (art. 59, §§ 3º e 4º).";
const DETALHE_CUSTO_ZERO =
  "Item com custo zero. Justifique: bem próprio, custo em outra rubrica ou renúncia à remuneração.";

export function agentePreco(entrada: {
  natureza: NaturezaContratacao;
  itens: ItemPreco[];
  proposta: PropostaItem[] | null;
}): ResultadoAgente {
  if (entrada.proposta === null) {
    return { agente: "preco", situacao: "sem_proposta", achados: [], regra_versao: REGRA_VERSAO };
  }
  const porNumero = new Map(entrada.itens.map((item) => [item.numero_item, item]));
  const achados: Achado[] = [];
  let temReferencia = false;
  const naoClassificados: number[] = [];
  for (const proposta of entrada.proposta) {
    const item = porNumero.get(proposta.numero_item);
    if (!item) continue;
    const faixa = classificarExequibilidade(proposta.preco_unitario_centavos, item.estimado_centavos, entrada.natureza);
    if (faixa === "natureza_nao_verificada") naoClassificados.push(item.numero_item);
    const faixaAchado = FAIXA_ACHADO[faixa];
    if (faixaAchado && item.estimado_centavos !== null && item.estimado_centavos > 0) {
      achados.push({
        codigo: faixaAchado.codigo,
        natureza: "analise",
        metodo: "regra",
        severidade: faixaAchado.severidade,
        titulo: faixaAchado.codigo,
        detalhe: faixaAchado.codigo === "preco.indicio_inexequibilidade" ? DETALHE_INDICIO : faixaAchado.codigo,
        dados: {
          numero_item: item.numero_item,
          preco_centavos: proposta.preco_unitario_centavos,
          estimado_centavos: item.estimado_centavos,
          percentual_do_estimado: Math.floor(proposta.preco_unitario_centavos * 100 / item.estimado_centavos),
        },
        fontes: [{ tipo: "calculo", regra: `exequibilidade_${entrada.natureza}`, versao: REGRA_VERSAO }],
      });
    }
    if (proposta.custo_zero === true) {
      achados.push({
        codigo: "preco.custo_zero",
        natureza: "fato",
        metodo: "cliente",
        severidade: "atencao",
        titulo: "preco.custo_zero",
        detalhe: DETALHE_CUSTO_ZERO,
        dados: { numero_item: item.numero_item },
        fontes: [{ tipo: "cliente", campo: "proposta.custo_zero" }],
      });
    }
    if (item.piso_centavos !== null && proposta.preco_unitario_centavos < item.piso_centavos) {
      achados.push({
        codigo: "preco.abaixo_do_piso",
        natureza: "analise",
        metodo: "regra",
        severidade: "critico",
        titulo: "preco.abaixo_do_piso",
        detalhe: "Preço abaixo do piso do cliente.",
        dados: { numero_item: item.numero_item },
        fontes: [{ tipo: "calculo", regra: "piso_tenant", versao: REGRA_VERSAO }],
      });
    }
    const ref = referenciaPraticada(item.amostras, item.unidade);
    if (ref.situacao === "ok") {
      temReferencia = true;
      achados.push({
        codigo: "preco.referencia_praticada",
        natureza: "analise",
        metodo: "regra",
        severidade: "info",
        titulo: "preco.referencia_praticada",
        detalhe:
          `Mediana dos preços homologados da mesma unidade, com amostra suficiente (até as ${LIMITE_AMOSTRAS} homologações mais recentes dos últimos ${JANELA_MESES} meses).`,
        // Todas as amostras do cálculo, sem cortar: no máximo LIMITE_AMOSTRAS por item.
        dados: {
          numero_item: item.numero_item,
          n: ref.n,
          mediana_centavos: ref.mediana_centavos,
          min_centavos: ref.min_centavos,
          max_centavos: ref.max_centavos,
          amostras: ref.amostras.map((a) => ({ id: a.id_compra_item, preco_centavos: a.preco_centavos, unidade: a.unidade })),
        },
        fontes: ref.amostras.map((a) => ({ tipo: "registro" as const, tabela: "precos_praticados_itens", id: a.id_compra_item })),
      });
    }
    if (item.estimado_centavos !== null && item.estimado_centavos > 0) temReferencia = true;
  }
  if (naoClassificados.length > 0) {
    achados.push({
      codigo: "preco.natureza_nao_verificada",
      natureza: "analise",
      metodo: "regra",
      severidade: "atencao",
      titulo: "preco.natureza_nao_verificada",
      detalhe: DETALHE_NATUREZA,
      dados: { itens_nao_classificados: naoClassificados },
      fontes: [{ tipo: "calculo", regra: "exequibilidade_natureza_desconhecida", versao: REGRA_VERSAO }],
    });
  }
  const situacao = temReferencia ? "ok" : "sem_referencia";
  return { agente: "preco", situacao, achados, regra_versao: REGRA_VERSAO };
}
