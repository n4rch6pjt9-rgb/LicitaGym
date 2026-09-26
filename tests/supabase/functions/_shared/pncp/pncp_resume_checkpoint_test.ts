import { assertEquals } from "jsr:@std/assert@1";
import { isComplete, nextPage, readSync } from "./_harness.ts";

Deno.test("B5 checkpoint helper advances only when pages remain and done is false", () => {
  assertEquals(
    nextPage({ pagina: 5, paginasRestantes: 3, totalRegistros: 99, done: false }),
    6,
  );
  assertEquals(
    nextPage({ pagina: 5, paginasRestantes: 0, totalRegistros: 99, done: false }),
    null,
  );
  assertEquals(
    nextPage({ pagina: 5, paginasRestantes: 3, totalRegistros: 99, done: true }),
    null,
  );
  assertEquals(isComplete({ pagina: 5, paginasRestantes: 0, totalRegistros: 1, done: false }), true);
  assertEquals(isComplete({ pagina: 5, paginasRestantes: 2, totalRegistros: 1, done: false }), false);
});

Deno.test("B5 editais sync resumes pending slices instead of always starting at page 1", async () => {
  const src = await readSync("sync-pncp-contratacoes-editais/index.ts");
  assertEquals(src.includes("loadPendingSlices"), true);
  assertEquals(src.includes("prior?.slices ?? rootSlices"), true);
  assertEquals(src.includes("nextPage("), false);
  assertEquals(src.includes('"incompleta"'), true);
  assertEquals(src.includes('"falhou"'), true);
});

Deno.test("B5 period anchor resource is pca_search, not a page cursor", async () => {
  const src = await readSync("_shared/pncp/period-anchor.ts");
  assertEquals(src.includes('const RESOURCE = "pca_search"'), true);
  assertEquals(src.includes("pagina"), false);
});
