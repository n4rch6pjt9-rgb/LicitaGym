/**
 * Histórico do PCA por órgão e ano (visao=historico): normalização e agregação, sem acesso a banco.
 * Planejado, execução e prazo são das classes pedidas; compra observada é do escopo inteiro (categoria do objeto da
 * licitação, sem classe CATMAT nos itens), por isso os campos compras_escopo_* e valor_escopo_*.
 */

export function numeroOuNulo(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface LinhaHistorico {
  orgao_cnpj: string;
  orgao_nome: string | null;
  uf: string;
  ano_exercicio: number;
  classes_presentes: string[];
  planos: number;
  itens: number;
  itens_sem_valor: number;
  valor_planejado: number | null;
  unidades: string[];
  compras_escopo_observadas: number;
  valor_escopo_observado: number | null;
  execucoes_confirmadas: number;
  lag_medio_dias: number | null;
}

export function linhaHistorico(raw: Record<string, unknown>): LinhaHistorico | null {
  const ano = numeroOuNulo(raw.ano_exercicio);
  if (typeof raw.orgao_cnpj !== "string" || ano == null) return null;
  const textos = (v: unknown) =>
    Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
  const unidades = textos(raw.unidades);
  return {
    orgao_cnpj: raw.orgao_cnpj,
    orgao_nome: typeof raw.orgao_nome === "string" ? raw.orgao_nome : null,
    uf: typeof raw.uf === "string" && raw.uf.length > 0 ? raw.uf : "sem_uf",
    ano_exercicio: ano,
    classes_presentes: textos(raw.classes_presentes),
    planos: numeroOuNulo(raw.planos) ?? 0,
    itens: numeroOuNulo(raw.itens) ?? 0,
    itens_sem_valor: numeroOuNulo(raw.itens_sem_valor) ?? 0,
    valor_planejado: numeroOuNulo(raw.valor_planejado),
    unidades,
    compras_escopo_observadas: numeroOuNulo(raw.compras_escopo_observadas) ?? 0,
    valor_escopo_observado: numeroOuNulo(raw.valor_escopo_observado),
    execucoes_confirmadas: numeroOuNulo(raw.execucoes_confirmadas) ?? 0,
    lag_medio_dias: numeroOuNulo(raw.lag_medio_dias),
  };
}

export function somaOuAusente(valores: Array<number | null>): number | null {
  const presentes = valores.filter((v): v is number => v != null);
  if (presentes.length === 0) return null;
  return presentes.reduce((a, b) => a + b, 0);
}

export function montarHistorico(linhas: LinhaHistorico[], anoAberto: number) {
  const porOrgao = new Map<string, LinhaHistorico[]>();
  for (const linha of linhas) {
    const grupo = porOrgao.get(linha.orgao_cnpj) ?? [];
    grupo.push(linha);
    porOrgao.set(linha.orgao_cnpj, grupo);
  }

  const orgaos = [...porOrgao.values()].map((grupo) => {
    const primeira = grupo[0];
    const anos = [...grupo].sort((a, b) => a.ano_exercicio - b.ano_exercicio).map((linha) => ({
      ano: linha.ano_exercicio,
      exercicio_aberto: linha.ano_exercicio >= anoAberto,
      classes_presentes: linha.classes_presentes,
      planos: linha.planos,
      itens: linha.itens,
      itens_sem_valor: linha.itens_sem_valor,
      valor_planejado: linha.valor_planejado,
      compras_escopo_observadas: linha.compras_escopo_observadas,
      valor_escopo_observado: linha.valor_escopo_observado,
      execucoes_confirmadas: linha.execucoes_confirmadas,
      lag_medio_dias: linha.lag_medio_dias,
      unidades: linha.unidades,
    }));
    const fechados = grupo.filter((linha) => linha.ano_exercicio < anoAberto);
    const lags = fechados.map((linha) => linha.lag_medio_dias);
    return {
      cnpj: primeira.orgao_cnpj,
      nome: primeira.orgao_nome,
      uf: primeira.uf,
      valor_planejado: somaOuAusente(grupo.map((linha) => linha.valor_planejado)),
      compras_escopo_observadas: grupo.reduce((n, linha) => n + linha.compras_escopo_observadas, 0),
      valor_escopo_observado: somaOuAusente(grupo.map((linha) => linha.valor_escopo_observado)),
      execucoes_confirmadas: fechados.reduce((n, linha) => n + linha.execucoes_confirmadas, 0),
      lag_medio_dias: somaOuAusente(lags) == null
        ? null
        : (somaOuAusente(lags) as number) / lags.filter((v) => v != null).length,
      anos,
    };
  }).sort((a, b) => (b.valor_planejado ?? -1) - (a.valor_planejado ?? -1));

  const porUf = new Map<string, { uf: string; orgaos: number; valores: Array<number | null>; compras: number; execucoes: number }>();
  for (const orgao of orgaos) {
    const atual = porUf.get(orgao.uf) ?? {
      uf: orgao.uf, orgaos: 0, valores: [], compras: 0, execucoes: 0,
    };
    atual.orgaos += 1;
    atual.valores.push(orgao.valor_planejado);
    atual.compras += orgao.compras_escopo_observadas;
    atual.execucoes += orgao.execucoes_confirmadas;
    porUf.set(orgao.uf, atual);
  }

  return {
    por_uf: [...porUf.values()]
      .map((uf) => ({
        uf: uf.uf,
        orgaos: uf.orgaos,
        valor_planejado: somaOuAusente(uf.valores),
        compras_escopo_observadas: uf.compras,
        execucoes_confirmadas: uf.execucoes,
      }))
      .sort((a, b) => (b.valor_planejado ?? -1) - (a.valor_planejado ?? -1)),
    orgaos,
  };
}
