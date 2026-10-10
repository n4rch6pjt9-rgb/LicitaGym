import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  ARGS_DIARIO,
  JOB,
  SEGREDO_VAULT,
  corpoEnfileirar,
  enfileirar,
  registroCron,
  urlEnfileirar,
  type PedidoHttp,
} from "../../../../../supabase/functions/_shared/coletor/enfileirar-sestsenat.ts";

const CHAVE = "chave-de-teste-nao-e-segredo";
const EXECUCAO =
  "projects/licitagym/locations/southamerica-east1/operations/op-1";

Deno.test("enfileirar: sem segredo não chama token nem o Cloud Run", async () => {
  let chamadas = 0;
  await assertRejects(
    () =>
      enfileirar({
        chave: "  ",
        obterToken: () => {
          chamadas += 1;
          return Promise.resolve("token");
        },
        http: () => {
          chamadas += 1;
          return Promise.resolve({ status: 200, body: "{}" });
        },
      }),
    Error,
    SEGREDO_VAULT,
  );
  assertEquals(chamadas, 0);
});

Deno.test("enfileirar: POST :run devolve o name e não espera a coleta", async () => {
  const pedidos: PedidoHttp[] = [];
  const resultado = await enfileirar({
    chave: CHAVE,
    obterToken: (chave) => {
      assertEquals(chave, CHAVE);
      return Promise.resolve("token-curto");
    },
    http: (pedido) => {
      pedidos.push(pedido);
      return Promise.resolve({
        status: 200,
        body: JSON.stringify({ name: EXECUCAO }),
      });
    },
  });
  assertEquals(pedidos.length, 1);
  assertEquals(pedidos[0].method, "POST");
  assertEquals(pedidos[0].url, urlEnfileirar());
  assert(pedidos[0].url.endsWith(`/${JOB}:run`));
  assertEquals(pedidos[0].headers.Authorization, "Bearer token-curto");
  assertEquals(JSON.parse(pedidos[0].body), corpoEnfileirar());
  assertEquals(resultado.execucao, EXECUCAO);
  assertEquals(pedidos[0].body.includes(CHAVE), false);
  assertEquals(pedidos[0].body.includes("private_key"), false);
});

Deno.test("enfileirar: o registro do cron não carrega a chave e pede o escopo diário", () => {
  const registro = registroCron();
  const texto = JSON.stringify(registro);
  assertEquals(registro.segredo, SEGREDO_VAULT);
  assertEquals(registro.args, [...ARGS_DIARIO]);
  assertEquals(texto.includes("--todos"), true);
  assertEquals(texto.includes("fitness"), true);
  assertEquals(texto.includes("--anos"), false);
  assertEquals(texto.includes(CHAVE), false);
  assertEquals(texto.includes("private_key"), false);
  assertEquals(texto.includes("BEGIN PRIVATE"), false);
});

Deno.test("enfileirar: HTTP de erro não vira execução", async () => {
  await assertRejects(
    () =>
      enfileirar({
        chave: CHAVE,
        obterToken: () => Promise.resolve("token-curto"),
        http: () => Promise.resolve({ status: 403, body: "{}" }),
      }),
    Error,
    "HTTP 403",
  );
});

Deno.test("enfileirar: duas chamadas iguais mandam o mesmo corpo", async () => {
  const corpos: string[] = [];
  const uma = () =>
    enfileirar({
      chave: CHAVE,
      obterToken: () => Promise.resolve("token-curto"),
      http: (pedido) => {
        corpos.push(pedido.body);
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ name: EXECUCAO }),
        });
      },
    });
  await uma();
  await uma();
  assertEquals(corpos[0], corpos[1]);
});
