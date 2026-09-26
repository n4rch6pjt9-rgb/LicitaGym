import { assertEquals } from "jsr:@std/assert";
import { normalizePcaItem } from "../../../../../supabase/functions/_shared/pncp/normalize.ts";

const plan = { idPcaPncp: "test-plan" };

Deno.test("normalizePcaItem maps classificacaoCatalogoId=1 to classificacao_catalogo_id", () => {
  const row = normalizePcaItem({
    numeroItem: 1,
    classificacaoCatalogoId: 1,
    classificacaoSuperiorCodigo: "7830",
  }, plan);
  assertEquals(row.classificacao_catalogo_id, "1");
});

Deno.test("normalizePcaItem maps classificacaoCatalogoId=2 to classificacao_catalogo_id", () => {
  const row = normalizePcaItem({
    numeroItem: 2,
    classificacaoCatalogoId: 2,
  }, plan);
  assertEquals(row.classificacao_catalogo_id, "2");
});

Deno.test("normalizePcaItem keeps classificacao_catalogo_id null when raw absent", () => {
  const row = normalizePcaItem({
    numeroItem: 3,
    descricaoItem: "Item sem natureza",
  }, plan);
  assertEquals(row.classificacao_catalogo_id, null);
});

Deno.test("normalizePcaItem keeps classificacao_catalogo_id null when raw null", () => {
  const row = normalizePcaItem({
    numeroItem: 4,
    classificacaoCatalogoId: null,
  }, plan);
  assertEquals(row.classificacao_catalogo_id, null);
});

Deno.test("categoriaItemPcaNome does not affect classificacao_catalogo_id", () => {
  const row = normalizePcaItem({
    numeroItem: 5,
    categoriaItemPcaNome: "Serviço",
    classificacaoCatalogoId: 1,
  }, plan);
  assertEquals(row.classificacao_catalogo_id, "1");
  assertEquals(row.categoria, "Serviço");
});

Deno.test("categoriaItemPcaNome alone does not infer nature", () => {
  const row = normalizePcaItem({
    numeroItem: 6,
    categoriaItemPcaNome: "Material",
  }, plan);
  assertEquals(row.classificacao_catalogo_id, null);
  assertEquals(row.categoria, "Material");
});
