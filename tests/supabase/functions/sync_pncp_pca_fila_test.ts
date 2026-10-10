// Spec 0012, PR 2: fila de planos (descoberta pela consulta, itens pela integração por plano).
// CA-3 (mesmo hash consulta × integração, com item real), CA-5/CA-6 (descoberta e enfileiramento), CA-7 (orçamento e
// status da execução), CA-8 (inativação por plano; erro não inativa), CA-10 (ausente).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import {
  descobrirPlanos,
  enfileirarDescobertos,
  itemIntegracaoParaConsulta,
  lerItensPlano,
  planoDaConsulta,
  processarFila,
  TAMANHO_PAGINA_INTEGRACAO,
  tratarAusentes,
} from "../../../supabase/functions/_shared/pncp/pca-fila.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
import { normalizePcaItem } from "../../../supabase/functions/_shared/pncp/normalize.ts";
import { hashPayload } from "../../../supabase/functions/_shared/pncp/hash.ts";
import { handleRotinaFila } from "../../../supabase/functions/sync-pncp-pca/rotina-fila.ts";

type Row = Record<string, unknown>;
const RUN = "00000000-0000-0000-0000-000000000001";
const CNPJ = "99000001000101";
const ID = `${CNPJ}-0-000004/2026`;
const ANO = 2026;

/** Cabeçalho de plano no formato da consulta /pca/ (valores fictícios). */
function cabecalho(id = ID, data = "2026-09-21T11:31:57"): Row {
  return {
    codigoUnidade: "999001",
    nomeUnidade: "Unidade de teste",
    anoPca: ANO,
    orgaoEntidadeCnpj: id.slice(0, 14),
    idPcaPncp: id,
    dataPublicacaoPNCP: "2025-04-29T08:19:54",
    dataAtualizacaoGlobalPCA: data,
    orgaoEntidadeRazaoSocial: "Órgão de teste",
  };
}

/** Item no formato da integração (nomes do OpenAPI de 09/10/2026; valores fictícios). */
function itemIntegracao(n: number, classe = "7830", valor = 100): Row {
  return {
    nomeClassificacao: "Material",
    descricao: `Item ${n}`,
    numeroItem: n,
    valorTotal: valor * 3,
    pdmCodigo: "2640",
    codigoItem: "480144",
    classificacaoSuperiorCodigo: classe,
    unidadeFornecimento: "UN",
    quantidade: 3,
    valorUnitario: valor,
    dataDesejada: "2026-11-10",
    classificacaoCatalogoId: 1,
    categoriaItemPcaNome: "Material",
  };
}

const itemConsulta = (n: number, classe = "7830") => itemIntegracaoParaConsulta(itemIntegracao(n, classe));

/** Simula as funções SQL das migrations (comportamento coberto também por pca_plano_fila_check.sql). */
function banco(): FakePostgrest {
  const db = new FakePostgrest({
    catmat_pdms: [{ codigo_pdm: 2640 }],
    catalogo_itens: [{ id: "cat-1", codigo_catmat: "480144" }],
  });
  let seq = 0;
  db.rpcs.pca_fila_enfileirar = (args, d) => {
    const fila = d.rows("pca_plano_fila");
    let n = 0;
    for (const it of args.p_itens as Row[]) {
      const aberto = fila.find((f) =>
        f.id_pca_pncp === it.id_pca_pncp && ["pendente", "processando", "erro"].includes(String(f.status))
      );
      if (aberto) {
        Object.assign(aberto, { ...it, plano: it.plano ?? aberto.plano });
        if (aberto.status !== "processando") aberto.status = "pendente";
      } else {
        fila.push({ id: ++seq, status: "pendente", tentativas: 0, ...it });
      }
      n++;
    }
    return n;
  };
  db.rpcs.pca_fila_reservar = (args, d) => {
    const agora = Date.now();
    const fila = d.rows("pca_plano_fila")
      .filter((f) => args.p_ano == null || f.ano === args.p_ano)
      .filter((f) =>
        f.status === "pendente" ||
        (f.status === "erro" && Number(f.tentativas) < 5 &&
          Date.parse(String(f.atualizado_em ?? 0)) < agora - 10 * 60_000)
      )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, Number(args.p_limite));
    for (const f of fila) f.status = "processando";
    return fila.map((f) => ({ ...f }));
  };
  db.rpcs.pca_marcar_descoberta = (args, d) => {
    const vistos = new Set(args.p_vistos as string[]);
    for (const p of d.rows("pca_planos")) {
      if (p.ano_exercicio !== args.p_ano) continue;
      p.descoberta_ausente_seguidas = vistos.has(String(p.id_pca_pncp))
        ? 0
        : Number(p.descoberta_ausente_seguidas ?? 0) + (p.ativo !== false ? 1 : 0);
    }
    return d.rows("pca_planos").filter((p) => p.ativo !== false && Number(p.descoberta_ausente_seguidas) >= 2).length;
  };
  // private.acquire_sync_lock: novo run 'executando'; herda a continuation do último 'incompleta' do mesmo lock.
  let runSeq = 0;
  db.rpcs.acquire_sync_lock = (args, d) => {
    const runs = d.rows("pncp_sync_run");
    if (runs.some((r) => r.lock_key === args.p_lock_key && r.status === "executando")) {
      return { already_running: true, run_id: "ocupado" };
    }
    const anterior = runs.filter((r) => r.lock_key === args.p_lock_key && r.status === "incompleta").pop();
    if (anterior) anterior.status = "retomada";
    const id = `00000000-0000-0000-0000-00000000010${++runSeq}`;
    runs.push({ id, lock_key: args.p_lock_key, status: "executando", parametros: args.p_parametros });
    return {
      already_running: false,
      run_id: id,
      continuation: (anterior?.parametros as Row | undefined)?.continuation ?? null,
    };
  };
  return db;
}

function integracaoFake(porPlano: Record<string, Row[] | { status: number; body: unknown }>, quantidade?: number) {
  const chamadas: string[] = [];
  return {
    chamadas,
    getPcaItensPagina(cnpj: string, ano: number, seq: number, pagina: number, tamanho: number) {
      chamadas.push(`${cnpj}/${ano}/${seq}/${pagina}`);
      const tudo = porPlano[`${cnpj}/${ano}/${seq}`];
      if (!Array.isArray(tudo)) return Promise.resolve(tudo);
      const pag = tudo.slice((pagina - 1) * tamanho, pagina * tamanho);
      return Promise.resolve(pag.length ? { status: 200, body: pag } : { status: 204, body: null });
    },
    getPcaItensQuantidade(cnpj: string, ano: number, seq: number) {
      const tudo = porPlano[`${cnpj}/${ano}/${seq}`];
      return Promise.resolve({ status: 200, body: quantidade ?? (Array.isArray(tudo) ? tudo.length : 0) });
    },
  };
}

function consultaFake(paginas: Row[]) {
  const chamadas: number[] = [];
  return {
    chamadas,
    fetchPcaPage: (_a: number, p: number) => {
      chamadas.push(p);
      return Promise.resolve({ status: 200, body: paginas[p - 1] });
    },
  };
}

const nunca = () => false;
const enfileirarPlano = (db: FakePostgrest, id = ID, seq = 4, extra: Row = {}) =>
  db.rpcs.pca_fila_enfileirar({
    p_itens: [{
      id_pca_pncp: id,
      orgao_cnpj: CNPJ,
      ano: ANO,
      sequencial: seq,
      motivo: "alterado",
      plano: cabecalho(id),
      classes: ["7830"],
      ...extra,
    }],
  }, db);

Deno.test("planoDaConsulta: separa CNPJ, sequencial e ano e tira os itens do cabeçalho", () => {
  const p = planoDaConsulta({ ...cabecalho(), itens: [itemConsulta(1)] })!;
  assertEquals([p.orgao_cnpj, p.sequencial, p.ano], [CNPJ, 4, ANO]);
  assertEquals("itens" in p.plano, false);
  assertEquals(planoDaConsulta({ idPcaPncp: "lixo" }), null);
});

Deno.test("CA-3: item real do Galeão (399) normaliza igual pela integração e pela consulta (mesmo hash)", async () => {
  const fx = JSON.parse(
    await Deno.readTextFile(new URL("../fixtures/pncp/pca_item_galeao_399.json", import.meta.url)),
  );
  const a = normalizePcaItem(itemIntegracaoParaConsulta(fx.integracao), {});
  const b = normalizePcaItem(fx.consulta, {});
  assertEquals(a, b);
  assertEquals(await hashPayload({ ...a, pca_plano_id: "x" }), await hashPayload({ ...b, pca_plano_id: "x" }));
});

Deno.test("CA-5: descoberta junta planos repetidos entre páginas e conta linhas e pares distintos", async () => {
  const consulta = consultaFake([
    { data: [{ ...cabecalho(), itens: [itemConsulta(1), itemConsulta(2)] }], paginasRestantes: 1 },
    { data: [{ ...cabecalho(), itens: [itemConsulta(2), itemConsulta(3)] }], paginasRestantes: 0 },
  ]);
  const d = await descobrirPlanos(consulta, { ano: ANO, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  assertEquals([d.completo, d.retomar_de, d.planos.size, d.paginas, d.linhas, d.pares_distintos], [
    true,
    null,
    1,
    2,
    4,
    3,
  ]);
});

Deno.test("descoberta: envelope inválido deixa incompleta, com os planos lidos e onde retomar", async () => {
  const consulta = consultaFake([{ data: [cabecalho()], paginasRestantes: 2 }, {}]);
  const d = await descobrirPlanos(consulta, { ano: ANO, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  assertEquals([d.completo, d.planos.size, d.retomar_de], [false, 1, { classe_idx: 0, pagina: 2 }]);
  assert(d.erro?.includes("envelope"));
});

Deno.test("descoberta retomada do meio não conta como completa (não mexe no contador de ausência)", async () => {
  const consulta = consultaFake([{}, { data: [cabecalho()], paginasRestantes: 0 }]);
  const d = await descobrirPlanos(consulta, {
    ano: ANO,
    classes: ["7830"],
    tamanhoPagina: 500,
    prazoEsgotado: nunca,
    inicio: { classe_idx: 0, pagina: 2 },
  });
  assertEquals([d.completo, d.retomar_de, consulta.chamadas], [false, null, [2]]);
});

Deno.test("CA-6: incremental enfileira novo, alterado e inativo; não enfileira o que não mudou", async () => {
  const db = banco();
  for (const [id, data, ativo] of [
    [`${CNPJ}-0-000001/2026`, "2026-09-21T11:31:57+00:00", true], // igual → não entra
    [`${CNPJ}-0-000002/2026`, "2026-09-01T00:00:00+00:00", true], // fonte mais nova → alterado
    [`${CNPJ}-0-000003/2026`, "2026-09-21T11:31:57+00:00", false], // inativo → alterado
  ] as [string, string, boolean][]) {
    db.rows("pca_planos").push({ id: `pl-${id}`, id_pca_pncp: id, data_atualizacao_origem: data, ativo });
  }
  const consulta = consultaFake([{
    data: [1, 2, 3, 4].map((s) => cabecalho(`${CNPJ}-0-00000${s}/2026`)),
    paginasRestantes: 0,
  }]);
  const d = await descobrirPlanos(consulta, { ano: ANO, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  const r = await enfileirarDescobertos(db as never, d, "incremental", { chainId: RUN, classes: ["7830"] });
  assertEquals([r.novos, r.alterados, r.sem_mudanca, r.enfileirados], [1, 2, 1, 3]);
  assertEquals(db.rows("pca_plano_fila").map((f) => f.motivo).sort(), ["alterado", "alterado", "novo"]);
  assert(db.rows("pca_plano_fila").every((f) => JSON.stringify(f.classes) === '["7830"]'));

  const b = await enfileirarDescobertos(db as never, d, "backfill", { chainId: RUN, classes: ["7830"] });
  assertEquals(b.enfileirados, 4);
  assertEquals(db.rows("pca_plano_fila").length, 4); // reenfileirar atualiza a linha aberta, não duplica
});

Deno.test("CA-8: carga grava só o escopo, inativa o item que sumiu e marca o plano feito", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(412), itemConsulta(413)] }], {
    ano: ANO,
    runId: "run-0",
  });
  enfileirarPlano(db);
  const integ = integracaoFake({
    [`${CNPJ}/2026/4`]: [itemIntegracao(412), itemIntegracao(414), itemIntegracao(900, "6505")],
  });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_erro, s.itens_inativados, s.erros], [1, 0, 1, 0]);
  const itens = db.rows("pca_itens");
  assertEquals(itens.find((r) => r.numero_item === 413)?.ativo, false);
  assertEquals(itens.find((r) => r.numero_item === 414)?.ativo, true);
  assertEquals(itens.some((r) => r.numero_item === 900), false);
  assertEquals(db.rows("pca_plano_fila")[0].status, "feito");
});

Deno.test("CA-8: item inativado que volta alterado é reativado", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(413)] }], { ano: ANO, runId: "r0" });
  db.rows("pca_itens")[0].ativo = false;
  enfileirarPlano(db);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(413, "7830", 999)] });
  await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  const it = db.rows("pca_itens")[0];
  assertEquals([it.ativo, it.valor_unitario_estimado], [true, 999]);
});

Deno.test("CA-8: resposta inválida, 404 ou total que não fecha com a quantidade não inativam nada", async () => {
  const casos: [string, ReturnType<typeof integracaoFake>][] = [
    ["resposta não é lista", integracaoFake({ [`${CNPJ}/2026/4`]: { status: 200, body: { message: "x" } } })],
    ["HTTP 404", integracaoFake({ [`${CNPJ}/2026/4`]: { status: 404, body: { message: "Not Found" } } })],
    ["leitura menor que a quantidade", integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(412)] }, 2)],
  ];
  for (const [nome, integ] of casos) {
    const db = banco();
    await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(413)] }], { ano: ANO, runId: "r" });
    enfileirarPlano(db);
    const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
    assertEquals([s.planos_erro, s.itens_inativados], [1, 0], nome);
    assertEquals(db.rows("pca_itens").every((r) => r.ativo !== false), true, nome);
    const f = db.rows("pca_plano_fila")[0];
    assertEquals([f.status, f.tentativas], ["erro", 1], nome);
  }
});

Deno.test("CA-8: erro na gravação marca o plano para reprocessar (data e hash zerados)", async () => {
  const db = banco();
  enfileirarPlano(db);
  db.falhaLinha = (t, row) => t === "pca_itens" && row.numero_item === 1;
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_erro, 1);
  const plano = db.rows("pca_planos")[0];
  assertEquals([plano.data_atualizacao_origem, plano.payload_hash], [null, "reprocessar"]);
});

Deno.test("CA-7: limite de 2 planos com 5 na fila processa 2 e deixa 3 pendentes, sem repetir plano", async () => {
  const db = banco();
  const porPlano: Record<string, Row[]> = {};
  for (let s = 1; s <= 5; s++) {
    enfileirarPlano(db, `${CNPJ}-0-00000${s}/2026`, s);
    porPlano[`${CNPJ}/2026/${s}`] = [itemIntegracao(1)];
  }
  const integ = integracaoFake(porPlano);
  const s1 = await processarFila(db as never, integ, { ano: ANO, limite: 2, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s1.planos_feitos, 2);
  assertEquals(db.rows("pca_plano_fila").filter((f) => f.status === "pendente").length, 3);
  const s2 = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s2.planos_feitos, 3);
  assertEquals(integ.chamadas.length, 5);
});

Deno.test("CA-7: prazo estourado devolve para pendente o que foi reservado e não processado", async () => {
  const db = banco();
  const porPlano: Record<string, Row[]> = {};
  for (let s = 1; s <= 3; s++) {
    enfileirarPlano(db, `${CNPJ}-0-00000${s}/2026`, s);
    porPlano[`${CNPJ}/2026/${s}`] = [itemIntegracao(1)];
  }
  let chamadas = 0;
  const prazo = () => ++chamadas > 2; // passa no while e no 1º plano; estoura antes do 2º
  const s = await processarFila(db as never, integracaoFake(porPlano), {
    ano: ANO,
    limite: 10,
    prazoEsgotado: prazo,
    runId: RUN,
  });
  assertEquals(s.planos_feitos, 1);
  assertEquals(db.rows("pca_plano_fila").map((f) => f.status).sort(), ["feito", "pendente", "pendente"]);
});

Deno.test("CA-10: ausente sem item do escopo é inativado; com item, os itens são gravados e o contador zera", async () => {
  const db = banco();
  const outro = `${CNPJ}-0-000005/2026`;
  for (const id of [ID, outro]) {
    await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(id), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  }
  for (const p of db.rows("pca_planos")) p.descoberta_ausente_seguidas = 1;
  const vazia = {
    planos: new Map(),
    completo: true,
    retomar_de: null,
    paginas: 1,
    linhas: 0,
    pares_distintos: 0,
    erro: null,
  };
  const a = await tratarAusentes(db as never, vazia, {
    ano: ANO,
    classes: ["7830"],
    rotina: "reconciliacao",
    chainId: RUN,
  });
  assertEquals([a.ausentes_2_ou_mais, a.enfileirados], [2, 2]);
  const integ = integracaoFake({
    [`${CNPJ}/2026/4`]: [itemIntegracao(1, "6505")], // só outra classe → inativa
    [`${CNPJ}/2026/5`]: [itemIntegracao(1), itemIntegracao(2)], // ainda tem 7830 → grava o item 2 e zera o contador
  });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_inativados, 1);
  const planos = Object.fromEntries(db.rows("pca_planos").map((p) => [p.id_pca_pncp, p]));
  assertEquals([planos[ID].ativo, planos[outro].ativo, planos[outro].descoberta_ausente_seguidas], [false, true, 0]);
  const p4 = planos[ID].id;
  assertEquals(db.rows("pca_itens").filter((i) => i.pca_plano_id === p4).every((i) => i.ativo === false), true);
  assertEquals(db.rows("pca_itens").filter((i) => i.pca_plano_id === planos[outro].id).length, 2);
});

Deno.test("CA-10: ausente sem item do escopo inativa só os itens do escopo; item de outra classe mantém o plano", async () => {
  const db = banco();
  // plano com um item 7830 e um 7220; a reconciliação é só de 7830 e a integração não traz mais o 7830
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1), itemConsulta(2, "7220")] }], {
    ano: ANO,
    runId: "r",
  });
  db.rows("pca_planos")[0].descoberta_ausente_seguidas = 2;
  enfileirarPlano(db, ID, 4, { motivo: "ausente", plano: null, classes: ["7830"] });
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(2, "7220")] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_inativados, s.itens_inativados], [1, 0, 1]);
  const plano = db.rows("pca_planos")[0];
  assertEquals([plano.ativo, plano.descoberta_ausente_seguidas], [true, 0]);
  const porNumero = Object.fromEntries(db.rows("pca_itens").map((i) => [i.numero_item, i.ativo]));
  assertEquals(porNumero, { 1: false, 2: true });
});

Deno.test("CA-10: incremental não enfileira ausentes, só atualiza o contador", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  db.rows("pca_planos")[0].descoberta_ausente_seguidas = 5;
  const vazia = {
    planos: new Map(),
    completo: true,
    retomar_de: null,
    paginas: 1,
    linhas: 0,
    pares_distintos: 0,
    erro: null,
  };
  const a = await tratarAusentes(db as never, vazia, { ano: ANO, classes: ["7830"], rotina: "incremental", chainId: RUN });
  assertEquals(a.enfileirados, 0);
  assertEquals(db.rows("pca_plano_fila").length, 0);
});

Deno.test("integração: plano com mais de 2.000 itens lê a página seguinte e confere a quantidade", async () => {
  const muitos = Array.from({ length: TAMANHO_PAGINA_INTEGRACAO + 5 }, (_, i) => itemIntegracao(i + 1));
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: muitos });
  const lidos = await lerItensPlano(integ, CNPJ, ANO, 4);
  assertEquals(lidos.length, TAMANHO_PAGINA_INTEGRACAO + 5);
  assertEquals(integ.chamadas.length, 2);
});

// --- handler da rotina (status da execução) ---

async function rodar(db: FakePostgrest, body: Row, consulta: unknown, integ: unknown) {
  const res = await handleRotinaFila({
    client: db as never,
    consulta: consulta as never,
    integracao: integ as never,
    body,
    ano: ANO,
    classes: ["7830"],
    tamanhoPagina: 500,
    isAsync: false,
  });
  return await res.json();
}

Deno.test("handler: incremental com a fila esvaziada termina 'concluida'", async () => {
  const db = banco();
  const consulta = consultaFake([{ data: [{ ...cabecalho(), itens: [itemConsulta(1)] }], paginasRestantes: 0 }]);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  const r = await rodar(db, { rotina: "incremental" }, consulta, integ);
  assertEquals(r.status, "concluida");
  assertEquals(db.rows("pncp_sync_run")[0].status, "concluida");
  assertEquals(db.rows("pca_itens").length, 1);
});

Deno.test("handler: fila que sobra termina 'incompleta' e a continuação termina o trabalho", async () => {
  const db = banco();
  const consulta = consultaFake([{
    data: [1, 2, 3].map((s) => ({ ...cabecalho(`${CNPJ}-0-00000${s}/2026`), itens: [itemConsulta(1)] })),
    paginasRestantes: 0,
  }]);
  const porPlano: Record<string, Row[]> = {};
  for (let s = 1; s <= 3; s++) porPlano[`${CNPJ}/2026/${s}`] = [itemIntegracao(1)];
  const integ = integracaoFake(porPlano);
  const r1 = await rodar(db, { rotina: "incremental", limite_planos: 2 }, consulta, integ);
  assertEquals([r1.status, r1.fila_abertos], ["incompleta", 1]);
  const r2 = await rodar(db, { rotina: "incremental", somente_retomada: true }, consulta, integ);
  assertEquals([r2.status, r2.fila_abertos], ["concluida", 0]);
  assertEquals(consulta.chamadas, [1]); // a continuação não refaz a descoberta
  const r3 = await rodar(db, { rotina: "incremental", somente_retomada: true }, consulta, integ);
  assertEquals(r3.status, "ignorado"); // nada a fazer: não abre execução
});

Deno.test("handler: descoberta que para no meio é retomada pela continuação da página seguinte", async () => {
  const db = banco();
  let falhar = true;
  const chamadas: number[] = [];
  const consulta = {
    fetchPcaPage(_a: number, p: number) {
      chamadas.push(p);
      if (p === 2 && falhar) return Promise.resolve({ status: 502, body: null });
      const id = `${CNPJ}-0-00000${p}/2026`;
      return Promise.resolve({
        status: 200,
        body: { data: [{ ...cabecalho(id), itens: [itemConsulta(1)] }], paginasRestantes: 2 - p },
      });
    },
  };
  const integ = integracaoFake({ [`${CNPJ}/2026/1`]: [itemIntegracao(1)], [`${CNPJ}/2026/2`]: [itemIntegracao(1)] });
  const r1 = await rodar(db, { rotina: "incremental" }, consulta, integ);
  assertEquals([r1.status, r1.descoberta.retomar_de], ["incompleta", { classe_idx: 0, pagina: 2 }]);
  falhar = false;
  const r2 = await rodar(db, { rotina: "incremental", somente_retomada: true }, consulta, integ);
  assertEquals([r2.status, r2.descoberta.retomada, r2.descoberta.completo], ["concluida", true, false]);
  assertEquals(chamadas, [1, 2, 2]);
  assertEquals(db.rows("pca_planos").length, 2);
});

Deno.test("handler: rotina inválida devolve 400 sem abrir execução", async () => {
  const db = banco();
  const res = await handleRotinaFila({
    client: db as never,
    consulta: consultaFake([]) as never,
    integracao: integracaoFake({}) as never,
    body: { rotina: "tudo" },
    ano: ANO,
    classes: ["7830"],
    tamanhoPagina: 500,
    isAsync: false,
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
  assertEquals(db.rows("pncp_sync_run").length, 0);
});
