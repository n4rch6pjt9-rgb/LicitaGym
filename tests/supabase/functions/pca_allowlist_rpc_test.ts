// Regressão do incidente de 12/11/2026: a spec 0056 acrescentou grupo_contratacao_codigo, grupo_contratacao_nome e
// data_atualizacao_origem ao normalizePcaItem, mas a lista de campos permitidos de
// private.pca_persistir_unidade_atomica continuou a antiga. Todo lote de itens falhou com 22023 "Campo PCA fora da
// lista permitida" e nenhum item de PCA foi gravado. O fake da RPC não aplicava a lista, por isso nada quebrou na CI;
// agora aplica (_fake_pca_atomico.ts usa a mesma leitura da migration).
//
// Este teste lê a definição mais recente da função nas migrations e confere que todo campo que o TypeScript manda
// (normalizador + chave do plano + metadados de pca-lote.ts) está na lista da tabela certa.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { normalizePcaItem, normalizePcaPlano } from "../../../supabase/functions/_shared/pncp/normalize.ts";
import { listaPermitidaPca, ultimaDefinicaoPca } from "./_shared/pncp/_allowlist_pca.ts";
import { FakePcaPostgrest } from "./_shared/pncp/_fake_pca_atomico.ts";
import { persistirLoteAtomico } from "../../../supabase/functions/_shared/pncp/pca-atomico.ts";

/** Metadados que pca-lote.ts (preparar) acrescenta a toda linha antes da RPC. */
const METADADOS = ["payload_hash", "updated_at", "last_synced_at", "last_seen_sync_id"];
const RUN = "00000000-0000-4000-8000-000000000001";

function faltando(campos: string[], permitidos: Set<string>): string[] {
  return campos.filter((c) => !permitidos.has(c)).sort();
}

Deno.test("allowlist PCA: todo campo de normalizePcaItem chega à RPC sem 'Campo PCA fora da lista permitida'", () => {
  const { arquivo, sql } = ultimaDefinicaoPca();
  const item = normalizePcaItem({ numeroItem: 1, grupoContratacaoCodigo: "G1", dataAtualizacao: "2026-11-11" }, {});
  // pca-lote.ts grava { ...itemRow, pca_plano_id } e os metadados.
  const campos = [...Object.keys(item), "pca_plano_id", ...METADADOS];
  assertEquals(faltando(campos, listaPermitidaPca(sql, "pca_itens")), [], `allowlist de pca_itens em ${arquivo}`);
});

Deno.test("allowlist PCA: todo campo de normalizePcaPlano chega à RPC", () => {
  const { arquivo, sql } = ultimaDefinicaoPca();
  const plano = normalizePcaPlano({ idPcaPncp: "00394460000141-0-000001/2026" }, 2026);
  const campos = [...Object.keys(plano), ...METADADOS];
  assertEquals(faltando(campos, listaPermitidaPca(sql, "pca_planos")), [], `allowlist de pca_planos em ${arquivo}`);
});

Deno.test("allowlist PCA: campos operacionais continuam fora da lista", () => {
  const { sql } = ultimaDefinicaoPca();
  for (const tabela of ["pca_planos", "pca_itens"] as const) {
    const permitidos = listaPermitidaPca(sql, tabela);
    for (const protegido of ["id", "created_at", "ativo", "descoberta_ausente", "reprocessar"]) {
      assert(!permitidos.has(protegido), `${protegido} não pode entrar na lista de ${tabela}`);
    }
  }
});

Deno.test("allowlist PCA: o fake da RPC rejeita campo fora da lista, como a função em produção", async () => {
  const client = new FakePcaPostgrest({});
  const linha = { pca_plano_id: "00000000-0000-4000-8000-0000000000aa", numero_item: 1, payload_hash: "h", campo_novo: 1 };
  await assertRejects(
    () =>
      persistirLoteAtomico(
        client as never,
        [{ tabela: "pca_itens", chave: { pca_plano_id: linha.pca_plano_id, numero_item: 1 }, linha }],
        RUN,
      ),
    Error,
    "Campo PCA fora da lista permitida",
  );
});
