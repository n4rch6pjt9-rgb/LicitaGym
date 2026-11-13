export type DecisaoParticipacao = "go" | "go_condicionado" | "no_go" | "monitorar";

export interface Recomendacao {
  decisao: DecisaoParticipacao;
  motivos: string[];
}

/**
 * Recomendação explicável, sem pontuação. A decisão humana pode divergir:
 * quem grava a decisão é a revisão, não esta função.
 */
export function recomendarParticipacao(entrada: {
  eliminatorio_falhou: boolean;
  lacuna_eliminatoria: boolean;
  abaixo_do_piso: boolean;
  prazo_viavel: boolean;
  documentacao_ok: boolean;
  edital_aberto: boolean;
}): Recomendacao {
  if (!entrada.edital_aberto) {
    return { decisao: "monitorar", motivos: ["Não há oportunidade acionável com prazo de propostas aberto."] };
  }
  const motivos: string[] = [];
  if (entrada.eliminatorio_falhou) motivos.push("Requisito eliminatório não atendido.");
  if (entrada.abaixo_do_piso) motivos.push("Margem mínima do cliente não atingida.");
  if (motivos.length > 0) return { decisao: "no_go", motivos };
  if (entrada.lacuna_eliminatoria) motivos.push("Requisito eliminatório sem comprovação.");
  if (!entrada.prazo_viavel) motivos.push("Prazo logístico não verificado como viável.");
  if (!entrada.documentacao_ok) motivos.push("Documentação do cliente não verificada.");
  if (motivos.length > 0) return { decisao: "go_condicionado", motivos };
  return {
    decisao: "go",
    motivos: ["Nenhum requisito eliminatório falhou e as condições informadas estão cobertas."],
  };
}
