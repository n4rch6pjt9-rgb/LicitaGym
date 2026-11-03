import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/discover-piso-pdm/index.ts";

const URL_FN = "http://localhost/functions/v1/discover-piso-pdm?termo=piso&limite=5";

function fetchContado() {
  const chamadas: string[] = [];
  const fn = ((input: string | URL | Request) => {
    chamadas.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(new Response("indisponível", { status: 503 }));
  }) as typeof fetch;
  return { fn, chamadas };
}

Deno.test("discover-piso-pdm: sem sessão de usuário responde 401 e não chama o site externo", async () => {
  const { fn, chamadas } = fetchContado();
  const res = await handleRequest(new Request(URL_FN), { getUser: () => Promise.resolve(null), fetchFn: fn });
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
  assertEquals(chamadas, []);
});

Deno.test("discover-piso-pdm: sem Authorization o autenticador padrão recusa (fail-closed)", async () => {
  const { fn, chamadas } = fetchContado();
  const res = await handleRequest(new Request(URL_FN), { fetchFn: fn });
  assertEquals(res.status, 401);
  assertEquals(chamadas, []);
});

Deno.test("discover-piso-pdm: preflight OPTIONS segue sem autenticação", async () => {
  const res = await handleRequest(new Request(URL_FN, { method: "OPTIONS" }), { getUser: () => Promise.resolve(null) });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("discover-piso-pdm: usuário logado recebe a resposta e o limite fica entre 1 e 100", async () => {
  const { fn, chamadas } = fetchContado();
  const res = await handleRequest(
    new Request("http://localhost/functions/v1/discover-piso-pdm?termo=piso&limite=99999"),
    { getUser: () => Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }), fetchFn: fn },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.sucesso, true);
  assertEquals(new URL(chamadas[0]).searchParams.get("limit"), "100");
});
