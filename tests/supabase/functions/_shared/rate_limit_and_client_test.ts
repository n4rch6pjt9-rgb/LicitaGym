import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  parseRetryAfterMs,
  BudgetExhaustedError,
  createRequestBudget,
} from "../../../../supabase/functions/_shared/pncp/retry.ts";
import {
  createSupabaseHostLease,
  RateLimitPauseError,
  UnifiedHttpClient,
  type HostLeaseRpc,
  type SlotAcquisitionResult,
} from "../../../../supabase/functions/_shared/http-client/index.ts";
import {
  acquireSyncLock,
  loadPendingSlices,
} from "../../../../supabase/functions/_shared/pncp/lock.ts";
import {
  updateSyncHeartbeat,
  finishSyncRun,
} from "../../../../supabase/functions/_shared/pncp/supabase-admin.ts";
import {
  authenticateCron,
  validateCronAuth,
} from "../../../../supabase/functions/_shared/http.ts";
import { installFetch } from "./pncp/_harness.ts";

// Helper to temporarily set environment variables
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

// ---------------------------------------------------------------------------
// 1. Parsing Retry-After (segundos e HTTP-date)
// ---------------------------------------------------------------------------
Deno.test("1. Parsing Retry-After: delta seconds", () => {
  const now = 1700000000000;
  assertEquals(parseRetryAfterMs("120", now), 120_000);
  assertEquals(parseRetryAfterMs("0", now), 0);
  assertEquals(parseRetryAfterMs("5.5", now), 5500);
  assertEquals(parseRetryAfterMs("  30  ", now), 30_000);
});

Deno.test("1. Parsing Retry-After: RFC 7231 / RFC 2822 HTTP-date", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const targetDate = "Wed, 21 Oct 2026 07:28:45 GMT";
  assertEquals(parseRetryAfterMs(targetDate, now), 45_000);

  // Past date returns 0
  const pastDate = "Wed, 21 Oct 2026 07:27:00 GMT";
  assertEquals(parseRetryAfterMs(pastDate, now), 0);
});

Deno.test("1. Parsing Retry-After: invalid or empty returns null", () => {
  const now = 1700000000000;
  assertEquals(parseRetryAfterMs(null, now), null);
  assertEquals(parseRetryAfterMs("", now), null);
  assertEquals(parseRetryAfterMs("   ", now), null);
  assertEquals(parseRetryAfterMs("not-a-date-or-number", now), null);
  assertEquals(parseRetryAfterMs("-5", now), null);
});

// ---------------------------------------------------------------------------
// 2. Cooldown & 429 reporting
// ---------------------------------------------------------------------------
Deno.test("2. Cooldown: 429 reports rate limit to host lease with parsed Retry-After", async () => {
  const reported: Array<{ host: string; cooldown: number }> = [];
  const telemetry: unknown[] = [];

  const mockHostLease: HostLeaseRpc = {
    acquireSlot: (_host) => Promise.resolve({ allowed: true, wait_ms: 0 }),
    reportRateLimit: (host, cooldownSeconds) => {
      reported.push({ host, cooldown: cooldownSeconds });
      return Promise.resolve();
    },
  };

  const client = new UnifiedHttpClient({
    hostLease: mockHostLease,
    telemetryLogger: (t) => {
      telemetry.push(t);
      return Promise.resolve();
    },
  });

  const fetchMock = installFetch((_url) => {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "25" },
    });
  });

  try {
    let errorCaught: unknown;
    try {
      await client.fetchWithRateLimit(
        "https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao",
        {},
        {
          syncRunId: "run-test-429",
          maxAttempts: 1, // fail on first attempt to check report
        },
      );
    } catch (err) {
      errorCaught = err;
    }

    assertEquals(reported.length, 1);
    assertEquals(reported[0], { host: "pncp.gov.br", cooldown: 25 });
    assertEquals(telemetry.length, 1);
    const tel = telemetry[0] as Record<string, unknown>;
    assertEquals(tel.host, "pncp.gov.br");
    assertEquals(tel.statusHttp, 429);
    assertEquals(tel.retryAfterSeconds, 25);
  } finally {
    fetchMock.restore();
  }
});

Deno.test("2. Cooldown: active cooldown throws RateLimitPauseError when budget exceeded", async () => {
  const mockHostLease: HostLeaseRpc = {
    acquireSlot: (_host) => Promise.resolve({ allowed: false, reason: "cooldown", wait_ms: 30_000 }),
    reportRateLimit: () => Promise.resolve(),
  };

  const client = new UnifiedHttpClient({ hostLease: mockHostLease });
  // Budget with only 15 seconds remaining (< wait_ms 30s + attemptTimeout 20s + margin 10s)
  const budget = createRequestBudget(15_000);

  const fetchMock = installFetch(() => new Response("ok", { status: 200 }));
  try {
    await assertRejects(
      async () => {
        await client.fetchWithRateLimit(
          "https://pncp.gov.br/api/consulta/v1/atas",
          {},
          { budget },
        );
      },
      RateLimitPauseError,
      "Rate limit pause for host pncp.gov.br",
    );
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Wait & Queue Full
// ---------------------------------------------------------------------------
Deno.test("3. Wait: serialized queue wait_ms triggers heartbeat and sleep", async () => {
  let heartbeatCount = 0;
  const sleeps: number[] = [];

  const mockHostLease: HostLeaseRpc = {
    acquireSlot: (_host) => Promise.resolve({ allowed: true, reason: "granted", wait_ms: 1500 }),
    reportRateLimit: () => Promise.resolve(),
  };

  const client = new UnifiedHttpClient({ hostLease: mockHostLease });
  const budget = createRequestBudget(100_000);

  const fetchMock = installFetch(() => new Response("{}", { status: 200 }));
  try {
    const res = await client.fetchWithRateLimit(
      "https://dadosabertos.compras.gov.br/modulo-material/1",
      {},
      {
        budget,
        onHeartbeat: () => {
          heartbeatCount++;
          return Promise.resolve();
        },
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    assertEquals(res.status, 200);
    assertEquals(heartbeatCount, 1);
    assertEquals(sleeps, [1500]);
  } finally {
    fetchMock.restore();
  }
});

Deno.test("3. Queue Full: rejected queue throws RateLimitPauseError if budget is tight", async () => {
  const mockHostLease: HostLeaseRpc = {
    acquireSlot: (_host) => Promise.resolve({ allowed: false, reason: "queue_full", wait_ms: 20_000 }),
    reportRateLimit: () => Promise.resolve(),
  };

  const client = new UnifiedHttpClient({ hostLease: mockHostLease });
  const budget = createRequestBudget(25_000); // 25s < 20s + 20s + 10s

  const fetchMock = installFetch(() => new Response("ok"));
  try {
    await assertRejects(
      async () => {
        await client.fetchWithRateLimit("https://pncp.gov.br/api/search", {}, { budget });
      },
      RateLimitPauseError,
      "Rate limit pause",
    );
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Lock already_running
// ---------------------------------------------------------------------------
Deno.test("4. Lock: acquireSyncLock returns alreadyRunning when lock is active", async () => {
  const schemas: string[] = [];
  const fakeSupabase = {
    // RPC na raiz mira `public` (PGRST202 em produção) — não pode ser usado.
    rpc: () => {
      throw new Error("acquire_sync_lock deve ir via schema(\"private\").rpc, não client.rpc");
    },
    schema: (name: string) => {
      schemas.push(name);
      return {
        rpc: (fn: string, params: Record<string, unknown>) => {
          assertEquals(fn, "acquire_sync_lock");
          assertEquals(params.p_lock_key, "contratacoes-editais:padrao");
          assertEquals(params.p_resource_type, "contratacoes_editais");
          return Promise.resolve({
            data: {
              already_running: true,
              run_id: "active-run-uuid-999",
            },
            error: null,
          });
        },
      };
    },
  };

  const res = await acquireSyncLock(
    fakeSupabase as any,
    "contratacoes-editais:padrao",
    "contratacoes_editais",
    {},
  );

  assertEquals(res.alreadyRunning, true);
  assertEquals(res.runId, "active-run-uuid-999");
  assertEquals(schemas, ["private"]);
});

Deno.test("4. Lock: acquireSyncLock succeeds when lock is free and returns inherited continuation", async () => {
  const rpcSchemas: string[] = [];
  const fakeSupabase = {
    schema: (name: string) => ({
      rpc: (fn: string, _params: Record<string, unknown>) => {
        rpcSchemas.push(name);
        assertEquals(fn, "acquire_sync_lock");
        return Promise.resolve({
          data: {
            already_running: false,
            run_id: "new-run-uuid-111",
            continuation: {
              pending: [{ dataInicial: "20260920", dataFinal: "20260921", nextPage: 3 }],
              chain_id: "chain-root-000",
            },
            retomada_de_id: "prior-incomplete-uuid",
          },
          error: null,
        });
      },
    }),
  };

  const res = await acquireSyncLock(
    fakeSupabase as any,
    "contratacoes-editais:padrao",
    "contratacoes_editais",
    {},
  );

  assertEquals(res.alreadyRunning, false);
  assertEquals(res.runId, "new-run-uuid-111");
  assertEquals(res.retomadaDeId, "prior-incomplete-uuid");
  assertEquals(rpcSchemas, ["private"]);

  // Load continuation directly from inherited continuation
  const continuation = await loadPendingSlices(fakeSupabase as any, "contratacoes-editais:padrao", res.runId, res.continuation);
  assertEquals(continuation?.chainId, "chain-root-000");
  assertEquals(continuation?.slices.length, 1);
  assertEquals(continuation?.slices[0].nextPage, 3);
});

Deno.test("4. Lock: acquireSyncLock propaga erro do RPC private (ex.: PGRST202)", async () => {
  const fakeSupabase = {
    schema: (name: string) => ({
      rpc: (_fn: string, _params: Record<string, unknown>) => {
        assertEquals(name, "private");
        return Promise.resolve({
          data: null,
          error: { code: "PGRST202", message: "Could not find the function private.acquire_sync_lock" },
        });
      },
    }),
  };
  await assertRejects(() =>
    acquireSyncLock(fakeSupabase as any, "legislacao:padrao", "legislacao", {})
  );
});

Deno.test("4. HostLease: createSupabaseHostLease chama acquire_http_slot/report_http_rate_limit via schema(\"private\")", async () => {
  const calls: Array<{ schema: string; fn: string; params: Record<string, unknown> }> = [];
  const fakeSupabase = {
    rpc: () => {
      throw new Error("host lease deve ir via schema(\"private\").rpc, não client.rpc");
    },
    schema: (name: string) => ({
      rpc: (fn: string, params: Record<string, unknown>) => {
        calls.push({ schema: name, fn, params });
        if (fn === "acquire_http_slot") {
          return Promise.resolve({ data: { allowed: true, wait_ms: 0 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  const lease = createSupabaseHostLease(fakeSupabase as any);
  const slot = await lease.acquireSlot("pncp.gov.br", 5_000);
  await lease.reportRateLimit("pncp.gov.br", 30);
  assertEquals(slot, { allowed: true, wait_ms: 0 });
  assertEquals(calls, [
    { schema: "private", fn: "acquire_http_slot", params: { p_host: "pncp.gov.br", p_max_wait_ms: 5_000 } },
    { schema: "private", fn: "report_http_rate_limit", params: { p_host: "pncp.gov.br", p_cooldown_seconds: 30 } },
  ]);
});

// ---------------------------------------------------------------------------
// 5. Heartbeat & Continuation
// ---------------------------------------------------------------------------
Deno.test("5. Heartbeat: updateSyncHeartbeat records last_heartbeat_at, pagina_atual, and continuation", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const fakeSupabase = {
    schema: (name: string) => ({
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (field: string, val: unknown) => {
            updates.push({ name, table, field, val, patch });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };

  await updateSyncHeartbeat(fakeSupabase as any, "run-hb-123", {
    paginaAtual: 5,
    continuation: {
      pending: [{ dataInicial: "20260925", dataFinal: "20260926", nextPage: 5 }],
      chain_id: "chain-hb",
    },
    baseParametros: { modo: "incremental" },
  });

  assertEquals(updates.length, 1);
  const up = updates[0];
  assertEquals(up.val, "run-hb-123");
  const patch = up.patch as Record<string, unknown>;
  assertEquals(typeof patch.last_heartbeat_at, "string");
  assertEquals(patch.pagina_atual, 5);
  const params = patch.parametros as Record<string, unknown>;
  assertEquals(params.modo, "incremental");
  assertEquals((params.continuation as any).chain_id, "chain-hb");
});

// ---------------------------------------------------------------------------
// 6. Manual vs Incremental Handling
// ---------------------------------------------------------------------------
Deno.test("6. Manual vs Incremental: manual run on budget interruption finishes as falhou while keeping continuation", async () => {
  const runsFinished: Array<Record<string, unknown>> = [];
  const fakeSupabase = {
    schema: (_name: string) => ({
      from: (_table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_f: string, _v: unknown) => {
            runsFinished.push(patch);
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };

  const body = { data_inicial: "20260801", data_final: "20260810" };
  const lockKey = `contratacoes-editais:manual:${body.data_inicial}:${body.data_final}`;
  const isManual = lockKey.includes(":manual:") || (Boolean(body.data_inicial) && Boolean(body.data_final));
  assertEquals(isManual, true);

  const pendingSlices = [{ dataInicial: "20260805", dataFinal: "20260810", nextPage: 2 }];
  const status = isManual ? "falhou" : "incompleta";

  await finishSyncRun(fakeSupabase as any, "run-manual-01", {
    status,
    erroPrincipal: "checkpoint: 1 fatias pendentes",
    totalRecebidos: 50,
    paginaAtual: 2,
    parametros: {
      ...body,
      continuation: {
        pending: pendingSlices,
        chain_id: "run-manual-01",
      },
    },
  });

  assertEquals(runsFinished.length, 1);
  const run = runsFinished[0];
  // Manual must be falhou, not incompleta
  assertEquals(run.status, "falhou");
  // But continuation must be preserved in parametros
  const params = run.parametros as Record<string, unknown>;
  assertEquals((params.continuation as any).pending.length, 1);
  assertEquals((params.continuation as any).pending[0].nextPage, 2);
});

Deno.test("6. Manual vs Incremental: automatic run on budget interruption finishes as incompleta with continuation", async () => {
  const runsFinished: Array<Record<string, unknown>> = [];
  const fakeSupabase = {
    schema: (_name: string) => ({
      from: (_table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_f: string, _v: unknown) => {
            runsFinished.push(patch);
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };

  const body = {}; // automatic default
  const lockKey = "contratacoes-editais:padrao";
  const isManual = lockKey.includes(":manual:");
  assertEquals(isManual, false);

  const pendingSlices = [{ dataInicial: "20260927", dataFinal: "20260928", nextPage: 4 }];
  const status = isManual ? "falhou" : (pendingSlices.length > 0 ? "incompleta" : "concluida");

  await finishSyncRun(fakeSupabase as any, "run-auto-01", {
    status,
    erroPrincipal: "checkpoint: 1 fatias pendentes",
    totalRecebidos: 150,
    paginaAtual: 4,
    parametros: {
      ...body,
      continuation: {
        pending: pendingSlices,
        chain_id: "run-auto-01",
      },
    },
  });

  assertEquals(runsFinished.length, 1);
  const run = runsFinished[0];
  // Automatic must be incompleta so it will be resumed
  assertEquals(run.status, "incompleta");
  const params = run.parametros as Record<string, unknown>;
  assertEquals((params.continuation as any).pending.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Auth Constante e Rotação
// ---------------------------------------------------------------------------
Deno.test("7. Auth: timing-safe constant-time comparison authenticates valid Bearer token", async () => {
  await withEnv({ SYNC_CRON_SECRET: "my-secure-cron-secret-2026" }, () => {
    const validReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer my-secure-cron-secret-2026" },
    });
    assertEquals(authenticateCron(validReq), "CRON_AUTHENTICATED");
    assertEquals(validateCronAuth(validReq), true);

    const invalidReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
    });
    assertEquals(authenticateCron(invalidReq), "REJECTED");
    assertEquals(validateCronAuth(invalidReq), false);

    // Empty or missing header
    const missingReq = new Request("http://localhost/sync", { method: "POST" });
    assertEquals(authenticateCron(missingReq), "REJECTED");
  });
});

Deno.test("7. Auth: secret rotation supports comma-separated list in SYNC_CRON_SECRET", async () => {
  // During zero-downtime rotation, SYNC_CRON_SECRET has both old and new secret
  await withEnv({ SYNC_CRON_SECRET: "old-secret-phase1, new-secret-phase2, active-vault-key" }, () => {
    // Old secret works
    const oldReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer old-secret-phase1" },
    });
    assertEquals(authenticateCron(oldReq), "CRON_AUTHENTICATED");

    // New secret works
    const newReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer new-secret-phase2" },
    });
    assertEquals(authenticateCron(newReq), "CRON_AUTHENTICATED");

    // Third key works
    const vaultReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer active-vault-key" },
    });
    assertEquals(authenticateCron(vaultReq), "CRON_AUTHENTICATED");

    // Non-listed secret is rejected
    const badReq = new Request("http://localhost/sync", {
      method: "POST",
      headers: { Authorization: "Bearer expired-secret" },
    });
    assertEquals(authenticateCron(badReq), "REJECTED");
    assertEquals(validateCronAuth(badReq), false);
  });
});
