import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { agenteJuridico, type Dispositivo } from "./juridico.ts";
import { agenteConcorrencia, type AmostraConcorrente } from "./concorrencia.ts";
import {
  calcularScoreAderencia,
  calcularScoreConcorrencia,
  calcularScoreRisco,
  calcularScoreViabilidade,
} from "./scores.ts";
import {
  REGRA_VERSAO_RECOMENDACAO,
  THRESHOLDS,
  type Decisao,
  type RecomendacaoLanceV4,
  type ResultadoAgente,
} from "./tipos.ts";

export interface EntradaRecomendacao {
  tenant_id: number;
  licitacao_id: number;
  numero_item: number;
  produto_id: number | null;
  solicitado_por: string; // uuid do usuário

  // Insumos dos agentes (já processados por api-agentes antes)
  edital: ResultadoAgente;
  preco: ResultadoAgente;
  dispositivos: Dispositivo[]; // da api-agentes (jurídico)
  amostras_concorrencia: AmostraConcorrente[]; // da tabela precos_praticados_itens
  piso_tenant_centavos: number; // não vira achado (política #2)
}

export async function recomendarV4(
  supabase: SupabaseClient,
  entrada: EntradaRecomendacao,
): Promise<{ recomendacao: RecomendacaoLanceV4; decisao_id: number }> {
  const geradoEm = new Date().toISOString();

  // ---------- 1. Executar agente jurídico (sinais → dispositivos) ----------
  const juridico = agenteJuridico({
    sinais: entrada.edital.achados,
    dispositivos: entrada.dispositivos,
  });

  // ---------- 2. Executar agente concorrência ----------
  const concorrencia = agenteConcorrencia({
    amostras: entrada.amostras_concorrencia,
    piso_tenant_centavos: entrada.piso_tenant_centavos,
  });

  // ---------- 3. Calcular os 4 SCOREs ----------
  const scoreAderencia = calcularScoreAderencia(entrada.edital, juridico);
  const scoreRisco = calcularScoreRisco(juridico, entrada.edital);
  const scoreViabilidade = calcularScoreViabilidade(entrada.preco);
  const scoreConcorrencia = calcularScoreConcorrencia(concorrencia);

  const scoreFinal = Math.round(
    ((scoreAderencia.score_total +
      scoreRisco.score_total +
      scoreViabilidade.score_total +
      scoreConcorrencia.score_total) / 4) * 1000,
  ) / 1000;

  // ---------- 4. Decisão baseada em thresholds ----------
  const motivos: string[] = [];
  const alertas: string[] = [];
  let decisao: Decisao = "disputar";

  // Regra 1: aderência insuficiente → nao_disputar
  if (scoreAderencia.score_total < THRESHOLDS.ADERENCIA_MIN) {
    decisao = "nao_disputar";
    motivos.push("aderencia_insuficiente");
  }

  // Regra 2: concorrência desfavorável → nao_disputar
  if (scoreConcorrencia.score_total < THRESHOLDS.CONCORRENCIA_MIN) {
    decisao = "nao_disputar";
    motivos.push("concorrencia_desfavoravel");
  }

  // Regra 3: risco alto → aguardar_aprovacao
  if (decisao === "disputar" && scoreRisco.score_total > THRESHOLDS.RISCO_MAX) {
    decisao = "aguardar_aprovacao";
    motivos.push("risco_desclassificacao_alto");
  }

  // Regra 4: viabilidade baixa → aguardar_aprovacao
  if (decisao === "disputar" && scoreViabilidade.score_total < THRESHOLDS.VIABILIDADE_MIN) {
    decisao = "aguardar_aprovacao";
    motivos.push("viabilidade_economica_insuficiente");
  }

  // ---------- 5. Alertas (só achados, SEM preço do cliente) ----------
  for (const r of [entrada.edital, juridico, entrada.preco, concorrencia]) {
    for (const a of r.achados) {
      if (a.severidade === "critico" || a.severidade === "atencao") {
        alertas.push(`[${r.agente}/${a.severidade}] ${a.titulo}: ${a.detalhe}`);
      }
    }
  }

  const recomendacao: RecomendacaoLanceV4 = {
    decisao,
    motivos,
    alertas,
    scores: {
      aderencia: scoreAderencia,
      risco: scoreRisco,
      viabilidade: scoreViabilidade,
      concorrencia: scoreConcorrencia,
      final: scoreFinal,
    },
    regra_versao: REGRA_VERSAO_RECOMENDACAO,
    gerado_em: geradoEm,
  };

  // ---------- 6. Persistir ----------
  const { data, error } = await supabase
    .from("recomendacao_decisoes")
    .insert({
      tenant_id: entrada.tenant_id,
      licitacao_id: entrada.licitacao_id,
      numero_item: entrada.numero_item,
      produto_id: entrada.produto_id,
      decisao,
      score_aderencia: scoreAderencia.score_total,
      score_risco: scoreRisco.score_total,
      score_viabilidade: scoreViabilidade.score_total,
      score_concorrencia: scoreConcorrencia.score_total,
      score_final: scoreFinal,
      motivos,
      alertas,
      detalhes: {
        aderencia: scoreAderencia.detalhes,
        risco: scoreRisco.detalhes,
        viabilidade: scoreViabilidade.detalhes,
        concorrencia: scoreConcorrencia.detalhes,
      },
      regra_versao: REGRA_VERSAO_RECOMENDACAO,
      solicitado_por: entrada.solicitado_por,
    })
    .select("id")
    .single();

  if (error) throw error;

  return { recomendacao, decisao_id: data.id };
}
