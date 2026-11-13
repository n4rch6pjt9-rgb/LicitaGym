import { assertEquals } from "jsr:@std/assert@1";
import { createServiceClient } from "../../../supabase/functions/_shared/pncp/supabase-admin.ts";
import { acquireSyncLock } from "../../../supabase/functions/_shared/pncp/lock.ts";

Deno.test("PCA: cliente isolado transmite token e execução em cada escrita", async () => {
  const urlAnterior = Deno.env.get("SUPABASE_URL");
  const chaveAnterior = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const fetchAnterior = globalThis.fetch;
  const headers: Headers[] = [];
  try {
    Deno.env.set("SUPABASE_URL", "http://localhost:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "chave-sintetica-de-teste");
    globalThis.fetch = (_input, init) => {
      headers.push(new Headers(init?.headers));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const client = createServiceClient({ "x-pca-reserva": "token-a", "x-pca-run-id": "run-a" });
    const outro = createServiceClient({ "x-pca-reserva": "token-b", "x-pca-run-id": "run-b" });
    await client.from("pca_itens").update({ ativo: false }).eq("id", "item-a");
    await outro.from("pca_itens").update({ ativo: false }).eq("id", "item-b");
    await client.from("pca_planos").update({ reprocessar: false }).eq("id", "plano-a");
    assertEquals(headers.map(h => [h.get("x-pca-reserva"), h.get("x-pca-run-id")]),
      [["token-a", "run-a"], ["token-b", "run-b"], ["token-a", "run-a"]]);
  } finally {
    globalThis.fetch = fetchAnterior;
    if (urlAnterior === undefined) Deno.env.delete("SUPABASE_URL"); else Deno.env.set("SUPABASE_URL", urlAnterior);
    if (chaveAnterior === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", chaveAnterior);
  }
});

Deno.test("PCA: fila e legado usam a RPC anual preservando a chave de continuation", async () => {
  for (const key of ["pca-fila:2026", "pca-sync:2026:7830", "pca-sync:manual:2026:7220,7830"]) {
    const chamadas: unknown[] = [];
    const client = { schema: (_schema: string) => ({
      rpc: (name: string, args: unknown) => {
        chamadas.push([name, args]);
        return Promise.resolve({ data: { already_running: true, run_id: "ocupado" }, error: null });
      },
    }) };
    const r = await acquireSyncLock(client as never, key, "pca", { ano: 2026 });
    assertEquals(r.alreadyRunning, true);
    assertEquals(chamadas, [["pca_adquirir_execucao", {
      p_lock_key: key, p_resource_type: "pca", p_parametros: { ano: 2026 }, p_ano: 2026,
    }]]);
  }
});

Deno.test("PCA: trava de outro coletor conserva RPC e argumentos anteriores", async () => {
  const chamadas: unknown[] = [];
  const client = { schema: (_schema: string) => ({
    rpc: (name: string, args: unknown) => {
      chamadas.push([name, args]);
      return Promise.resolve({ data: { already_running: false, run_id: "novo" }, error: null });
    },
  }) };
  await acquireSyncLock(client as never, "editais:2026", "edital", {});
  assertEquals(chamadas, [["acquire_sync_lock", { p_lock_key: "editais:2026", p_resource_type: "edital", p_parametros: {} }]]);
});
