import { assert, assertEquals } from "jsr:@std/assert@1";
import { linhaHistorico, montarHistorico } from "../../../supabase/functions/api-pncp-pca/historico.ts";
import { ERRO_HISTORICO, responderHistorico } from "../../../supabase/functions/api-pncp-pca/historico-rota.ts";

const linha = {
  orgao_cnpj: "10729992000146",
  orgao_nome: "IFSul",
  uf: "RS",
  ano_exercicio: 2024,
  classes_presentes: ["7830"],
  planos: 1,
  itens: 2,
  itens_sem_valor: 0,
  valor_planejado: 100,
  unidades: ["158126"],
  compras_escopo_observadas: 1,
  valor_escopo_observado: 40,
  execucoes_confirmadas: 0,
  lag_medio_dias: null,
  lag_soma_dias: null,
  lag_n: 0,
};

Deno.test("histórico separa planejado de execução e deixa 2026 aberto", () => {
  const montado = montarHistorico([
    linha,
    { ...linha, ano_exercicio: 2026, valor_planejado: null, compras_escopo_observadas: 3, valor_escopo_observado: null, execucoes_confirmadas: 2, lag_medio_dias: 10 },
  ], 2026);

  assertEquals(montado.orgaos.length, 1);
  const orgao = montado.orgaos[0];
  assertEquals(orgao.valor_planejado, 100);
  assertEquals(orgao.compras_escopo_observadas, 4);
  assertEquals(orgao.execucoes_confirmadas, 0);
  assertEquals(orgao.lag_medio_dias, null);
  assertEquals(orgao.anos[1].exercicio_aberto, true);
  assertEquals(orgao.anos[1].execucoes_confirmadas, 2);
  assertEquals(montado.por_uf[0].uf, "RS");
  assertEquals(montado.por_uf[0].valor_planejado, 100);
});

Deno.test("linhaHistorico lê classes_presentes e os campos de escopo da função", () => {
  const l = linhaHistorico({
    orgao_cnpj: "10729992000146",
    ano_exercicio: "2025",
    classes_presentes: ["7220", "7830", null],
    compras_escopo_observadas: "2",
    valor_escopo_observado: "10.5",
  });
  assertEquals(l?.classes_presentes, ["7220", "7830"]);
  assertEquals([l?.compras_escopo_observadas, l?.valor_escopo_observado], [2, 10.5]);
});

Deno.test("prazo do órgão pondera por item, não pela média de cada ano", () => {
  const montado = montarHistorico([
    { ...linha, ano_exercicio: 2024, lag_medio_dias: 10, lag_soma_dias: 10, lag_n: 1 },
    { ...linha, ano_exercicio: 2025, lag_medio_dias: 100, lag_soma_dias: 900, lag_n: 9 },
  ], 2026);
  const orgao = montado.orgaos[0];
  assertEquals(orgao.lag_medio_dias, 91);
  assertEquals(orgao.anos.map((a) => a.lag_medio_dias), [10, 100]);
});

Deno.test("somas de valor arredondam a centavos", () => {
  const outro = { ...linha, orgao_cnpj: "00000000000191", uf: "RS" };
  const montado = montarHistorico([
    { ...linha, ano_exercicio: 2024, valor_planejado: 0.1, valor_escopo_observado: 0.1 },
    { ...linha, ano_exercicio: 2025, valor_planejado: 0.2, valor_escopo_observado: 0.2 },
    { ...outro, ano_exercicio: 2024, valor_planejado: 0.1 },
  ], 2026);
  const orgao = montado.orgaos.find((o) => o.cnpj === linha.orgao_cnpj)!;
  assertEquals(orgao.valor_planejado, 0.3);
  assertEquals(orgao.valor_escopo_observado, 0.3);
  assertEquals(montado.por_uf[0].valor_planejado, 0.4);
});

Deno.test("linha repetida de (CNPJ, ano) não soma de novo", () => {
  const montado = montarHistorico([linha, { ...linha }, { ...linha, ano_exercicio: 2025 }], 2026);
  const orgao = montado.orgaos[0];
  assertEquals(orgao.anos.length, 2);
  assertEquals(orgao.valor_planejado, 200);
  assertEquals(orgao.compras_escopo_observadas, 2);
});

// Cliente falso: catálogo (schema private) e RPC paginada do histórico.
function clienteFalso(o: { catalogo?: string[]; erroCatalogo?: unknown; linhas?: unknown[]; erroRpc?: unknown }) {
  const rpcLista = () => {
    const q = {
      select: () => q,
      order: () => q,
      range: () => Promise.resolve({ data: o.erroRpc ? null : o.linhas ?? [], error: o.erroRpc ?? null }),
    };
    return q;
  };
  return {
    schema: () => ({
      rpc: () => Promise.resolve({ data: o.erroCatalogo ? null : o.catalogo ?? [], error: o.erroCatalogo ?? null }),
    }),
    rpc: rpcLista,
  } as never;
}

async function chamar(cliente: unknown, query = "") {
  const original = console.error;
  const logs: unknown[] = [];
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    const res = await responderHistorico(
      new Request(`https://x.test/?visao=historico${query}`),
      new URL(`https://x.test/?visao=historico${query}`),
      { requireAuth: () => Promise.resolve(null), criarCliente: () => cliente as never, anoAberto: 2026 },
    );
    return { status: res.status, body: await res.json(), logs: JSON.stringify(logs) };
  } finally {
    console.error = original;
  }
}

Deno.test("erro da RPC do histórico vira 502 genérico; o detalhe fica no log", async () => {
  const r = await chamar(clienteFalso({ catalogo: ["7830"], erroRpc: { message: "column x does not exist", hint: "segredo" } }));
  assertEquals(r.status, 502);
  assertEquals(r.body, { error: ERRO_HISTORICO });
  assert(r.logs.includes("column x does not exist"));
});

Deno.test("erro ao ler o catálogo vira 502 genérico", async () => {
  const r = await chamar(clienteFalso({ erroCatalogo: { message: "permission denied for schema private" } }));
  assertEquals(r.status, 502);
  assertEquals(r.body, { error: ERRO_HISTORICO });
  assert(r.logs.includes("permission denied"));
});

Deno.test("validação das classes continua 400/409", async () => {
  assertEquals((await chamar(clienteFalso({ catalogo: [] }))).status, 409);
  assertEquals((await chamar(clienteFalso({ catalogo: ["7830"] }), "&classes=6515")).status, 400);
});

Deno.test("rota monta o histórico com as linhas da RPC", async () => {
  const r = await chamar(clienteFalso({ catalogo: ["7830"], linhas: [linha, linha] }));
  assertEquals(r.status, 200);
  assertEquals(r.body.orgaos.length, 1);
  assertEquals(r.body.orgaos[0].valor_planejado, 100);
  assertEquals(r.body.origem_classes, "catalogo_catmat");
});
