// Spec 0044, K-6: sync-pncp-legislation aposentada. Com auth de cron válida responde 410 sem abrir execução nem
// chamar rede; sem auth continua 401 (a ordem auth → 410 não muda).
import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/sync-pncp-legislation/index.ts";

function post(): Request {
  return new Request("http://x/sync-pncp-legislation", { method: "POST", body: "{}" });
}

async function semRede<T>(fn: () => Promise<T>): Promise<{ resultado: T; chamadas: number }> {
  const original = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = (() => {
    chamadas++;
    return Promise.reject(new Error("rede proibida no teste"));
  }) as typeof fetch;
  try {
    return { resultado: await fn(), chamadas };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("CA-3: com auth de cron válida responde 410 sem fetch nem execução", async () => {
  const { resultado, chamadas } = await semRede(() => Promise.resolve(handleRequest(post(), { validarCron: () => true })));
  assertEquals(resultado.status, 410);
  assertEquals((await resultado.json()).error, "aposentada pela spec 0044");
  assertEquals(chamadas, 0);
});

Deno.test("CA-3: sem auth de cron responde 401 (CA negativo de acesso)", async () => {
  const { resultado, chamadas } = await semRede(() => Promise.resolve(handleRequest(post(), { validarCron: () => false })));
  assertEquals(resultado.status, 401);
  assertEquals(chamadas, 0);
});

Deno.test("CA-3: o código não importa mais o cliente admin nem o lock do sync", async () => {
  const codigo = await Deno.readTextFile("./supabase/functions/sync-pncp-legislation/index.ts");
  assertEquals(/supabase-admin|acquireSyncLock|createServiceClient/.test(codigo), false);
});

Deno.test("CA-3: contexto padrão (requireCronAuth real) sem Bearer responde 401", async () => {
  const anterior = Deno.env.get("SYNC_CRON_SECRET");
  Deno.env.set("SYNC_CRON_SECRET", "segredo-de-teste-0044");
  try {
    const { resultado, chamadas } = await semRede(() => Promise.resolve(handleRequest(post())));
    assertEquals(resultado.status, 401);
    assertEquals(chamadas, 0);
  } finally {
    if (anterior === undefined) Deno.env.delete("SYNC_CRON_SECRET");
    else Deno.env.set("SYNC_CRON_SECRET", anterior);
  }
});

Deno.test("CA-3: método diferente de POST continua 405 antes da auth", () => {
  const res = handleRequest(new Request("http://x/sync-pncp-legislation"), { validarCron: () => true });
  assertEquals(res.status, 405);
});
