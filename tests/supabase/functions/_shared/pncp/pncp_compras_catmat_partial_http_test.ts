/**
 * Item 6 — sync-compras-catmat must not hide partial failures behind HTTP 200.
 */
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("sync-compras-catmat returns non-200 when erros > 0", async () => {
  const src = await Deno.readTextFile(
    "supabase/functions/sync-compras-catmat/index.ts",
  );
  assertEquals(src.includes("stats.erros > 0 ? 500 : 200"), true);
  assertEquals(
    src.includes(
      'const terminalStatus = stats.erros > 0 ? "concluida_com_erros" : "concluida"',
    ),
    true,
  );
  // O corpo HTTP não pode cravar "concluida" e ignorar erros. O status do run
  // no banco (finishSyncRun) pode ser "concluida" quando não houve trabalho.
  for (const chunk of src.split("return jsonResponse(").slice(1)) {
    const body = chunk.slice(0, Math.max(chunk.indexOf(");"), 0));
    assertEquals(body.includes('status: "concluida"'), false);
  }
});
