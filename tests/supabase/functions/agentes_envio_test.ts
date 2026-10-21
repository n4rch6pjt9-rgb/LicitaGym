// Spec 0035: envio da análise para a oportunidade e revisão só do que foi enviado (K-4 a K-6, K-15, R-6, R-8 a R-10).
import { assertEquals } from "jsr:@std/assert@1";
import { createSupabaseRepo, type Execucao } from "../../../supabase/functions/api-agentes/repo.ts";
import { ambiente, chamar, ctx, P } from "./agentes_fake.ts";

async function executado() {
  const amb = ambiente();
  const c = ctx(amb.repo);
  const r = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const id = (agente: string) => r.json.execucoes.find((e: Execucao) => e.agente === agente).id as number;
  return { ...amb, c, id };
}

Deno.test("CA-7: enviar grava enviada_em/enviada_por e liga a tarefa; segunda vez 409", async () => {
  const { c, id } = await executado();
  const a = await chamar(c, { action: "analise_enviar", execucao_id: id("edital") });
  assertEquals(a.status, 200);
  assertEquals([a.json.execucao.enviada_por, typeof a.json.execucao.enviada_em, a.json.execucao.tarefa_id], ["u-1", "string", 77]);
  const b = await chamar(c, { action: "analise_enviar", execucao_id: id("edital") });
  assertEquals([b.status, b.json.error], [409, "Esta análise já foi enviada."]);
});

Deno.test("R-8: sem tarefa aberta do agente, o envio funciona com tarefa_id nulo", async () => {
  const { c, id, semTarefa } = await executado();
  semTarefa();
  const a = await chamar(c, { action: "analise_enviar", execucao_id: id("juridico") });
  assertEquals([a.status, a.json.execucao.tarefa_id], [200, null]);
});

Deno.test("CA-8: execução desatualizada não é enviada (409)", async () => {
  const { c, id, dossie, execucoes } = await executado();
  dossie.documentos_sha256 = ["d1", "d2"];
  const r = await chamar(c, { action: "analise_enviar", execucao_id: id("edital") });
  assertEquals([r.status, r.json.error], [409, "Análise desatualizada. Execute de novo antes de enviar."]);
  assertEquals(execucoes.every((e) => e.enviada_em === null), true);
});

Deno.test("R-1: oportunidade fora do pipeline não envia nem revisa (404)", async () => {
  const { c, id, pipeline } = await executado();
  const e = id("edital");
  await chamar(c, { action: "analise_enviar", execucao_id: e });
  pipeline.clear();
  assertEquals((await chamar(c, { action: "analise_enviar", execucao_id: id("preco") })).status, 404);
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: e, decisao: "aprovada" })).status, 404);
});

Deno.test("CA-9: execução de outra empresa (ou inexistente) é 404", async () => {
  const { c, repo } = await executado();
  repo.obterExecucao = () => Promise.resolve(null);
  assertEquals((await chamar(c, { action: "analise_enviar", execucao_id: 1 })).status, 404);
});

Deno.test("CA-10 / CA-31: somente_enviadas traz a mais recente enviada, mesmo com uma mais nova não enviada", async () => {
  const { c, id } = await executado();
  const precoEnviado = id("preco");
  await chamar(c, { action: "analise_enviar", execucao_id: precoEnviado });
  // proposta nova grava preço e jurídico novos, não enviados
  await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }] });
  const todas = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
  assertEquals(todas.json.execucoes.find((e: Execucao) => e.agente === "preco").id === precoEnviado, false);
  const enviadas = await chamar(c, { action: "analise_obter", licitacao_id: 101, somente_enviadas: true });
  assertEquals(enviadas.json.execucoes.map((e: Execucao) => [e.agente, e.id]), [["preco", precoEnviado]]);
  assertEquals((await chamar(c, { action: "analise_obter", licitacao_id: 101, somente_enviadas: "sim" })).status, 400);
});

Deno.test("CA-11: execução não enviada não é revisada (409)", async () => {
  const { c, id } = await executado();
  const r = await chamar(c, { action: "analise_revisar", execucao_id: id("edital"), decisao: "aprovada" });
  assertEquals([r.status, r.json.error], [409, "Envie a análise para a oportunidade antes de revisar."]);
});

Deno.test("CA-30: rejeitada pode ser enviada de novo, volta a aguardando e guarda a revisão anterior", async () => {
  const { c, id } = await executado();
  const e = id("juridico");
  await chamar(c, { action: "analise_enviar", execucao_id: e });
  await chamar(c, { action: "analise_revisar", execucao_id: e, decisao: "rejeitada", nota: "Faltou o TR" });
  const r = await chamar(c, { action: "analise_enviar", execucao_id: e });
  assertEquals(r.status, 200);
  assertEquals([r.json.execucao.revisao, r.json.execucao.revisao_nota, r.json.execucao.revisoes_anteriores.length], ["aguardando", null, 1]);
  assertEquals([r.json.execucao.revisoes_anteriores[0].decisao, r.json.execucao.revisoes_anteriores[0].nota], ["rejeitada", "Faltou o TR"]);
  // aprovada não volta a ser enviada
  await chamar(c, { action: "analise_revisar", execucao_id: e, decisao: "aprovada" });
  assertEquals((await chamar(c, { action: "analise_enviar", execucao_id: e })).status, 409);
});

Deno.test("CA-28 (R-6): jurídico enviado num dia continua atual no dia seguinte", async () => {
  const { c, id } = await executado();
  const e = id("juridico");
  await chamar(c, { action: "analise_enviar", execucao_id: e });
  const OrigDate = Date;
  const amanha = new OrigDate(OrigDate.now() + 36 * 3600 * 1000);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Date = class extends OrigDate {
    // deno-lint-ignore no-explicit-any
    constructor(...args: any[]) {
      // deno-lint-ignore no-explicit-any
      super(...(args.length ? args : [amanha.getTime()]) as [any]);
    }
    static override now() {
      return amanha.getTime();
    }
  };
  try {
    const r = await chamar(c, { action: "analise_revisar", execucao_id: e, decisao: "aprovada" });
    assertEquals(r.status, 200);
    // o preço, que depende da data de referência, fica desatualizado no dia seguinte
    const o = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
    assertEquals(o.json.execucoes.map((x: { agente: string; desatualizada: boolean }) => [x.agente, x.desatualizada]), [
      ["edital", false],
      ["preco", true],
      ["juridico", false],
    ]);
  } finally {
    globalThis.Date = OrigDate;
  }
});

Deno.test("repo real: LG003 do envio vira 409 e P0002 vira 404; a execução volta com os campos do envio", async () => {
  const cliente = (resp: { data: unknown; error: unknown }) =>
    ({ rpc: (nome: string) => (assertEquals(nome, "agente_execucao_enviar"), Promise.resolve(resp)) }) as unknown as Parameters<
      typeof createSupabaseRepo
    >[0];
  for (const [code, status] of [["LG003", 409], ["P0002", 404]] as const) {
    const e = await createSupabaseRepo(cliente({ data: null, error: { code, message: "x" } })).enviar(1, 2, "u").then(() => null, (x) => x);
    assertEquals(e?.status, status, code);
  }
  const linha = {
    id: 2, licitacao_id: 101, agente: "edital", situacao: "ok", contexto_hash: "h", regra_versao: "r", entrada: {}, achados: [],
    revisao: "aguardando", solicitado_por: "u", created_at: "t", enviada_em: "2026-10-21T12:00:00Z", enviada_por: "u", tarefa_id: "9",
    revisoes_anteriores: [],
  };
  const x = await createSupabaseRepo(cliente({ data: [linha], error: null })).enviar(1, 2, "u");
  assertEquals([x.enviada_em, x.tarefa_id, x.revisoes_anteriores], ["2026-10-21T12:00:00Z", 9, []]);
});
