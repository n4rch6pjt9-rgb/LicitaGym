/**
 * SEC-EDGE-002 — POST das api-pncp-* exige requireCronAuth antes de beginIdempotency.
 * O SEC-EDGE-004 (signed URL da legislação) saiu com a API de legislação (spec 0043, K-1).
 */
import { readSync } from "./pncp/_harness.ts";

Deno.test("SEC-EDGE-002 api-pncp POST auth before idempotency", async () => {
  for (
    const name of [
      "api-pncp-pca/index.ts",
      "api-pncp-contratacoes/index.ts",
    ]
  ) {
    const src = await readSync(name);
    if (!src.includes("requireCronAuth")) {
      throw new Error(`${name} must use requireCronAuth`);
    }
    if (
      src.includes('startsWith("Bearer ")') ||
      src.includes("startsWith('Bearer ')")
    ) {
      throw new Error(`${name} still has Bearer prefix fallback`);
    }
    const authIdx = src.indexOf("requireCronAuth(req)"); // ponto de chamada, não o import
    const idemIdx = src.indexOf("await beginIdempotency(");
    if (authIdx < 0 || idemIdx < 0 || authIdx > idemIdx) {
      throw new Error(`${name}: requireCronAuth must precede beginIdempotency`);
    }
  }
});
