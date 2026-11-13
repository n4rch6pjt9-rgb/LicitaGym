// GET api-pncp-pca sem visao: exige login (401 sem token, sem tocar no banco) e não devolve a mensagem do Postgres.
import { assertEquals } from "jsr:@std/assert@1";
import { ERRO_LISTA, responderLista } from "../../../supabase/functions/api-pncp-pca/lista.ts";
import { requireUserAuth } from "../../../supabase/functions/_shared/http.ts";

type Resp = { data: unknown; error: { message: string } | null; count: number | null };

function clienteFalso(resp: Resp) {
  const chamadas: string[] = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    order: () => q,
    range: () => Promise.resolve(resp),
  };
  return { chamadas, client: { from: (t: string) => (chamadas.push(t), q) } as never };
}

const URL_LISTA = new URL("https://x.test/functions/v1/api-pncp-pca?ano=2026");

Deno.test("lista sem token responde 401 e não consulta o banco", async () => {
  const falso = clienteFalso({ data: [], error: null, count: 0 });
  const req = new Request(URL_LISTA);
  const res = await responderLista(req, URL_LISTA, {
    requireAuth: (r) => requireUserAuth(r, () => Promise.resolve(null)),
    criarCliente: () => falso.client,
  });
  assertEquals(res.status, 401);
  assertEquals(falso.chamadas.length, 0);
});

Deno.test("lista: erro do banco vira 502 com mensagem genérica, sem o texto do Postgres", async () => {
  const falso = clienteFalso({ data: null, error: { message: "permission denied for table pca_planos" }, count: null });
  const res = await responderLista(new Request(URL_LISTA), URL_LISTA, {
    requireAuth: () => Promise.resolve(null),
    criarCliente: () => falso.client,
  });
  assertEquals(res.status, 502);
  const corpo = await res.json();
  assertEquals(corpo.error, ERRO_LISTA);
  assertEquals(JSON.stringify(corpo).includes("permission denied"), false);
});

Deno.test("lista autenticada devolve os planos com paginação", async () => {
  const falso = clienteFalso({ data: [{ id: "p1" }], error: null, count: 1 });
  const res = await responderLista(new Request(URL_LISTA), URL_LISTA, {
    requireAuth: () => Promise.resolve(null),
    criarCliente: () => falso.client,
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { data: [{ id: "p1" }], page: 1, limit: 20, total: 1 });
  assertEquals(falso.chamadas, ["pca_planos"]);
});
