import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  installFetch,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  PncpConsultaClient,
  RetryableHttpError,
  retryDelayMs,
  retryDelayWithJitter,
  withRetry,
} from "./_harness.ts";

Deno.test("C3 withRetry backoff is exponential with bounded jitter", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const value = await withRetry(async () => {
    n++;
    if (n < 4) throw new Error("again");
    return "ok";
  }, {
    maxAttempts: 4,
    baseDelayMs: 40,
    random: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(value, "ok");
  assertEquals(sleeps, [40, 80, 160]);
  assertEquals(retryDelayWithJitter(3, 40, () => 0.999), 160 + 39);
  assertEquals(retryDelayWithJitter(10, 1000, () => 0.999), MAX_RETRY_AFTER_MS);
});

Deno.test("C3 Retry-After seconds and HTTP-date become a wait, then clamp", () => {
  assertEquals(parseRetryAfterMs("60"), 60_000);
  assertEquals(parseRetryAfterMs("0"), 0);
  assertEquals(parseRetryAfterMs(null), null);
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  assertEquals(parseRetryAfterMs("Sun, 01 Aug 2026 00:00:02 GMT", now), 2_000);
  const rateLimit = new RetryableHttpError("PNCP consulta HTTP 429", 60_000);
  assertEquals(retryDelayMs(rateLimit, 1, 1000), 60_000);
  assertEquals(
    retryDelayMs(new RetryableHttpError("PNCP consulta HTTP 429", 120_000), 1, 1000),
    MAX_RETRY_AFTER_MS,
  );
  const plain = retryDelayMs(new Error("again"), 2, 1000);
  assert(plain >= 2_000 && plain <= 2_250, `plain ${plain}`);
});

Deno.test("C3 RetryableHttpError waits retryAfterMs instead of linear backoff", async () => {
  let n = 0;
  const sleeps: number[] = [];
  const value = await withRetry(async () => {
    n++;
    if (n < 3) throw new RetryableHttpError("PNCP consulta HTTP 429", 30);
    return "ok";
  }, {
    maxAttempts: 3,
    baseDelayMs: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assertEquals(value, "ok");
  assertEquals(sleeps, [30, 30]);
});
