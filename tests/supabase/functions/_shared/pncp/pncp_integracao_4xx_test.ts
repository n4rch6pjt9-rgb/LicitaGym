import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, jsonResponse } from "./_harness.ts";
import { PncpIntegracaoClient } from "../../../../../supabase/functions/_shared/pncp/integracao-client.ts";
import { UnifiedHttpClient } from "../../../../../supabase/functions/_shared/http-client/unified-client.ts";
import { PermanentHttpError } from "../../../../../supabase/functions/_shared/pncp/retry.ts";

const BASE = "https://pncp.test/api/pncp/v1";

Deno.test("integração pelo cliente unificado devolve o 404 com o corpo, para a fila arquivar", async () => {
  const mock = installFetch(() => jsonResponse(404, { message: "Not Found" }));
  try {
    const integ = new PncpIntegracaoClient(BASE, new UnifiedHttpClient());
    const r = await integ.getPcaItensPagina("00394429000100", 2026, 4, 1, 2000);
    assertEquals(r.status, 404);
    assertEquals(r.body, { message: "Not Found" });
  } finally {
    mock.restore();
  }
});

Deno.test("4xx com corpo que não é JSON segue como texto", async () => {
  const mock = installFetch(() => new Response("<html>bad request</html>", { status: 400 }));
  try {
    const integ = new PncpIntegracaoClient(BASE, new UnifiedHttpClient());
    const r = await integ.getPcaItensQuantidade("00394429000100", 2026, 4);
    assertEquals(r.status, 400);
    assertEquals(r.body, "<html>bad request</html>");
  } finally {
    mock.restore();
  }
});

Deno.test("sem devolver4xx, o cliente unificado continua lançando PermanentHttpError no 4xx", async () => {
  const mock = installFetch(() => jsonResponse(404, { message: "Not Found" }));
  try {
    await assertRejects(
      () => new UnifiedHttpClient().getJson(`${BASE}/qualquer`),
      PermanentHttpError,
    );
  } finally {
    mock.restore();
  }
});
