import type {
  ResultadoAgente,
  ScoreAderencia,
  ScoreConcorrencia,
  ScoreRisco,
  ScoreViabilidade,
} from "./tipos.ts";

/** Extrai de achados de um agente os códigos com severidade. */
function achadosPorSeveridade(r: ResultadoAgente | null, sev: string): number {
  if (!r) return 0;
  return r.achados.filter((a) => a.severidade === sev).length;
}

function temAchado(r: ResultadoAgente | null, codigoPrefixo: string): boolean {
  if (!r) return false;
  return r.achados.some((a) => a.codigo.startsWith(codigoPrefixo));
}

// ---------- SCORE 1: Aderência (produto vs edital) ----------
// Leitura: sinais do agente_edital que o produto NÃO consegue cumprir
// geram achados do jurídico com severidade "atencao"/"critico".
export function calcularScoreAderencia(
  edital: ResultadoAgente | null,
  juridico: ResultadoAgente | null,
): ScoreAderencia {
  const criticos = achadosPorSeveridade(juridico, "critico");
  const atencao = achadosPorSeveridade(juridico, "atencao");
  const info = achadosPorSeveridade(juridico, "info");
  const totalAchados = criticos + atencao + info;

  // Componente 1: ausência de achados críticos/atenção = produto atende
  const pctAtendidos = totalAchados === 0
    ? 1.0
    : 1 - (criticos * 1.0 + atencao * 0.5) / Math.max(totalAchados, 1);

  // Componente 2: eliminatórios (binário) — "exigencia.marca_modelo" é eliminatório
  const temEliminatorio = temAchado(juridico, "juridico.exigencia_marca_modelo") ||
    temAchado(juridico, "juridico.exigencia_laudo_certificacao");
  const scoreEliminatorios = temEliminatorio ? 0.0 : 1.0;

  // Componente 3: valor agregado (inferido da ausência de alertas)
  const scoreValorAgregado = criticos === 0 && atencao === 0 ? 0.80 : 0.40;

  // Componente 4: contexto adequado (edital sem sinais fortes)
  const editalCriticos = achadosPorSeveridade(edital, "critico");
  const scoreContexto = editalCriticos === 0 ? 1.0 : 0.50;

  const peso = {
    pct_atendidos: 0.40,
    requisitos_eliminatorios: 0.30,
    valor_agregado: 0.15,
    contexto_uso: 0.15,
  };
  const total =
    pctAtendidos * peso.pct_atendidos +
    scoreEliminatorios * peso.requisitos_eliminatorios +
    scoreValorAgregado * peso.valor_agregado +
    scoreContexto * peso.contexto_uso;

  return {
    score_total: Math.round(total * 1000) / 1000,
    componentes: {
      pct_atendidos: pctAtendidos,
      requisitos_eliminatorios: scoreEliminatorios,
      valor_agregado: scoreValorAgregado,
      contexto_uso: scoreContexto,
    },
    peso,
    detalhes: { criticos, atencao, info },
  };
}

// ---------- SCORE 2: Risco de desclassificação ----------
export function calcularScoreRisco(
  juridico: ResultadoAgente | null,
  _edital?: ResultadoAgente | null,
): ScoreRisco {
  const juridicosCriticos = achadosPorSeveridade(juridico, "critico");
  const juridicosAtencao = achadosPorSeveridade(juridico, "atencao");

  // Componente 1: achados jurídicos críticos/atenção
  const scoreRequisitos = Math.min(
    juridicosCriticos * 0.40 + juridicosAtencao * 0.15,
    1.0,
  );

  // Componente 2: direcionamento velado (achado "concorrencia.somente_premium" é proxy)
  const scoreSpecConstrutiva = temAchado(juridico, "juridico.exigencia_marca_modelo") ? 0.70 : 0.20;

  // Componente 3: certificação exigida mas sem referência
  const scoreCertificacao = temAchado(juridico, "juridico.exigencia_laudo_certificacao") ? 0.60 : 0.10;

  // Componente 4: visita técnica (exigência burocrática forte)
  const scoreVisita = temAchado(juridico, "juridico.exigencia_visita_tecnica") ? 0.50 : 0.10;

  const peso = {
    achados_juridicos: 0.35,
    especificacoes_construtivas: 0.25,
    certificacao_ausente: 0.20,
    visita_tecnica: 0.20,
  };
  const total =
    scoreRequisitos * peso.achados_juridicos +
    scoreSpecConstrutiva * peso.especificacoes_construtivas +
    scoreCertificacao * peso.certificacao_ausente +
    scoreVisita * peso.visita_tecnica;

  return {
    score_total: Math.round(total * 1000) / 1000,
    componentes: {
      achados_juridicos: scoreRequisitos,
      especificacoes_construtivas: scoreSpecConstrutiva,
      certificacao_ausente: scoreCertificacao,
      visita_tecnica: scoreVisita,
    },
    peso,
  };
}

// ---------- SCORE 3: Viabilidade econômica ----------
// Usa diretamente os achados do agente_preco (que respeita política #2).
export function calcularScoreViabilidade(preco: ResultadoAgente | null): ScoreViabilidade {
  // Faixa de exequibilidade é o principal sinal
  const temInexequivel = temAchado(preco, "preco.inexequivel_presumida");
  const temIndicio = temAchado(preco, "preco.indicio_inexequibilidade");
  const temGarantia = temAchado(preco, "preco.garantia_adicional");
  const temAcima = temAchado(preco, "preco.acima_do_estimado");

  // Componente 1: faixa de exequibilidade
  const scoreFaixa = temInexequivel ? 0.00 :
    temIndicio ? 0.30 :
    temGarantia ? 0.60 :
    temAcima ? 0.40 :
    1.00;

  // Componente 2: referência disponível
  const temReferencia = preco?.situacao === "ok";
  const scoreReferencia = temReferencia ? 1.00 : 0.40;

  // Componente 3: amostra robusta
  const n = preco?.achados.find((a) => a.codigo === "preco.referencia_praticada")
    ?.dados.n as number | undefined;
  const scoreAmostra = (n && n >= 10) ? 1.00 :
    (n && n >= 5) ? 0.70 :
    0.30;

  const peso = {
    faixa_exequibilidade: 0.50,
    referencia_disponivel: 0.30,
    amostra_robusta: 0.20,
  };
  const total =
    scoreFaixa * peso.faixa_exequibilidade +
    scoreReferencia * peso.referencia_disponivel +
    scoreAmostra * peso.amostra_robusta;

  return {
    score_total: Math.round(total * 1000) / 1000,
    componentes: {
      faixa_exequibilidade: scoreFaixa,
      referencia_disponivel: scoreReferencia,
      amostra_robusta: scoreAmostra,
    },
    peso,
    detalhes: { n, temInexequivel, temIndicio, temGarantia, temAcima },
  };
}

// ---------- SCORE 4: Concorrência ----------
export function calcularScoreConcorrencia(
  concorrencia: ResultadoAgente | null,
): ScoreConcorrencia {
  const resumo = concorrencia?.achados.find(
    (a) => a.codigo === "concorrencia.resumo_mercado",
  );
  const concentracao = temAchado(concorrencia, "concorrencia.concentracao_alta");
  const soPremium = temAchado(concorrencia, "concorrencia.somente_premium");

  const numConcorrentes = (resumo?.dados.num_concorrentes as number) ?? 0;
  const marcasRaw = resumo?.dados.marcas;
  const marcas = Array.isArray(marcasRaw)
    ? marcasRaw.filter((m): m is string => typeof m === "string")
    : [];
  const medianaRaw = resumo?.dados.mediana_mercado_centavos;
  const medianaHistorica = typeof medianaRaw === "number" ? medianaRaw : null;

  // Componente 1: número de concorrentes
  const scoreNum = numConcorrentes <= 2 ? 0.30 :
    numConcorrentes <= 5 ? 0.70 : 1.00;

  // Componente 2: só premium
  const scorePremium = soPremium ? 0.30 : 0.80;

  // Componente 3: concentração (risco de cartel)
  const scoreConcentracao = concentracao ? 0.30 : 0.80;

  // Componente 4: profundidade da amostra
  const numAmostras = (resumo?.dados.num_amostras as number) ?? 0;
  const scoreProfundidade = numAmostras >= 20 ? 1.00 :
    numAmostras >= 10 ? 0.70 :
    numAmostras >= 5 ? 0.40 : 0.20;

  const peso = {
    numero_concorrentes: 0.25,
    concorrencia_premium: 0.25,
    concentracao_mercado: 0.25,
    profundidade_amostra: 0.25,
  };
  const total =
    scoreNum * peso.numero_concorrentes +
    scorePremium * peso.concorrencia_premium +
    scoreConcentracao * peso.concentracao_mercado +
    scoreProfundidade * peso.profundidade_amostra;

  return {
    score_total: Math.round(total * 1000) / 1000,
    componentes: {
      numero_concorrentes: scoreNum,
      concorrencia_premium: scorePremium,
      concentracao_mercado: scoreConcentracao,
      profundidade_amostra: scoreProfundidade,
    },
    peso,
    detalhes: {
      num_concorrentes: numConcorrentes,
      marcas,
      mediana_historica: medianaHistorica,
      razao_preco: null, // não expomos preço do tenant
      tem_so_premium: soPremium,
    },
  };
}
