/**
 * SEC-EDGE-004 — signed URL path must require authenticated user JWT.
 * Static regression: legislacao source must not mint signed URLs before auth.
 */
import { readSync } from "./pncp/_harness.ts";

Deno.test("SEC-EDGE-004 legislacao signed_url gated by requireUserAuth", async () => {
  const src = await readSync("api-pncp-legislacao/index.ts");
  if (!src.includes("requireUserAuth")) {
    throw new Error("signed_url path must call requireUserAuth");
  }
  if (!src.includes("signed_url")) {
    throw new Error("expected signed_url branch");
  }
  // Call site (not import/comment): requireUserAuth(req) must precede .createSignedUrl(.
  const authIdx = src.indexOf("requireUserAuth(req)");
  const signedIdx = src.indexOf(".createSignedUrl(");
  if (authIdx < 0 || signedIdx < 0 || authIdx > signedIdx) {
    throw new Error("requireUserAuth must precede createSignedUrl");
  }
  // Must not use prefix-only Bearer fallback anywhere
  if (
    src.includes('startsWith("Bearer ")') ||
    src.includes("startsWith('Bearer ')")
  ) {
    throw new Error("Bearer prefix fallback must be removed");
  }
});

Deno.test("SEC-EDGE-002 api-pncp POST auth before idempotency", async () => {
  for (
    const name of [
      "api-pncp-pca/index.ts",
      "api-pncp-contratacoes/index.ts",
      "api-pncp-legislacao/index.ts",
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
    const authIdx = src.indexOf("requireCronAuth");
    const idemIdx = src.indexOf("beginIdempotency");
    if (authIdx < 0 || idemIdx < 0 || authIdx > idemIdx) {
      throw new Error(`${name}: requireCronAuth must precede beginIdempotency`);
    }
  }
});
