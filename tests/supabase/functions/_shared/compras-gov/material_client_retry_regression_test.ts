/**
 * Regression: Compras.gov material-client uses withRetry(fn, 6, 2_500).
 * Timeout must be allowed across all 6 attempts when no RequestBudget is bound
 * (commit 13e4624 + PR #47 item 2 — do not force maxTimeoutRetries: 1 on legacy overload).
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { withRetry } from "../../../../../supabase/functions/_shared/pncp/retry.ts";
import {
  ComprasGovMaterialClient,
  EnvelopeComprasGovInvalidoError,
} from "../../../../../supabase/functions/_shared/compras-gov/material-client.ts";

Deno.test(
  "material-client numeric overload withRetry(fn, 6, delay) allows 6 timeouts",
  async () => {
    let attempts = 0;
    await assertRejects(
      () =>
        withRetry(
          async () => {
            attempts += 1;
            throw new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            );
          },
          6,
          1,
        ),
      DOMException,
    );
    assertEquals(attempts, 6);
  },
);

Deno.test(
  "material-client equivalent options (no budget) allow 6 timeout attempts",
  async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    await assertRejects(
      () =>
        withRetry(
          async () => {
            attempts += 1;
            throw new Error("Compras.gov timeout (60s)");
          },
          {
            maxAttempts: 6,
            baseDelayMs: 2_500,
            random: () => 0,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          },
        ),
      Error,
      "timeout",
    );
    assertEquals(attempts, 6);
    assertEquals(sleeps.length, 5);
  },
);

Deno.test(
  "material-client: HTTP 4xx permanente não faz retry e preserva detalhe via statusText",
  async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("erro detalhado", {
        status: 400,
        statusText: "Bad Request",
      });
    }) as typeof fetch;
    try {
      const client = new ComprasGovMaterialClient();
      await assertRejects(
        () => client.consultarGrupoMaterial({}),
        Error,
        "Compras.gov HTTP 400 Bad Request",
      );
      assertEquals(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("fetchAllPages recusa HTTP 200 sem resultado e paginasRestantes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    const client = new ComprasGovMaterialClient();
    await assertRejects(
      () => client.fetchItens({ codigoPdm: 1 }, { maxPaginas: 1 }),
      EnvelopeComprasGovInvalidoError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
