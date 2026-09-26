import { assertEquals } from "jsr:@std/assert@1";
import { readSync } from "./_harness.ts";

Deno.test("B6 PCA default max_paginas is 100, separate from the 200 cap", async () => {
  const src = await readSync("sync-pncp-pca/index.ts");
  assertEquals(src.includes("body.max_paginas ?? 100"), true);
  assertEquals(src.includes("pagina < paginaInicial + maxPaginas"), true);
  assertEquals(src.includes("pagina <= 200"), false);
});
