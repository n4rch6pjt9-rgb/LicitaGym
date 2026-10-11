// link-pca-edital: dry_run percorre o mesmo casamento do real (código e janela de PDM) e só não grava.
// PostgREST falso: cada consulta registra os filtros e devolve as linhas da fixture por tabela.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ERRO_LINK,
  executarLink,
  falhaLink,
  type LinkOpcoes,
} from "../../../supabase/functions/link-pca-edital/casamento.ts";

type Filtros = Record<string, unknown>;
type Resolver = (tabela: string, filtros: Filtros) => { data: unknown; error?: unknown };

function criarFake(resolver: Resolver) {
  const gravacoes: Array<{ tabela: string; valores: unknown; filtros: Filtros }> = [];
  function from(tabela: string) {
    const filtros: Filtros = {};
    let valores: unknown = null;
    const q = {
      select() { return q; },
      eq(col: string, v: unknown) { filtros[`eq:${col}`] = v; return q; },
      is(col: string, v: unknown) { filtros[`is:${col}`] = v; return q; },
      not(col: string, op: string, v: unknown) { filtros[`not:${col}`] = [op, v]; return q; },
      in(col: string, v: unknown[]) { filtros[`in:${col}`] = v; return q; },
      order() { return q; },
      limit() { return q; },
      update(v: unknown) { valores = v; return q; },
      then(ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) {
        if (valores != null) {
          gravacoes.push({ tabela, valores, filtros });
          return Promise.resolve({ data: null, error: null }).then(ok, falha);
        }
        const r = resolver(tabela, filtros);
        return Promise.resolve({ data: r.data, error: r.error ?? null }).then(ok, falha);
      },
    };
    return q;
  }
  return { client: { from } as never, gravacoes };
}

// Edital 1: casa por código com o plano P1. Compra 77: casa por PDM na janela com o plano P2.
// Edital 2: dois planos pelo código (ambíguo, não decide).
const PLANO = (id: string, ano = 2026) => ({ id, orgao_cnpj: "11.111.111/0001-11", ano_exercicio: ano, ativo: true });
const resolver: Resolver = (tabela, f) => {
  switch (tabela) {
    case "contratacoes_editais":
      return {
        data: [
          { id: "e1", orgao_cnpj: "11111111000111", ano: 2026, data_publicacao: "2026-05-01T10:00:00Z" },
          { id: "e2", orgao_cnpj: "11111111000111", ano: 2026, data_publicacao: "2026-05-02T10:00:00Z" },
        ],
      };
    case "contratacoes_itens":
      return { data: f["eq:origem_id"] === "e1" ? [{ codigo_material_servico: "400100" }] : [{ codigo_material_servico: "400200" }] };
    case "pca_itens":
      if (f["in:codigo_item_origem"]) {
        const cod = (f["in:codigo_item_origem"] as string[])[0];
        if (cod === "400100") return { data: [{ id: "i1", codigo_item_origem: "400100", pca_planos: PLANO("P1") }] };
        if (cod === "400200") {
          return {
            data: [
              { id: "i2", codigo_item_origem: "400200", pca_planos: PLANO("P1") },
              { id: "i3", codigo_item_origem: "400200", pca_planos: PLANO("P3", 2025) },
            ],
          };
        }
        return { data: [] };
      }
      // fallback PDM: só o plano P2 tem item confirmado na classe pedida
      if (f["eq:pca_plano_id"] === "P2" && (f["in:classe_material_servico"] as string[]).includes("7830")) {
        return {
          data: [{
            id: "i9",
            data_prevista_contratacao: "2026-06-01",
            classe_material_servico: "7830",
            pca_item_pdm: [{ confirmado: true, codigo_pdm: 1234 }],
          }],
        };
      }
      return { data: [] };
    case "pca_planos":
      return { data: f["eq:orgao_cnpj"] === "22222222000122" ? [{ id: "P2", ano_exercicio: 2026 }] : [] };
    case "licitacoes_externas":
      return { data: [{ id: 77, orgao_cnpj: "22.222.222/0001-22", data_publicacao: "2026-06-10T12:00:00Z" }] };
    case "licitacao_itens":
      return { data: [] };
    case "licitacao_match":
      return { data: [{ codigo_pdm: 1234 }] };
    default:
      throw new Error(`tabela inesperada ${tabela}`);
  }
};

const OPCOES: Omit<LinkOpcoes, "dryRun"> = { janelaDias: 90, limite: 500, classes: ["7830"] };

Deno.test("dry_run e real chegam às mesmas decisões e contagens; dry_run não grava", async () => {
  const seco = criarFake(resolver);
  const real = criarFake(resolver);
  const a = await executarLink(seco.client, { ...OPCOES, dryRun: true });
  const b = await executarLink(real.client, { ...OPCOES, dryRun: false });

  assertEquals(a.decisions, b.decisions);
  assertEquals({ ...a.stats, dry_run: false }, b.stats);
  assertEquals(a.stats.candidatos_codigo, 3);
  assertEquals(a.stats.candidatos_pdm_janela, 1);
  assertEquals(a.stats.ambiguos, 1);
  assertEquals([a.stats.vinculados, a.stats.vinculados_externas], [1, 1]);
  assertEquals(a.stats.dry_run, true);

  assertEquals(seco.gravacoes.length, 0);
  assertEquals(real.gravacoes.map((g) => [g.tabela, g.filtros["eq:id"]]), [
    ["contratacoes_editais", "e1"],
    ["licitacoes_externas", 77],
  ]);
});

Deno.test("dry_run usa as classes pedidas no fallback PDM", async () => {
  const fake = criarFake(resolver);
  const r = await executarLink(fake.client, { ...OPCOES, classes: ["7220"], dryRun: true });
  assertEquals(r.stats.candidatos_pdm_janela, 0);
  assertEquals(r.stats.vinculados_externas, 0);
});

Deno.test("erro de leitura propaga (não vira zero) e a resposta não leva o detalhe do banco", async () => {
  const fake = criarFake((tabela, f) =>
    tabela === "contratacoes_editais" ? { data: null, error: { message: "relation x does not exist" } } : resolver(tabela, f)
  );
  let erro: unknown = null;
  try {
    await executarLink(fake.client, { ...OPCOES, dryRun: true });
  } catch (e) {
    erro = e;
  }
  assert(erro instanceof Error);

  const original = console.error;
  const logs: unknown[] = [];
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    const res = falhaLink("leitura", erro);
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body, { error: ERRO_LINK });
    assert(JSON.stringify(logs).includes("relation x does not exist"));
  } finally {
    console.error = original;
  }
});
