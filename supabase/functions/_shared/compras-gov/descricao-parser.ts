/** Extrai pares chave/valor de descricaoItem CATMAT (ex.: "TIPO: X, MATERIAL: Y"). */
export function parseDescricaoItemTaxonomias(descricao: string | null | undefined): Record<string, string> {
  if (!descricao?.trim()) return {};

  const taxonomias: Record<string, string> = {};
  const parts = descricao.split(/,\s*(?=[A-ZÀ-Ú][A-ZÀ-Ú0-9 /_-]{0,40}:)/u);

  for (const part of parts) {
    const match = part.match(/^([^:,]+):\s*(.+)$/u);
    if (!match) continue;
    const chave = match[1].trim().toUpperCase();
    const valor = match[2].trim();
    if (chave && valor) taxonomias[chave] = valor;
  }

  return taxonomias;
}

/** Atributo de taxonomia de um item CATMAT, na ordem em que aparece na descrição. */
export interface AtributoItem {
  ordem: number;
  atributo: string;
  valor: string;
}

// Mesmo separador de public.catmat_atributos_da_descricao (migration 20261004005000): vírgula seguida de
// CHAVE EM MAIÚSCULAS (até 80 caracteres, sem vírgula nem dois-pontos) e dois-pontos. "PESO: 2,0 KG" não quebra.
const SEPARADOR_ATRIBUTO = /,\s*(?=[A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9][A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9 /().ºª-]{0,80}:)/u;

/**
 * Quebra a descrição CATMAT em nome (cabeça, âncora do casamento) e atributos ordenados.
 * "ANILHA, MATERIAL: FERRO , COR: PRETA" -> { nome: "ANILHA", atributos: [MATERIAL=FERRO, COR=PRETA] }.
 * Conferido contra o endpoint 7_consultarMaterialCaracteristicas: 3.722 de 3.726 pares iguais (660 itens).
 */
export function quebrarDescricaoItem(descricao: string | null | undefined): { nome: string | null; atributos: AtributoItem[] } {
  const texto = (descricao ?? "").trim();
  if (!texto) return { nome: null, atributos: [] };
  const partes = texto.split(SEPARADOR_ATRIBUTO);
  const nome = partes[0].trim().replace(/,+$/u, "").trim() || null;
  const atributos: AtributoItem[] = [];
  partes.slice(1).forEach((parte, i) => {
    const dp = parte.indexOf(":");
    if (dp < 0) return;
    const atributo = parte.slice(0, dp).replace(/\s+/gu, " ").trim();
    const valor = parte.slice(dp + 1).replace(/\s+/gu, " ").trim().replace(/,+$/u, "").trim();
    if (atributo) atributos.push({ ordem: i + 1, atributo, valor });
  });
  return { nome, atributos };
}
