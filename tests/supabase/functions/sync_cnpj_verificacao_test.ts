// Spec specs/0008-verificacao-cnpj-brasilapi.md, entrega 1, CA-7: Edge Function sync-cnpj-verificacao.
// Só verificação local (RPC private.cnpj_verificacao_atualizar); nenhuma chamada HTTP externa nesta entrega.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/sync-cnpj-verificacao/index.ts";

function post(body: unknown = {}) {
  return new Request("https://x.supabase.co/functions/v1/sync-cnpj-verificacao", {
    method: "POST",
    headers: { Authorization: "Bearer segredo", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Garante que nenhum fetch externo acontece durante o teste. */
async function semFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("fetch externo não permitido nesta entrega"));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("CA-7: sem o segredo do cron responde 401 e não chama a RPC", async () => {
  let chamadas = 0;
  const res = await semFetch(() =>
    handleRequest(post(), {
      isCron: () => false,
      atualizar: () => {
        chamadas++;
        return Promise.resolve({ dv_invalido: 0, aguardando_consulta: 0, total: 0 });
      },
    })
  );
  assertEquals(res.status, 401);
  assertEquals(chamadas, 0);
});

Deno.test("CA-7: GET responde 405", async () => {
  const res = await handleRequest(new Request("https://x/functions/v1/sync-cnpj-verificacao"), {
    isCron: () => true,
    atualizar: () => Promise.reject(new Error("não deveria chamar")),
  });
  assertEquals(res.status, 405);
});

Deno.test("CA-7: com o segredo chama a RPC uma vez e devolve as contagens", async () => {
  let chamadas = 0;
  const res = await semFetch(() =>
    handleRequest(post(), {
      isCron: () => true,
      atualizar: () => {
        chamadas++;
        return Promise.resolve({ dv_invalido: 9, aguardando_consulta: 0, total: 9 });
      },
    })
  );
  assertEquals(res.status, 200);
  assertEquals(chamadas, 1);
  const body = await res.json();
  assertEquals(body.resultado, { dv_invalido: 9, aguardando_consulta: 0, total: 9 });
  assertEquals(body.consulta_externa, false);
});

Deno.test("CA-7: erro da RPC devolve 500 com mensagem, sem contagem", async () => {
  const res = await semFetch(() =>
    handleRequest(post(), {
      isCron: () => true,
      atualizar: () => Promise.reject(new Error("permission denied for function cnpj_verificacao_atualizar")),
    })
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assert(typeof body.error === "string" && body.error.length > 0);
  assertEquals(body.resultado, undefined);
});

Deno.test("CA-7: o cliente padrão chama private.cnpj_verificacao_atualizar com service_role", async () => {
  const src = await Deno.readTextFile(
    new URL("../../../supabase/functions/sync-cnpj-verificacao/index.ts", import.meta.url),
  );
  assert(src.includes('schema("private")'));
  assert(src.includes('rpc("cnpj_verificacao_atualizar")'));
  assert(src.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert(!/https?:\/\/(?!x\.)/.test(src.replace(/\/\/.*$/gm, "")), "nenhuma URL externa no código desta entrega");
});
