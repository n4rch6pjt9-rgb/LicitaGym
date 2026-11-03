import { assertEquals } from "jsr:@std/assert@1";
import { readSync } from "./_harness.ts";

Deno.test("B6 PCA default max_paginas is 100, separate from the 200 cap", async () => {
  const src = await readSync("sync-pncp-pca/index.ts");
  assertEquals(src.includes("body.max_paginas ?? 100"), true);
  // O limite real e o início após 200 são exercitados no handler em sync_pncp_pca_legado_test.ts.
  assertEquals(src.includes("pagina <= 200"), false);
});
