/**
 * SEC-EDGE-002 / auth helper characterization + regression.
 * Presence of "Bearer " alone must NEVER authenticate.
 */
import {
  authenticateCron,
  extractBearerToken,
  requireCronAuth,
  validateCronAuth,
} from "../../../../supabase/functions/_shared/http.ts";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    previous.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

function req(auth?: string | null): Request {
  const headers = new Headers();
  if (auth !== undefined && auth !== null) headers.set("Authorization", auth);
  return new Request("http://local.test/sync", { method: "POST", headers });
}

Deno.test("SEC-EDGE-002 extractBearerToken rejects absent/empty/malformed", () => {
  if (extractBearerToken(req(null)) !== null) throw new Error("absent");
  if (extractBearerToken(req("")) !== null) throw new Error("empty");
  if (extractBearerToken(req("Bearer")) !== null) throw new Error("Bearer alone");
  if (extractBearerToken(req("Bearer ")) !== null) throw new Error("Bearer space");
  if (extractBearerToken(req("bearer   ")) !== null) throw new Error("whitespace token");
  if (extractBearerToken(req("Token abc")) !== null) throw new Error("wrong scheme");
  if (extractBearerToken(req("Bearer secret-ok")) !== "secret-ok") {
    throw new Error("valid extract");
  }
});

Deno.test("SEC-EDGE-002 missing SYNC_CRON_SECRET fails closed", async () => {
  await withEnv({ SYNC_CRON_SECRET: undefined }, () => {
    if (authenticateCron(req("Bearer anything")) !== "REJECTED") {
      throw new Error("must reject when secret missing");
    }
    if (validateCronAuth(req("Bearer anything"))) {
      throw new Error("validateCronAuth must be false");
    }
  });
});

Deno.test("SEC-EDGE-002 empty SYNC_CRON_SECRET fails closed", async () => {
  await withEnv({ SYNC_CRON_SECRET: "   " }, () => {
    if (authenticateCron(req("Bearer    ")) !== "REJECTED") {
      throw new Error("blank secret must reject");
    }
  });
});

Deno.test("SEC-EDGE-002 no Authorization → REJECTED", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    if (authenticateCron(req(null)) !== "REJECTED") throw new Error("no auth");
    const denied = requireCronAuth(req(null));
    if (!denied || denied.status !== 401) throw new Error("expect 401");
  });
});

Deno.test("SEC-EDGE-002 Bearer empty / alone → REJECTED", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    for (const h of ["Bearer", "Bearer ", "bearer ", "Bearer\t"]) {
      if (authenticateCron(req(h)) !== "REJECTED") {
        throw new Error(`should reject: ${JSON.stringify(h)}`);
      }
    }
  });
});

Deno.test("SEC-EDGE-002 arbitrary Bearer → REJECTED (regression vs startsWith bug)", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    for (const h of [
      "Bearer arbitrary",
      "Bearer eyJhbGciOiJub25lIn0.fake.sig",
      "Bearer not-the-secret",
      "Bearer correct-secret-extra",
    ]) {
      if (authenticateCron(req(h)) !== "REJECTED") {
        throw new Error(`arbitrary must reject: ${h}`);
      }
    }
  });
});

Deno.test("SEC-EDGE-002 wrong cron secret → REJECTED", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    if (authenticateCron(req("Bearer wrong-secret")) !== "REJECTED") {
      throw new Error("wrong secret");
    }
  });
});

Deno.test("SEC-EDGE-002 correct SYNC_CRON_SECRET → CRON_AUTHENTICATED", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    if (authenticateCron(req("Bearer correct-secret")) !== "CRON_AUTHENTICATED") {
      throw new Error("exact secret must allow");
    }
    if (!validateCronAuth(req("Bearer correct-secret"))) {
      throw new Error("validateCronAuth true");
    }
    if (requireCronAuth(req("Bearer correct-secret")) !== null) {
      throw new Error("requireCronAuth null");
    }
  });
});

Deno.test("SEC-EDGE-002 startsWith Bearer alone is not sufficient", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, () => {
    const auth = "Bearer totally-wrong";
    // Old bug: auth.startsWith("Bearer ") === true → would allow
    if (!auth.startsWith("Bearer ")) throw new Error("setup");
    if (authenticateCron(req(auth)) === "CRON_AUTHENTICATED") {
      throw new Error("REGRESSION: prefix-only auth returned");
    }
  });
});

Deno.test("authenticateUserJwt empty or whitespace ANON_KEY falls through to PUBLISHABLE_KEY", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requestedApiKey: string | null = null;
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requestedApiKey = headers.get("apikey");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-123",
            aud: "authenticated",
            role: "authenticated",
            email: "test@example.com",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };

    // 1) Empty string ANON_KEY falls through to PUBLISHABLE_KEY
    await withEnv(
      {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "   ",
        SUPABASE_PUBLISHABLE_KEY: "publishable-key-ok",
      },
      async () => {
        const { authenticateUserJwt } = await import(
          "../../../../supabase/functions/_shared/http.ts"
        );
        const decision = await authenticateUserJwt(req("Bearer valid-jwt-token"));
        if (decision !== "USER_AUTHENTICATED") {
          throw new Error(`expected USER_AUTHENTICATED, got ${decision}`);
        }
        if (requestedApiKey !== "publishable-key-ok") {
          throw new Error(`expected apikey publishable-key-ok, got ${requestedApiKey}`);
        }
      },
    );

    // 2) Both blank fails closed
    await withEnv(
      {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "   ",
        SUPABASE_PUBLISHABLE_KEY: "   ",
      },
      async () => {
        const { authenticateUserJwt } = await import(
          "../../../../supabase/functions/_shared/http.ts"
        );
        const decision = await authenticateUserJwt(req("Bearer valid-jwt-token"));
        if (decision !== "REJECTED") {
          throw new Error(`expected REJECTED when both blank, got ${decision}`);
        }
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

