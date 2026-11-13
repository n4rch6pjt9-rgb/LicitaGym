import { REGRA_VERSAO, type Achado, type Fonte, type ResultadoAgente } from "./tipos.ts";

const MARCAS_PREMIUM = new Set([
  "life fitness",
  "hammer strength",
  "technogym",
  "matrix",
  "precor",
  "cybex",
  "hoist",
  "star trac",
]);

export interface AmostraConcorrente {
  ni_fornecedor: string | null;
  nome_fornecedor: string | null;
  marca: string | null;
  preco_centavos: number;
}

export interface EntradaConcorrencia {
  codigo_item_catalogo?: number | null;
  codigo_pdm?: number | null;
  amostras: AmostraConcorrente[];
  /** Em centavos. Não aparece em achados (política #2). */
  piso_tenant_centavos: number;
}

/**
 * Agente de concorrência.
 * Responde: "Onde vivem? O que comem? Quanto vendem? O que vendem?"
 * sobre os vencedores homologados dos últimos 24 meses.
 */
export function agenteConcorrencia(entrada: EntradaConcorrencia): ResultadoAgente {
  const achados: Achado[] = [];
  const amostras = entrada.amostras.filter((a) => a.preco_centavos > 0);

  // Situação: sem amostras
  if (amostras.length === 0) {
    return {
      agente: "concorrencia",
      situacao: "sem_referencia",
      achados: [{
        codigo: "concorrencia.sem_amostras",
        natureza: "fato",
        metodo: "regra",
        severidade: "atencao",
        titulo: "Sem histórico de vencedores",
        detalhe: "Nenhuma amostra homologada nos últimos 24 meses para o item.",
        dados: {},
        fontes: [{ tipo: "calculo", regra: "agente_concorrencia", versao: REGRA_VERSAO }],
      }],
      regra_versao: REGRA_VERSAO,
    };
  }

  const fornecedores = new Set(amostras.map((a) => a.ni_fornecedor).filter(Boolean));
  const marcas = [...new Set(
    amostras.map((a) => (a.marca || "").trim()).filter(Boolean),
  )];
  const temSoPremium =
    marcas.length > 0 &&
    marcas.every((m) => MARCAS_PREMIUM.has(m.toLowerCase()));
  const precos = amostras.map((a) => a.preco_centavos);
  const ordenado = [...precos].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  const mediana = ordenado.length % 2 !== 0
    ? ordenado[meio]
    : Math.floor((ordenado[meio - 1] + ordenado[meio]) / 2 + 0.5);

  const fonte: Fonte = { tipo: "calculo", regra: "agente_concorrencia", versao: REGRA_VERSAO };

  // Achado 1: concentração de mercado
  if (fornecedores.size <= 2) {
    achados.push({
      codigo: "concorrencia.concentracao_alta",
      natureza: "analise",
      metodo: "regra",
      severidade: "critico",
      titulo: "Mercado concentrado",
      detalhe: `Apenas ${fornecedores.size} fornecedor(es) venceram nos últimos 24 meses. Risco de oligopólio/cartel.`,
      dados: { num_concorrentes: fornecedores.size },
      fontes: [fonte],
    });
  }

  // Achado 2: só marcas premium (barreira de entrada)
  if (temSoPremium) {
    achados.push({
      codigo: "concorrencia.somente_premium",
      natureza: "analise",
      metodo: "regra",
      severidade: "atencao",
      titulo: "Apenas marcas premium no histórico",
      detalhe: `Marcas vencedoras: ${marcas.join(", ")}. Especificação pode estar direcionada.`,
      dados: { marcas },
      fontes: [fonte],
    });
  }

  // Achado 3: resumo do mercado (informativo, não expõe preço do tenant)
  achados.push({
    codigo: "concorrencia.resumo_mercado",
    natureza: "fato",
    metodo: "regra",
    severidade: "info",
    titulo: "Resumo de mercado (24 meses)",
    detalhe: `${fornecedores.size} fornecedores, ${marcas.length} marcas, ${amostras.length} amostras.`,
    dados: {
      num_concorrentes: fornecedores.size,
      num_marcas: marcas.length,
      marcas,
      num_amostras: amostras.length,
      // Mediana em centavos é informação pública do mercado (não do tenant)
      mediana_mercado_centavos: mediana,
      min_mercado_centavos: Math.min(...precos),
      max_mercado_centavos: Math.max(...precos),
    },
    fontes: [fonte],
  });

  return {
    agente: "concorrencia",
    situacao: "ok",
    achados,
    regra_versao: REGRA_VERSAO,
  };
}
