import type { AtributoItem } from "../_shared/compras-gov/descricao-parser.ts";

export type { AtributoItem };

/** Níveis da árvore CATMAT (plural = listagem de filhos; singular = nível de uma regra). */
export type NivelArvore = "grupos" | "classes" | "pdms" | "itens";
export type NivelRegra = "grupo" | "classe" | "pdm" | "item";

/** Nó da árvore, normalizado a partir do Compras.gov. */
export interface CatmatNo {
  nivel: NivelRegra;
  codigo: number;
  nome: string;
  ativo: boolean;
  codigo_grupo: number;
  codigo_classe: number | null;
  codigo_pdm: number | null;
  codigo_item: number | null;
  nome_grupo: string | null;
  nome_classe: string | null;
  nome_pdm: string | null;
  /** Só itens: cabeça da descrição (âncora do casamento) e atributos de taxonomia, na ordem da descrição. */
  nome_item?: string | null;
  atributos?: AtributoItem[];
}

/** Estado de um nó em relação ao catálogo da empresa. */
export type CatmatEstado = "incluido" | "excluido" | "herdado" | "excluido_herdado" | "nenhum";

export interface CatmatNoAnotado extends CatmatNo {
  estado: CatmatEstado;
  regra_id: number | null;
  origem_nivel: NivelRegra | null;
}

/** Linha de public.catalogo_empresa_catmat. */
export interface CatmatRegra {
  id: number;
  nivel: NivelRegra;
  codigo_grupo: number;
  codigo_classe: number | null;
  codigo_pdm: number | null;
  codigo_item: number | null;
  nome_snapshot: string;
  ancestrais_snapshot: Record<string, unknown>;
  incluido: boolean;
  observacao: string | null;
  chave: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * inclui: o padrão identifica o PDM no texto (catmat_pdm_palavras);
 * exclui: texto que casar o padrão não conta para o PDM (catmat_pdm_exclusoes; ex.: piso modular PP de concorrente).
 * São tabelas separadas: o id só é único dentro do tipo.
 */
export type TipoPalavra = "inclui" | "exclui";

export interface CatmatPalavra {
  id: number;
  codigo_pdm: number;
  padrao: string;
  ativo: boolean;
  tipo: TipoPalavra;
}

export type ActionParams =
  | { action: "arvore"; nivel: NivelArvore; codigo: number; incluir_inativos: boolean; refresh: boolean }
  | { action: "catalogo_listar" }
  | {
    action: "catalogo_salvar";
    nivel: NivelRegra;
    codigo_grupo: number;
    codigo_classe: number | null;
    codigo_pdm: number | null;
    codigo_item: number | null;
    incluido: boolean;
    observacao: string | null;
  }
  | { action: "catalogo_remover"; id: number }
  | { action: "palavras_listar"; codigo_pdm: number }
  | { action: "palavras_salvar"; id: number | null; codigo_pdm: number; padrao: string; ativo: boolean; tipo: TipoPalavra }
  | { action: "palavras_remover"; id: number; tipo: TipoPalavra }
  | { action: "catalogo_itens"; codigo_pdm: number }
  | { action: "catalogo_hidratar_itens"; apos_pdm: number | null; limite_pdms: number };

export const ACOES_ADMIN = new Set([
  "catalogo_salvar", "catalogo_remover", "palavras_salvar", "palavras_remover", "catalogo_hidratar_itens",
]);
