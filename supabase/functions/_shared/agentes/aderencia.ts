export type Veredito = "atende" | "supera" | "nao_atende" | "nao_comprovado" | "ausente" | "ambiguo";
export type AderenciaConjunto = Veredito | "parcial";
export type Sentido = "minimo" | "maximo" | "igual" | "texto";

export interface AtributoComparado {
  atributo: string;
  eliminatorio: boolean;
  veredito: Veredito;
}

export function compararAtributo(
  sentido: Sentido,
  exigidoNum: number | null,
  produtoNum: number | null,
  exigidoTexto: string | null = null,
  produtoTexto: string | null = null,
): Veredito {
  if (sentido === "texto") {
    const exigido = exigidoTexto?.trim() || null;
    const produto = produtoTexto?.trim() || null;
    if (!exigido && !produto) return "ausente";
    if (!exigido) return "ausente";
    if (!produto) return "nao_comprovado";
    if (exigido.toLowerCase() === produto.toLowerCase()) return "atende";
    return "ambiguo";
  }
  if (exigidoNum === null && produtoNum === null) return "ausente";
  if (exigidoNum === null) return "ausente";
  if (produtoNum === null) return "nao_comprovado";
  if (sentido === "minimo") {
    if (produtoNum > exigidoNum) return "supera";
    if (produtoNum === exigidoNum) return "atende";
    return "nao_atende";
  }
  if (sentido === "maximo") {
    if (produtoNum < exigidoNum) return "supera";
    if (produtoNum === exigidoNum) return "atende";
    return "nao_atende";
  }
  return produtoNum === exigidoNum ? "atende" : "nao_atende";
}

export function classificarAderencia(atributos: AtributoComparado[]): AderenciaConjunto {
  const falha = atributos.filter((a) => a.veredito === "nao_atende").map((a) => a.atributo);
  const lacuna = atributos.filter((a) => a.veredito === "nao_comprovado").map((a) => a.atributo);
  const eliminatorios = new Set(atributos.filter((a) => a.eliminatorio).map((a) => a.atributo));
  if (falha.some((nome) => eliminatorios.has(nome))) return "nao_atende";
  if (lacuna.some((nome) => eliminatorios.has(nome))) return "nao_comprovado";
  const conta = (v: Veredito) => atributos.filter((a) => a.veredito === v).length;
  if (conta("nao_atende") > 0) return "parcial";
  if (conta("ambiguo") > 0) return "ambiguo";
  if (conta("nao_comprovado") > 0) return "nao_comprovado";
  if (conta("supera") > 0 && conta("atende") === 0) return "supera";
  if (conta("atende") + conta("supera") > 0) return "atende";
  return "ausente";
}
