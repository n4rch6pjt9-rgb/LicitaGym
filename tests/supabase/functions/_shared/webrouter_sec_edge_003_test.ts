/**
 * SEC-EDGE-003 — WebRouter destination allowlist + payload validation.
 * No live network calls.
 */
import {
  assertWebRouterUrlAllowed,
  resolveWebRouterApiUrl,
  validateWebRouterPayload,
  WEBROUTER_ALLOWED_HOSTS,
} from "../../../../supabase/functions/_shared/webrouter.ts";

Deno.test("SEC-EDGE-003 resolve appends calcular path", () => {
  const url = resolveWebRouterApiUrl("https://way.webrouter.com.br/RouterService");
  if (url !== "https://way.webrouter.com.br/RouterService/router/api/calcular") {
    throw new Error(url);
  }
});

Deno.test("SEC-EDGE-003 resolve keeps full calcular URL", () => {
  const url = resolveWebRouterApiUrl(
    "https://way-hml.webrouter.com.br/RouterService/router/api/calcular/",
  );
  if (url !== "https://way-hml.webrouter.com.br/RouterService/router/api/calcular") {
    throw new Error(url);
  }
});

Deno.test("SEC-EDGE-003 allowlist accepts only known hosts", () => {
  assertWebRouterUrlAllowed(
    "https://way.webrouter.com.br/RouterService/router/api/calcular",
  );
  assertWebRouterUrlAllowed(
    "https://way-hml.webrouter.com.br/RouterService/router/api/calcular",
  );
  let threw = false;
  try {
    assertWebRouterUrlAllowed("https://evil.example/router/api/calcular");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("evil host must throw");
});

Deno.test("SEC-EDGE-003 blocks http and metadata-style hosts", () => {
  for (const bad of [
    "http://way.webrouter.com.br/RouterService/router/api/calcular",
    "https://127.0.0.1/router/api/calcular",
    "https://169.254.169.254/router/api/calcular",
    "https://localhost/router/api/calcular",
  ]) {
    let threw = false;
    try {
      assertWebRouterUrlAllowed(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`must block ${bad}`);
  }
});

Deno.test("SEC-EDGE-003 payload rejects proxy-like keys and non-objects", () => {
  if (validateWebRouterPayload(null).ok) throw new Error("null");
  if (validateWebRouterPayload([]).ok) throw new Error("array");
  if (validateWebRouterPayload({ url: "https://evil" }).ok) {
    throw new Error("url key");
  }
  if (validateWebRouterPayload({ endpoint: "x" }).ok) throw new Error("endpoint");
  const ok = validateWebRouterPayload({ origem: "SP", destino: "RJ" });
  if (!ok.ok) throw new Error("legit payload");
});

Deno.test("SEC-EDGE-003 allowlist set is non-empty and fixed", () => {
  if (WEBROUTER_ALLOWED_HOSTS.size < 2) throw new Error("allowlist too small");
});
