// Spec 0012, PR 2: fila de planos (descoberta pela consulta, itens pela integração por plano).
// CA-3 (mesmo hash consulta × integração, com item real), CA-5/CA-6 (descoberta e enfileiramento), CA-7 (orçamento e
// status da execução), CA-8 (inativação por plano; erro não inativa), CA-10 (ausente).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import {
  ausenciaNoEscopo,
  descobrirPlanos,
  escopoDeClasses,
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
import { BudgetExhaustedError } from "../../../supabase/functions/_shared/pncp/retry.ts";
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
        if (aberto.status !== "processando") Object.assign(aberto, { status: "pendente", tentativas: 0, erro: null });
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
  // private.pca_marcar_descoberta / pca_zerar_ausencia: um contador por escopo em descoberta_ausente (jsonb).
  db.rpcs.pca_marcar_descoberta = (args, d) => {
    const vistos = new Set(args.p_vistos as string[]);
    const chave = escopoDeClasses(args.p_classes);
    for (const p of d.rows("pca_planos")) {
      if (p.ano_exercicio !== args.p_ano) continue;
      const mapa = { ...((p.descoberta_ausente as Row) ?? {}) };
      if (vistos.has(String(p.id_pca_pncp))) delete mapa[chave];
      else if (p.ativo !== false) mapa[chave] = ausenciaNoEscopo(mapa, chave) + 1;
      p.descoberta_ausente = mapa;
    }
    return d.rows("pca_planos")
      .filter((p) => p.ativo !== false && ausenciaNoEscopo(p.descoberta_ausente, chave) >= 2).length;
  };
  db.rpcs.pca_zerar_ausencia = (args, d) => {
    const p = d.rows("pca_planos").find((r) => r.id === args.p_plano_id);
    if (p) {
      const mapa = { ...((p.descoberta_ausente as Row) ?? {}) };
      delete mapa[escopoDeClasses(args.p_classes)];
      p.descoberta_ausente = mapa;
    }
    return null;
  };
  // private.acquire_sync_lock (20260929000001): execução 'executando' sem heartbeat há mais de 3 min é stale e vira
  // 'incompleta' só se continuation.pending for array não vazio (senão 'falhou'); novo run 'executando' herda a
  // continuation do último 'incompleta' do mesmo lock e já nasce com ela nos parâmetros.
  let runSeq = 0;
  db.rpcs.acquire_sync_lock = (args, d) => {
    const runs = d.rows("pncp_sync_run");
    const rodando = runs.find((r) => r.lock_key === args.p_lock_key && r.status === "executando");
    if (rodando) {
      if (Date.now() - Date.parse(String(rodando.last_heartbeat_at)) <= 180_000) {
        return { already_running: true, run_id: "ocupado" };
      }
      const pending = ((rodando.parametros as Row)?.continuation as Row | undefined)?.pending;
      rodando.status = Array.isArray(pending) && pending.length > 0 ? "incompleta" : "falhou";
    }
    const anterior = runs.filter((r) => r.lock_key === args.p_lock_key && r.status === "incompleta").pop();
    if (anterior) anterior.status = "retomada";
    const continuation = (anterior?.parametros as Row | undefined)?.continuation ?? null;
    const id = `00000000-0000-0000-0000-00000000010${++runSeq}`;
    runs.push({
      id,
      lock_key: args.p_lock_key,
      status: "executando",
      last_heartbeat_at: new Date().toISOString(),
      parametros: { ...(args.p_parametros as Row), ...(continuation ? { continuation } : {}) },
    });
    return { already_running: false, run_id: id, continuation };
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

Deno.test("descoberta arquiva cada página da consulta antes de ler os planos", async () => {
  const paginas = [
    { data: [{ ...cabecalho(), itens: [itemConsulta(1)] }], paginasRestantes: 1 },
    { data: [{ ...cabecalho(), itens: [itemConsulta(2)] }], paginasRestantes: 0 },
  ];
  const arquivadas: Row[] = [];
  const d = await descobrirPlanos(consultaFake(paginas), {
    ano: ANO,
    classes: ["7830"],
    tamanhoPagina: 500,
    prazoEsgotado: nunca,
    arquivar: (r) => {
      arquivadas.push(r as unknown as Row);
      return Promise.resolve();
    },
  });
  assertEquals(d.completo, true);
  assertEquals(arquivadas.map((r) => r.endpoint), [
    `/pca/?anoPca=${ANO}&codigoClassificacaoSuperior=7830&pagina=1`,
    `/pca/?anoPca=${ANO}&codigoClassificacaoSuperior=7830&pagina=2`,
  ]);
  assertEquals(arquivadas[0].body, paginas[0]); // bruto, antes de normalizar
  assertEquals(arquivadas[1].requisicao, { ano: ANO, codigoClassificacao: "7830", pagina: 2, tamanhoPagina: 500 });
});

Deno.test("descoberta: falha ao arquivar a página é erro de página, sem ler os planos dela", async () => {
  const d = await descobrirPlanos(
    consultaFake([{ data: [{ ...cabecalho(), itens: [itemConsulta(1)] }], paginasRestantes: 0 }]),
    {
      ano: ANO,
      classes: ["7830"],
      tamanhoPagina: 500,
      prazoEsgotado: nunca,
      arquivar: () => Promise.reject(new Error("falha injetada source_record")),
    },
  );
  assertEquals([d.completo, d.erro_pagina, d.planos.size], [false, true, 0]);
  assertEquals(d.retomar_de, { classe_idx: 0, pagina: 1 });
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

Deno.test("carga arquiva a página de itens e a quantidade da integração em source_record, com a requisição", async () => {
  const db = banco();
  enfileirarPlano(db);
  const brutos = [itemIntegracao(1), itemIntegracao(900, "6505")];
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: brutos });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_feitos, 1);
  const arq = db.rows("source_record");
  assertEquals(arq.map((r) => r.endpoint), [
    `/orgaos/${CNPJ}/pca/2026/4/itens?pagina=1&tamanhoPagina=${TAMANHO_PAGINA_INTEGRACAO}`,
    `/orgaos/${CNPJ}/pca/2026/4/itens/quantidade`,
  ]);
  assertEquals(arq[0].payload, brutos); // bruto, com o item fora do escopo e os nomes da integração
  assertEquals(arq[1].payload, 2);
  assert(arq.every((r) => r.sync_run_id === RUN && r.resource_type === "pca"));
  assertEquals(arq[0].request_hash, await hashPayload({
    cnpj: CNPJ,
    ano: ANO,
    sequencial: 4,
    pagina: 1,
    tamanhoPagina: TAMANHO_PAGINA_INTEGRACAO,
  }));
});

Deno.test("falha ao arquivar a resposta bruta deixa o plano 'erro' e não inativa nada", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(413)] }], { ano: ANO, runId: "r" });
  enfileirarPlano(db);
  db.falhas = [{ table: "source_record", op: "upsert" }];
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(412)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_erro, s.itens_inativados], [1, 0]);
  assertEquals(db.rows("pca_itens").every((r) => r.ativo !== false), true);
  assertEquals(db.rows("pca_plano_fila")[0].status, "erro");
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

Deno.test("CA-8: falha ao reativar item que volta alterado deixa o plano 'erro', não 'feito'", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(413)] }], { ano: ANO, runId: "r0" });
  db.rows("pca_itens")[0].ativo = false;
  enfileirarPlano(db);
  db.falhas = [{ table: "pca_itens", op: "update" }];
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(413, "7830", 999)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_erro], [0, 1]);
  const it = db.rows("pca_itens")[0];
  assertEquals([it.ativo, it.valor_unitario_estimado], [false, 999]); // conteúdo gravou, reativação não
  assertEquals(db.rows("pca_plano_fila")[0].status, "erro");
});

Deno.test("falha depois de gravar o cabeçalho liga reprocessar sem mexer nos campos da fonte", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(412), itemConsulta(413)] }], {
    ano: ANO,
    runId: "r0",
  });
  enfileirarPlano(db);
  // 412 volta alterado (upsert grava o cabeçalho e o item); 413 sumiu, e a inativação dele falha
  db.falhas = [{ table: "pca_itens", op: "update" }];
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(412, "7830", 999)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_erro], [0, 1]);
  const plano = db.rows("pca_planos")[0];
  assertEquals(plano.reprocessar, true);
  assert(plano.data_atualizacao_origem != null && plano.payload_hash !== "reprocessar"); // dado oficial intacto
  assertEquals(db.rows("pca_plano_fila")[0].status, "erro");
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

Deno.test("CA-8: erro na gravação marca o plano para reprocessar, sem zerar data e hash", async () => {
  const db = banco();
  enfileirarPlano(db);
  db.falhaLinha = (t, row) => t === "pca_itens" && row.numero_item === 1;
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_erro, 1);
  const plano = db.rows("pca_planos")[0];
  assertEquals(plano.reprocessar, true);
  assert(plano.data_atualizacao_origem != null && plano.payload_hash !== "reprocessar");
});

Deno.test("incremental reenfileira plano marcado para reprocessar mesmo com a data da fonte igual", async () => {
  const db = banco();
  const id = `${CNPJ}-0-000001/2026`;
  db.rows("pca_planos").push({
    id: "pl-1",
    id_pca_pncp: id,
    data_atualizacao_origem: "2026-09-21T11:31:57+00:00",
    ativo: true,
    reprocessar: true,
  });
  const d = await descobrirPlanos(consultaFake([{ data: [cabecalho(id)], paginasRestantes: 0 }]), {
    ano: ANO,
    classes: ["7830"],
    tamanhoPagina: 500,
    prazoEsgotado: nunca,
  });
  const r = await enfileirarDescobertos(db as never, d, "incremental", { chainId: RUN, classes: ["7830"] });
  assertEquals([r.alterados, r.sem_mudanca], [1, 0]);
});

Deno.test("plano marcado para reprocessar que termina 'feito' desliga a marca", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r0" });
  db.rows("pca_planos")[0].reprocessar = true;
  enfileirarPlano(db);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_feitos, 1);
  assertEquals(db.rows("pca_planos")[0].reprocessar, false);
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
  for (const p of db.rows("pca_planos")) p.descoberta_ausente = { "7830": 1 };
  const a = await tratarAusentes(db as never, [], {
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
  assertEquals([planos[ID].ativo, planos[outro].ativo, planos[outro].descoberta_ausente], [false, true, {}]);
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
  db.rows("pca_planos")[0].descoberta_ausente = { "7830": 2, "7220": 1 };
  enfileirarPlano(db, ID, 4, { motivo: "ausente", plano: null, classes: ["7830"] });
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(2, "7220")] });
  const s = await processarFila(db as never, integ, { ano: ANO, limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_inativados, s.itens_inativados], [1, 0, 1]);
  const plano = db.rows("pca_planos")[0];
  assertEquals([plano.ativo, plano.descoberta_ausente], [true, { "7220": 1 }]); // zera só o escopo da fila
  const porNumero = Object.fromEntries(db.rows("pca_itens").map((i) => [i.numero_item, i.ativo]));
  assertEquals(porNumero, { 1: false, 2: true });
});

Deno.test("CA-10: cada escopo de classes conta a própria ausência; um não zera nem usa o outro", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  // ausente 1 vez numa descoberta só da 7220; a reconciliação da 7830 não vê o plano
  db.rows("pca_planos")[0].descoberta_ausente = { "7220": 1 };
  const a = await tratarAusentes(db as never, [], {
    ano: ANO,
    classes: ["7830"],
    rotina: "reconciliacao",
    chainId: RUN,
  });
  assertEquals([a.ausentes_2_ou_mais, a.enfileirados], [0, 0]);
  assertEquals(db.rows("pca_planos")[0].descoberta_ausente, { "7220": 1, "7830": 1 });
  // a descoberta da 7830 que vê o plano tira só a chave 7830; a ausência da 7220 continua
  await tratarAusentes(db as never, [ID], { ano: ANO, classes: ["7830"], rotina: "incremental", chainId: RUN });
  assertEquals(db.rows("pca_planos")[0].descoberta_ausente, { "7220": 1 });
});

Deno.test("CA-10: reconciliação não enfileira plano cujo contador de 2 é de outro escopo", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  // o RPC devolve ausentes no escopo pedido; aqui o plano já tem 2 medidos na 7220 e a reconciliação da 7830 o vê
  db.rpcs.pca_marcar_descoberta = () => 1;
  db.rows("pca_planos")[0].descoberta_ausente = { "7220": 2 };
  const a = await tratarAusentes(db as never, [], {
    ano: ANO,
    classes: ["7830"],
    rotina: "reconciliacao",
    chainId: RUN,
  });
  assertEquals(a.enfileirados, 0);
});

Deno.test("escopoDeClasses ordena e tira repetição; ausenciaNoEscopo lê a chave (ausente = 0)", () => {
  assertEquals(escopoDeClasses(["7830", "7220", "7830"]), "7220,7830");
  assertEquals(escopoDeClasses(null), "");
  assertEquals(ausenciaNoEscopo({ "7220,7830": 3 }, "7220,7830"), 3);
  assertEquals(ausenciaNoEscopo({ "7220": 3 }, "7830"), 0);
  assertEquals(ausenciaNoEscopo(null, "7830"), 0);
});

Deno.test("CA-10: incremental não enfileira ausentes, só atualiza o contador", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  db.rows("pca_planos")[0].descoberta_ausente = { "7830": 5 };
  const a = await tratarAusentes(db as never, [], { ano: ANO, classes: ["7830"], rotina: "incremental", chainId: RUN });
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

Deno.test("handler: heartbeat que não grava a continuation interrompe antes da primeira requisição", async () => {
  const db = banco();
  const consulta = consultaFake([{ data: [{ ...cabecalho(), itens: [itemConsulta(1)] }], paginasRestantes: 0 }]);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  db.falhas = [{ table: "pncp_sync_run", op: "update" }];
  const r = await rodar(db, { rotina: "incremental" }, consulta, integ);
  assertEquals(r.status, "falhou");
  assertEquals(consulta.chamadas, []); // nenhuma página lida sem a posição gravada
  assertEquals(db.rows("pca_itens").length, 0);
});

Deno.test("handler: descoberta grava a página bruta em source_record", async () => {
  const db = banco();
  const consulta = consultaFake([{ data: [{ ...cabecalho(), itens: [itemConsulta(1)] }], paginasRestantes: 0 }]);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(1)] });
  await rodar(db, { rotina: "incremental" }, consulta, integ);
  const endpoints = db.rows("source_record").map((r) => String(r.endpoint));
  assert(endpoints.includes(`/pca/?anoPca=${ANO}&codigoClassificacaoSuperior=7830&pagina=1`));
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

Deno.test("handler: worker morto no meio da descoberta deixa execução stale que a continuação herda e retoma", async () => {
  const db = banco();
  let morto = true;
  const chamadas: number[] = [];
  const consulta = {
    fetchPcaPage(_a: number, p: number) {
      chamadas.push(p);
      // worker morto: a requisição da página 2 nunca volta e o finishSyncRun não roda
      if (p === 2 && morto) return new Promise<never>(() => {});
      const id = `${CNPJ}-0-00000${p}/2026`;
      return Promise.resolve({
        status: 200,
        body: { data: [{ ...cabecalho(id), itens: [itemConsulta(1)] }], paginasRestantes: 2 - p },
      });
    },
  };
  const integ = integracaoFake({ [`${CNPJ}/2026/1`]: [itemIntegracao(1)], [`${CNPJ}/2026/2`]: [itemIntegracao(1)] });
  void rodar(db, { rotina: "incremental" }, consulta, integ); // nunca termina
  await new Promise((r) => setTimeout(r, 0));
  const [run1] = db.rows("pncp_sync_run");
  assertEquals(run1.status, "executando");
  const cont = (run1.parametros as Row).continuation as Row;
  assertEquals([cont.pending, cont.descoberta], [["descoberta", "fila"], { classe_idx: 0, pagina: 1 }]);
  run1.last_heartbeat_at = new Date(Date.now() - 10 * 60_000).toISOString(); // sem heartbeat há 10 min

  morto = false;
  const r2 = await rodar(db, { rotina: "incremental", somente_retomada: true }, consulta, integ);
  assertEquals(run1.status, "retomada"); // stale com pending → incompleta → herdada (não 'falhou')
  assertEquals([r2.status, r2.rotina], ["concluida", "incremental"]);
  assertEquals(chamadas, [1, 2, 1, 2]); // a continuação refez a descoberta da posição gravada
  assertEquals(db.rows("pca_planos").length, 2);
});

/** Três planos com item 7830 ativo e uma ausência anterior; a consulta mostra o 1 na página 1 e o 2 na página 2. */
async function cadeiaDeDescoberta(
  falhaPagina2: () => { status: number; body: unknown } | "pausa" | null,
  corpo1: Row = { rotina: "incremental" },
  corpo2: Row = { rotina: "incremental", somente_retomada: true },
) {
  const db = banco();
  for (const s of [1, 2, 3]) {
    const id = `${CNPJ}-0-00000${s}/2026`;
    await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(id), itens: [itemConsulta(1)] }], { ano: ANO, runId: "r" });
  }
  for (const p of db.rows("pca_planos")) {
    Object.assign(p, { ano_exercicio: ANO, descoberta_ausente: { "7830": 1 } });
  }
  const consulta = {
    fetchPcaPage(_a: number, p: number) {
      const falha = p === 2 ? falhaPagina2() : null;
      if (falha === "pausa") return Promise.reject(new BudgetExhaustedError());
      if (falha) return Promise.resolve(falha);
      const id = `${CNPJ}-0-00000${p}/2026`;
      return Promise.resolve({
        status: 200,
        body: { data: [{ ...cabecalho(id), itens: [itemConsulta(1)] }], paginasRestantes: 2 - p },
      });
    },
  };
  const integ = integracaoFake({});
  const chamadas: number[] = [];
  const consultaComLog = {
    fetchPcaPage(a: number, p: number) {
      chamadas.push(p);
      return consulta.fetchPcaPage(a, p);
    },
  };
  const r1 = await rodar(db, corpo1, consultaComLog, integ);
  const depoisDaPrimeira = chamadas.length;
  const r2 = await rodar(db, corpo2, consultaComLog, integ);
  const contador = Object.fromEntries(
    db.rows("pca_planos").map((p) => [String(p.id_pca_pncp).slice(-6, -5), ausenciaNoEscopo(p.descoberta_ausente, "7830")]),
  );
  return { r1, r2, contador, paginasDaSegunda: chamadas.slice(depoisDaPrimeira) };
}

Deno.test("handler: incremental que pega a trava retoma a reconciliação herdada pela metade, sem voltar à página 1", async () => {
  let primeira = true;
  const { r1, r2, contador, paginasDaSegunda } = await cadeiaDeDescoberta(
    () => {
      if (!primeira) return null;
      primeira = false;
      return "pausa";
    },
    { rotina: "reconciliacao" },
    { rotina: "incremental" }, // cron do incremental chega antes da continuação
  );
  assertEquals([r1.status, r1.rotina], ["incompleta", "reconciliacao"]);
  assertEquals([r2.rotina, r2.rotina_pedida, r2.retomou_herdada], ["reconciliacao", "incremental", true]);
  assertEquals(paginasDaSegunda, [2]); // continua da página 2
  assertEquals(r2.descoberta.cadeia_completa, true);
  assertEquals(contador["3"], 2); // ausência contada com os planos vistos pela cadeia toda
});

Deno.test("handler: descoberta dividida entre execuções conta ausência uma vez, com os planos da cadeia toda", async () => {
  let primeira = true;
  const { r1, r2, contador } = await cadeiaDeDescoberta(() => {
    if (!primeira) return null;
    primeira = false;
    return "pausa"; // fim do orçamento na página 2: a continuação lê a página 2 inteira
  });
  assertEquals([r1.status, r1.descoberta.retomar_de, r1.ausentes], ["incompleta", { classe_idx: 0, pagina: 2 }, undefined]);
  assertEquals([r2.status, r2.descoberta.completo, r2.descoberta.cadeia_completa], ["concluida", false, true]);
  // 1 (página 1, execução anterior) e 2 (página 2, continuação) vistos; 3 ausente → 2 ausências seguidas
  assertEquals(contador, { 1: 0, 2: 0, 3: 2 });
  assertEquals(r2.ausentes.ausentes_2_ou_mais, 1);
});

Deno.test("handler: erro de página em qualquer elo da cadeia impede a contagem de ausência", async () => {
  let primeira = true;
  const { r2, contador } = await cadeiaDeDescoberta(() => {
    if (!primeira) return null;
    primeira = false;
    return { status: 502, body: null };
  });
  assertEquals([r2.status, r2.descoberta.cadeia_completa, r2.ausentes], ["concluida", false, undefined]);
  assertEquals(contador, { 1: 1, 2: 1, 3: 1 });
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
