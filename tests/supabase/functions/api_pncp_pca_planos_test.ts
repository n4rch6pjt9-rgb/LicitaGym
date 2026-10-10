// GET api-pncp-pca (listagem de planos): colunas explícitas, sem as de controle do sync da spec 0012.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { COLUNAS_LISTA_PLANOS } from "../../../supabase/functions/api-pncp-pca/planos.ts";

const raiz = new URL("../../../", import.meta.url);

Deno.test("listagem de planos devolve as colunas de pca_planos anteriores à spec 0012, sem as de controle", async () => {
  // colunas do create table original: o select("*") devolvia exatamente estas antes da spec 0012
  const sql = await Deno.readTextFile(new URL("supabase/migrations/202609180004_pca.sql", raiz));
  const bloco = /CREATE TABLE public\.pca_planos \(([\s\S]*?)\n\);/.exec(sql)![1];
  const originais = bloco.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((c) => /^[a-z_]+$/.test(c));
  const lista = COLUNAS_LISTA_PLANOS.split(", ");
  assertEquals(lista, originais);
  assert(!lista.includes("descoberta_ausente") && !lista.includes("reprocessar"));
});

Deno.test("api-pncp-pca não usa select('*') em pca_planos", async () => {
  const src = await Deno.readTextFile(new URL("supabase/functions/api-pncp-pca/index.ts", raiz));
  assert(!/\.select\(\s*["']\*["']/.test(src));
  assert(src.includes("select(COLUNAS_LISTA_PLANOS"));
});
