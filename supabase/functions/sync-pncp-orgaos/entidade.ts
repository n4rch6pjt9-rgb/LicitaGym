/**
 * Linha do upsert em public.entidades. cnpj_normalizado fica de fora: o banco calcula a partir de cnpj, e enviar
 * a coluna gerada faz o PostgREST responder 400 (#321).
 */
export function linhaEntidade(cnpj: string): Record<string, unknown> {
  return {
    codigo_pncp: cnpj,
    cnpj: cnpj,
    tipo: "orgao",
  };
}
