/** Colunas GENERATED ALWAYS de public.entidades (202609180002_entidades.sql): nunca entram no upsert. */
export const COLUNAS_GERADAS_ENTIDADES = ["cnpj_normalizado"] as const;

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
