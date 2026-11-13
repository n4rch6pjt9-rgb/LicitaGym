// Regressão do incidente de 12/11/2026: a spec 0056 acrescentou grupo_contratacao_codigo, grupo_contratacao_nome e
// data_atualizacao_origem ao normalizePcaItem, mas a lista de campos permitidos de
// private.pca_persistir_unidade_atomica continuou a antiga. Todo lote de itens falhou com 22023 "Campo PCA fora da
// lista permitida" e nenhum item de PCA foi gravado. O fake da RPC usado nos outros testes não aplica a lista, por
// isso nada quebrou na CI.
//
// Este teste lê a definição mais recente da função nas migrations e confere que todo campo que o TypeScript manda
// (normalizador + chave do plano + metadados de pca-lote.ts) está na lista da tabela certa.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { normalizePcaItem, normalizePcaPlano } from "../../../supabase/functions/_shared/pncp/normalize.ts";

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);
const FUNCAO = /CREATE OR REPLACE FUNCTION private\.pca_persistir_unidade_atomica\s*\(/i;
/** Metadados que pca-lote.ts (preparar) acrescenta a toda linha antes da RPC. */
const METADADOS = ["payload_hash", "updated_at", "last_synced_at", "last_seen_sync_id"];

function ultimaDefinicao(): { arquivo: string; sql: string } {
  const arquivos = [...Deno.readDirSync(MIGRATIONS)]
    .filter((e) => e.isFile && /^\d{14}_.+\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
  let achado: { arquivo: string; sql: string } | null = null;
  for (const nome of arquivos) {
    const sql = Deno.readTextFileSync(new URL(nome, MIGRATIONS));
    const m = sql.search(FUNCAO);
    if (m >= 0) achado = { arquivo: nome, sql: sql.slice(m) };
  }
  assert(achado, "nenhuma migration define private.pca_persistir_unidade_atomica");
  return achado;
}

function listaPermitida(sql: string, tabela: "pca_planos" | "pca_itens"): Set<string> {
  const m = sql.match(new RegExp(`WHEN '${tabela}' THEN\\s*k\\.nome = ANY \\(ARRAY\\[([^\\]]*)\\]`, "i"));
  assert(m, `lista de ${tabela} não encontrada na função`);
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
}

function faltando(campos: string[], permitidos: Set<string>): string[] {
  return campos.filter((c) => !permitidos.has(c)).sort();
}

Deno.test("allowlist PCA: todo campo de normalizePcaItem chega à RPC sem 'Campo PCA fora da lista permitida'", () => {
  const { arquivo, sql } = ultimaDefinicao();
  const item = normalizePcaItem({ numeroItem: 1, grupoContratacaoCodigo: "G1", dataAtualizacao: "2026-11-11" }, {});
  // pca-lote.ts grava { ...itemRow, pca_plano_id } e os metadados.
  const campos = [...Object.keys(item), "pca_plano_id", ...METADADOS];
  assertEquals(faltando(campos, listaPermitida(sql, "pca_itens")), [], `allowlist de pca_itens em ${arquivo}`);
});

Deno.test("allowlist PCA: todo campo de normalizePcaPlano chega à RPC", () => {
  const { arquivo, sql } = ultimaDefinicao();
  const plano = normalizePcaPlano({ idPcaPncp: "00394460000141-0-000001/2026" }, 2026);
  const campos = [...Object.keys(plano), ...METADADOS];
  assertEquals(faltando(campos, listaPermitida(sql, "pca_planos")), [], `allowlist de pca_planos em ${arquivo}`);
});

Deno.test("allowlist PCA: campos operacionais continuam fora da lista", () => {
  const { sql } = ultimaDefinicao();
  for (const tabela of ["pca_planos", "pca_itens"] as const) {
    const permitidos = listaPermitida(sql, tabela);
    for (const protegido of ["id", "created_at", "ativo", "descoberta_ausente", "reprocessar"]) {
      assert(!permitidos.has(protegido), `${protegido} não pode entrar na lista de ${tabela}`);
    }
  }
});
