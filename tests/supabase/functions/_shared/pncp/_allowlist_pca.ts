// Lista de campos permitidos de private.pca_persistir_unidade_atomica, lida da migration mais recente que define a
// função. Usada pelo teste de regressão da allowlist e pelo fake da RPC (_fake_pca_atomico.ts), para que todo teste
// de pca-lote/pca-fila valide o payload real contra a lista que vai para produção (incidente de 12/11/2026).

const MIGRATIONS = new URL("../../../../../supabase/migrations/", import.meta.url);
const FUNCAO =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?private"?\s*\.\s*"?pca_persistir_unidade_atomica"?\s*\(/i;

export type TabelaPca = "pca_planos" | "pca_itens";

function semComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Arquivo e corpo (a partir do CREATE) da última migration, em ordem de timestamp, que define a função. */
export function ultimaDefinicaoPca(): { arquivo: string; sql: string } {
  const arquivos = [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && /^\d{14}_.+\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
  let achado: { arquivo: string; sql: string } | null = null;
  for (const nome of arquivos) {
    const sql = semComentarios(Deno.readTextFileSync(new URL(nome, MIGRATIONS)));
    const m = sql.search(FUNCAO);
    if (m >= 0) achado = { arquivo: nome, sql: sql.slice(m) };
  }
  if (!achado) throw new Error("nenhuma migration define private.pca_persistir_unidade_atomica");
  return achado;
}

export function listaPermitidaPca(sql: string, tabela: TabelaPca): Set<string> {
  const m = sql.match(new RegExp(`WHEN '${tabela}' THEN\\s*k\\.nome = ANY \\(ARRAY\\[([^\\]]*)\\]`, "i"));
  if (!m) throw new Error(`lista de ${tabela} não encontrada na função`);
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

let cache: Record<TabelaPca, Set<string>> | null = null;

/** Listas das duas tabelas, lidas uma vez por processo de teste. */
export function listasPermitidasPca(): Record<TabelaPca, Set<string>> {
  if (!cache) {
    const { sql } = ultimaDefinicaoPca();
    cache = { pca_planos: listaPermitidaPca(sql, "pca_planos"), pca_itens: listaPermitidaPca(sql, "pca_itens") };
  }
  return cache;
}
