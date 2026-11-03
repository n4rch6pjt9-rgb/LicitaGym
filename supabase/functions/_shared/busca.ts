/**
 * Sanitiza termo para busca literal.
 * Regras:
 * - Normaliza para Unicode NFC.
 * - Usa allowlist: caracteres que não sejam letras (\p{L}), números (\p{N}), espaços (\s) ou hífen (-) viram espaço.
 *   (remove curingas %, _, *, barras invertidas \, aspas, vírgulas, parênteses, etc).
 * - Colapsa espaços consecutivos.
 * - Trunca em no máximo 200 caracteres.
 * - Se ficar vazio, retorna undefined (ignora o filtro).
 */
export function sanitizeSearchTerm(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const nfc = val.normalize("NFC");
  const filtered = nfc.replace(/[^\p{L}\p{N}\s-]/gu, " ");
  const collapsed = filtered.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  const truncated = collapsed.slice(0, 200).trim();
  return truncated.length > 0 ? truncated : undefined;
}
