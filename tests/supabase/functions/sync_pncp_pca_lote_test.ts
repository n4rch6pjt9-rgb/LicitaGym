// Spec 0012, PR 1: gravação em lote de uma página do PCA.
// CA-1 (chamadas), CA-2 (mesmo resultado do caminho item a item), CA-3 (inalterado), CA-9 (erro ≠ vazio),
// CA-11 (vínculos de origem iguais).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakePcaPostgrest as FakePostgrest } from "./_shared/pncp/_fake_pca_atomico.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
import { normalizePcaItem, normalizePcaPlano } from "../../../supabase/functions/_shared/pncp/normalize.ts";
import { upsertByHash } from "../../../supabase/functions/_shared/pncp/upsert.ts";
import { linkPcaItemOrigemCodes } from "../../../supabase/functions/_shared/pncp/pca-origem-link.ts";

type Row = Record<string, unknown>;
const RUN = "00000000-0000-4000-8000-000000000001";

/** Referência legada para dados e vínculos; o histórico segue o contrato próprio da RPC. */
async function gravarItemAItem(client: FakePostgrest, planos: Row[], ano: number) {
  const stats = { recebidos: 0, novos: 0, alterados: 0, inalterados: 0, erros: 0 };
  const conta = (r: string) => {
    if (r === "novo") stats.novos++;
    else if (r === "alterado") stats.alterados++;
    else if (r === "inalterado") stats.inalterados++;
    else stats.erros++;
  };
  // deno-lint-ignore no-explicit-any
  const c = client as any;
  for (const plan of planos) {
    const planoRow = normalizePcaPlano(plan, ano);
    if (!planoRow.id_pca_pncp) continue;
    stats.recebidos++;
    conta(
      await upsertByHash(c, "pca_planos", { id_pca_pncp: planoRow.id_pca_pncp }, planoRow, {
        historyTable: "pca_alteracoes",
        historyFields: ({ rowId }) => ({ pca_plano_id: rowId }),
        syncRunId: RUN,
        lastSeenSyncId: RUN,
        reactivateOnUnchanged: true,
      }),
    );
    const { data: planoRecord, error: e1 } = await c.from("pca_planos").select("id")
      .eq("id_pca_pncp", planoRow.id_pca_pncp).maybeSingle();
    if (e1 || !planoRecord) {
      if (e1) stats.erros++;
      continue;
    }
    for (const rawItem of (plan.itens as Row[]) ?? []) {
      const itemRow = normalizePcaItem(rawItem, plan);
      if (!itemRow.numero_item) continue;
      stats.recebidos++;
      conta(
        await upsertByHash(
          c,
          "pca_itens",
          { pca_plano_id: planoRecord.id, numero_item: itemRow.numero_item },
          { ...itemRow, pca_plano_id: planoRecord.id },
          {
            historyTable: "pca_alteracoes",
            historyFields: ({ rowId }) => ({ pca_plano_id: planoRecord.id, pca_item_id: rowId }),
            syncRunId: RUN,
            lastSeenSyncId: RUN,
            reactivateOnUnchanged: true,
          },
        ),
      );
      if (itemRow.pdm_codigo_origem || itemRow.codigo_item_origem) {
        const { data: itemRecord, error: e2 } = await c.from("pca_itens").select("id")
          .eq("pca_plano_id", planoRecord.id).eq("numero_item", itemRow.numero_item).maybeSingle();
        if (e2) stats.erros++;
        else if (itemRecord) await linkPcaItemOrigemCodes(c, String(itemRecord.id), itemRow);
      }
    }
  }
  return stats;
}

/** Página sintética no formato da consulta `/pca/` (campos e tipos da resposta oficial; valores inventados). */
function paginaSintetica(nPlanos: number, itensPorPlano: number, variante = 0): Row[] {
  const planos: Row[] = [];
  for (let p = 1; p <= nPlanos; p++) {
    const cnpj = String(10000000000000 + p).padStart(14, "0");
    const itens: Row[] = [];
    for (let i = 1; i <= itensPorPlano; i++) {
      itens.push({
        numeroItem: i,
        descricaoItem: `Item ${p}-${i}`,
        categoriaItemPcaNome: "Material",
        classificacaoCatalogoId: 1,
        classificacaoSuperiorCodigo: "7830",
        quantidadeEstimada: i,
        unidadeFornecimento: "UN",
        valorUnitario: 10 * i + variante * (i % 3 === 0 ? 1 : 0),
        valorTotal: 10 * i * i,
        dataDesejada: "2026-11-10",
        // PDM: 2640 existe no catálogo; 99999 não existe; alguns sem PDM.
        pdmCodigo: i % 4 === 0 ? null : i % 5 === 0 ? "99999" : "2640",
        // codigoItem: 480144 casa 1 item do catálogo; 111 casa 2 (não vincula); alguns sem código.
        codigoItem: i % 4 === 0 ? null : i % 7 === 0 ? "111" : "480144",
      });
    }
    planos.push({
      codigoUnidade: String(120000 + p),
      nomeUnidade: `Unidade ${p}`,
      anoPca: 2026,
      orgaoEntidadeCnpj: cnpj,
      idPcaPncp: `${cnpj}-0-${String(p).padStart(6, "0")}/2026`,
      dataPublicacaoPNCP: "2025-04-29T08:19:54",
      dataAtualizacaoGlobalPCA: `2026-09-2${variante}T11:31:57`,
      orgaoEntidadeRazaoSocial: `Órgão ${p}`,
      itens,
    });
  }
  return planos;
}

function bancoInicial(): FakePostgrest {
  return new FakePostgrest({
    catmat_pdms: [{ codigo_pdm: 2640 }],
    catalogo_itens: [
      { id: "cat-1", codigo_catmat: "480144" },
      { id: "cat-2", codigo_catmat: "111" },
      { id: "cat-3", codigo_catmat: "111" },
    ],
  });
}

const VOLATEIS = new Set(["updated_at", "last_synced_at", "created_at"]);
function semVolateis(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(semVolateis);
  if (v && typeof v === "object") {
    const out: Row = {};
    for (const [k, x] of Object.entries(v as Row).sort(([a], [b]) => a.localeCompare(b))) if (!VOLATEIS.has(k)) out[k] = semVolateis(x);
    return out;
  }
  return v;
}
function estado(db: FakePostgrest) {
  const ordena = (rows: Row[]) => rows.map((r) => JSON.stringify(semVolateis(r))).sort();
  const historico = db.rows("pca_alteracoes").map((r) => {
    const { id: _id, ...resto } = r;
    return resto;
  });
  return {
    pca_planos: ordena(db.rows("pca_planos")),
    pca_itens: ordena(db.rows("pca_itens")),
    pca_alteracoes: ordena(historico),
    pca_item_pdm: ordena(db.rows("pca_item_pdm")),
    catalogo_ponte: ordena(db.rows("catalogo_ponte")),
  };
}


type SnapshotPca = { planos: Row[]; itens: Row[]; eventos: number };
function snapshotPca(db: FakePostgrest): SnapshotPca {
  return {
    planos: structuredClone(db.rows("pca_planos")),
    itens: structuredClone(db.rows("pca_itens")),
    eventos: db.rows("pca_alteracoes").length,
  };
}
function dadosPersistidos(db: FakePostgrest) {
  const { pca_alteracoes: _historico, ...dados } = estado(db);
  return dados;
}

/** Compara dados com a referência; audita separadamente o contrato novo da RPC. */
function assertHistoricoRpc(db: FakePostgrest, antes: SnapshotPca, runId: string) {
  const eventos = db.rows("pca_alteracoes").slice(antes.eventos);
  const esperados: { row: Row; anterior: Row | null; item: boolean }[] = [];
  for (const [tabela, previas] of [
    ["pca_planos", antes.planos], ["pca_itens", antes.itens],
  ] as const) {
    for (const row of db.rows(tabela)) {
      const anterior = previas.find((p) => p.id === row.id) ?? null;
      if (!anterior || anterior.payload_hash !== row.payload_hash || anterior.ativo === false) {
        esperados.push({ row, anterior, item: tabela === "pca_itens" });
      }
    }
  }
  assertEquals(eventos.length, esperados.length, "um evento por entidade nova, alterada ou reativada");
  for (const { row, anterior, item } of esperados) {
    const correspondentes = eventos.filter((e) =>
      item ? e.pca_item_id === row.id : e.pca_item_id == null && e.pca_plano_id === row.id
    );
    assertEquals(correspondentes.length, 1);
    const [evento] = correspondentes;
    assertEquals(evento.pca_plano_id, item ? row.pca_plano_id : row.id);
    assertEquals(evento.pca_item_id ?? null, item ? row.id : null);
    assertEquals(evento.tipo_operacao, !anterior ? "insert" : anterior.ativo === false ? "reativacao" : "update");
    assertEquals(evento.dados_anteriores, anterior);
    assertEquals(evento.dados_novos, row);
    assertEquals(evento.payload_hash_anterior, anterior?.payload_hash ?? null);
    assertEquals(evento.payload_hash_novo, row.payload_hash);
    assertEquals(evento.sync_run_id, runId);
  }
}

Deno.test("CA-2/CA-11: mesmos dados e vinculos da referencia; snapshots completos na RPC", async () => {
  const pagina = paginaSintetica(3, 8);
  const a = bancoInicial();
  const b = a.clone();
  const antes = snapshotPca(b);
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(dadosPersistidos(b), dadosPersistidos(a));
  assertHistoricoRpc(b, antes, RUN);
  assertEquals(sb.novos, 3 + 24);
  assert(b.rows("pca_item_pdm").length > 0);
  assert(b.rows("catalogo_ponte").every((r) => r.catalogo_item_id === "cat-1"));
});
Deno.test("CA-2: dados alterados/inalterados equivalentes e historico da RPC auditado", async () => {
  const base = bancoInicial();
  await gravarItemAItem(base, paginaSintetica(3, 8, 0), 2026);
  const pagina = paginaSintetica(3, 8, 1);
  const a = base.clone();
  const b = base.clone();
  const antes = snapshotPca(b);
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assert(sb.alterados > 0 && sb.inalterados > 0);
  assertEquals(dadosPersistidos(b), dadosPersistidos(a));
  assertHistoricoRpc(b, antes, RUN);
});
Deno.test("CA-3: reativacao com hash igual gera evento; replay ativo nao duplica historico", async () => {
  const db = bancoInicial();
  const pagina = paginaSintetica(2, 5);
  await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: "00000000-0000-4000-8000-000000000002" });
  for (const r of db.rows("pca_itens")) r.ativo = false;
  const antes = snapshotPca(db);
  const runId = "00000000-0000-4000-8000-000000000003";
  const s = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId });
  assertEquals([s.inalterados, s.alterados, s.novos, s.erros], [2, 10, 0, 0]);
  assertEquals(db.rows("pca_alteracoes").length, antes.eventos + 10);
  assertHistoricoRpc(db, antes, runId);
  assert(db.rows("pca_itens").every((r) => r.ativo === true && r.last_seen_sync_id === runId));
  const antesReplay = snapshotPca(db);
  const replay = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId });
  assertEquals([replay.inalterados, replay.alterados, replay.novos, replay.erros], [12, 0, 0, 0]);
  assertEquals(db.rows("pca_alteracoes").length, antesReplay.eventos);
  assertHistoricoRpc(db, antesReplay, runId);
});
Deno.test("CA-1: página de 94 planos e 500 itens — poucas chamadas por página", async () => {
  // 94 planos x ~5,3 itens, como a página 2 real medida em 09/10 (3.777 chamadas no caminho item a item).
  const pagina = paginaSintetica(94, 5);
  for (let p = 0; p < 30; p++) (pagina[p].itens as Row[]).push({ ...(pagina[p].itens as Row[])[0], numeroItem: 100 });
  const itens = pagina.reduce((n, p) => n + (p.itens as Row[]).length, 0);
  assertEquals(itens, 500);

  const a = bancoInicial();
  await gravarItemAItem(a, pagina, 2026);
  const b = bancoInicial();
  await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assert(a.chamadas > 3000, `referência: ${a.chamadas}`);
  assert(b.chamadas <= 20, `lote: ${b.chamadas} chamadas ${JSON.stringify(b.porOperacao)}`);

  // segunda rodada, tudo inalterado: ainda poucas chamadas.
  const antes = b.chamadas;
  await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: "00000000-0000-4000-8000-000000000003" });
  assert(b.chamadas - antes <= 20, `inalterado: ${b.chamadas - antes}`);
});

Deno.test("CA-9: falha no bloco de itens propaga e preserva apenas planos ja confirmados", async () => {
  const db = bancoInicial();
  const antes = snapshotPca(db);
  db.falhas.push({ table: "pca_itens", op: "insert" });
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, paginaSintetica(2, 4), { ano: 2026, runId: RUN }),
    Error, "falha injetada pca_itens.insert"
  );
  assertEquals(db.rows("pca_planos").length, 2);
  assertEquals(db.rows("pca_itens").length, 0);
  assertEquals(db.rows("pca_alteracoes").length, 2);
  assertHistoricoRpc(db, antes, RUN);
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 2);
  assertEquals(db.porOperacao["pca_itens.insert"] ?? 0, 0, "sem fallback de escrita direta");
});
Deno.test("CA-9: falha de leitura propaga (não vira 'nada no banco')", async () => {
  const db = bancoInicial();
  db.falhas.push({ table: "pca_planos", op: "select" });
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, paginaSintetica(1, 2), { ano: 2026, runId: RUN })
  );
  assertEquals(db.rows("pca_planos").length, 0);
});

Deno.test("chave repetida na página (paginação instável): grava uma linha, a última vence", async () => {
  const pagina = paginaSintetica(1, 3);
  const itens = pagina[0].itens as Row[];
  itens.push({ ...itens[0], valorUnitario: 999 });
  const db = bancoInicial();
  const s = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(s.recebidos, 1 + 4);
  assertEquals(db.rows("pca_itens").length, 3);
  assertEquals(db.rows("pca_itens").find((r) => r.numero_item === 1)?.valor_unitario_estimado, 999);
});

// --- Regressões da revisão do PR 1 ---

Deno.test("plano repetido na página com itens diferentes: grava os itens de todas as ocorrências (bloqueante da revisão)", async () => {
  const [plano] = paginaSintetica(1, 3);
  const itens = plano.itens as Row[];
  const pagina = [{ ...plano, itens: itens.slice(0, 2) }, { ...plano, itens: itens.slice(2) }];
  const a = bancoInicial();
  const b = a.clone();
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(b.rows("pca_itens").map((r) => r.numero_item).sort(), [1, 2, 3]);
  assertEquals(estado(b).pca_itens, estado(a).pca_itens);
  assertEquals(sb.erros, 0);
  // O plano aparece duas vezes: o caminho antigo grava novo + inalterado; o lote grava uma vez (documentado).
  assertEquals(sb.recebidos, sa.recebidos);
});

Deno.test("linha rejeitada reverte todos os itens do bloco sem fallback linha a linha", async () => {
  const db = bancoInicial();
  const antes = snapshotPca(db);
  db.falhaLinha = (table, row) => table === "pca_itens" && row.numero_item === 2;
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, paginaSintetica(2, 4), { ano: 2026, runId: RUN }),
    Error, "linha rejeitada"
  );
  assertEquals(db.rows("pca_planos").length, 2);
  assertEquals(db.rows("pca_itens"), []);
  assertEquals(db.rows("pca_alteracoes").length, 2);
  assertHistoricoRpc(db, antes, RUN);
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 2);
  assertEquals(db.porOperacao["pca_itens.insert"] ?? 0, 0);
});
Deno.test("update rejeitado preserva todos os itens anteriores e historico do bloco", async () => {
  const db = bancoInicial();
  await gravarItemAItem(db, paginaSintetica(2, 4, 0), 2026);
  const antes = snapshotPca(db);
  const chamadasAntes = db.porOperacao["pca_persistir_lote_atomico.rpc"] ?? 0;
  db.falhaLinha = (table, row) => table === "pca_itens" && row.numero_item === 3;
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, paginaSintetica(2, 4, 1), { ano: 2026, runId: RUN }),
    Error, "linha rejeitada"
  );
  assertEquals(db.rows("pca_itens"), antes.itens);
  assertEquals(db.rows("pca_planos").length, 2);
  assertEquals(db.rows("pca_alteracoes").length, antes.eventos + 2, "somente os planos foram confirmados");
  assertHistoricoRpc(db, antes, RUN);
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"] - chamadasAntes, 2);
});
Deno.test("max-rows menor que o pedido preserva dados, vinculos e historico completo", async () => {
  const base = bancoInicial();
  await gravarItemAItem(base, paginaSintetica(3, 8, 0), 2026);
  const pagina = paginaSintetica(3, 8, 1);
  const a = base.clone();
  const b = base.clone();
  b.maxRows = 3;
  const antes = snapshotPca(b);
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(sb.novos, 0);
  assertEquals(dadosPersistidos(b), dadosPersistidos(a));
  assertHistoricoRpc(b, antes, RUN);
});
// Spec 0056 (decisão de 11/11/2026): falha de vínculo com o catálogo é aviso, não erro de gravação.
Deno.test("falha na leitura do catálogo vira aviso, não vincula e não aborta a página", async () => {
  const db = bancoInicial();
  db.falhas.push({ table: "catmat_pdms", op: "select" });
  const s = await gravarPaginaPcaEmLote(db as never, paginaSintetica(1, 4), { ano: 2026, runId: RUN });
  assertEquals(s.novos, 1 + 4);
  assertEquals(s.erros, 0);
  assertEquals(s.avisos, ["catmat_pdms: falha injetada catmat_pdms.select"]);
  assertEquals(db.rows("pca_item_pdm").length, 0);
  assert(db.rows("catalogo_ponte").length > 0);
});

Deno.test("RED-01: falha no historico aborta a RPC sem dados ou eventos parciais", async () => {
  const db = bancoInicial();
  db.falhas.push({ table: "pca_alteracoes", op: "insert" });
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, paginaSintetica(1, 2), {
      ano: 2026, runId: "00000000-0000-4000-8000-000000000004",
    }),
    Error, "falha injetada pca_alteracoes.insert"
  );
  assertEquals(db.rows("pca_planos"), []);
  assertEquals(db.rows("pca_itens"), []);
  assertEquals(db.rows("pca_alteracoes"), []);
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 1);
});
Deno.test("RED-02: upsert individual não pode ignorar falha no histórico", async () => {
  const db = bancoInicial();

  db.falhas.push({
    table: "pca_alteracoes",
    op: "insert",
  });

  const resultado = await upsertByHash(
    db as never,
    "pca_planos",
    { id_pca_pncp: "red-02-plano" },
    {
      id_pca_pncp: "red-02-plano",
      ano: 2026,
    },
    {
      historyTable: "pca_alteracoes",
      historyFields: ({ rowId }) => ({ pca_plano_id: rowId }),
      syncRunId: "00000000-0000-4000-8000-000000000102",
    },
  );

  assertEquals(db.rows("pca_planos").length, 1);
  assertEquals(db.rows("pca_alteracoes").length, 0);

  assertEquals(
    resultado,
    "erro",
    "RED-02: upsert individual retornou sucesso com histórico ausente",
  );
});

Deno.test("RED-03: retry depois do rollback grava dados e historico uma unica vez", async () => {
  const db = bancoInicial();
  const pagina = paginaSintetica(1, 2);
  db.falhas.push({ table: "pca_alteracoes", op: "insert" });
  await assertRejects(() =>
    gravarPaginaPcaEmLote(db as never, pagina, {
      ano: 2026, runId: "00000000-0000-4000-8000-000000000005",
    }),
    Error, "falha injetada pca_alteracoes.insert"
  );
  assertEquals(db.rows("pca_planos"), []);
  assertEquals(db.rows("pca_itens"), []);
  assertEquals(db.rows("pca_alteracoes"), []);
  db.falhas.length = 0;
  const antes = snapshotPca(db);
  const runId = "00000000-0000-4000-8000-000000000006";
  const sucesso = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId });
  assertEquals([sucesso.novos, sucesso.erros], [3, 0]);
  assertEquals(db.rows("pca_planos").length, 1);
  assertEquals(db.rows("pca_itens").length, 2);
  assertEquals(db.rows("pca_alteracoes").length, 3);
  assertHistoricoRpc(db, antes, runId);
  const antesReplay = snapshotPca(db);
  const replay = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId });
  assertEquals([replay.inalterados, replay.novos, replay.alterados, replay.erros], [3, 0, 0, 0]);
  assertEquals(db.rows("pca_alteracoes").length, 3);
  assertHistoricoRpc(db, antesReplay, runId);
});
/** Reproduz o schema real: catmat_pdms tem codigo_pdm, sem coluna id. */
function bancoComSchemaPdm(): FakePostgrest {
  const db = bancoInicial();
  const executar = db.executar.bind(db);
  db.executar = (query) => {
    if (query.table === "catmat_pdms" && query.op === "select" &&
      query.ordem !== "codigo_pdm") {
      return { data: null, error: { message: `column catmat_pdms.${query.ordem} does not exist` } };
    }
    return executar(query);
  };
  return db;
}

Deno.test("REG-PDM-chave: vincula todos os PDMs sem coluna id com paginas truncadas e replay", async () => {
  const db = bancoComSchemaPdm();
  db.maxRows = 1;
  db.tables.set("catmat_pdms", [{ codigo_pdm: 2642 }, { codigo_pdm: 2640 }, { codigo_pdm: 2641 }]);
  const pagina = paginaSintetica(1, 3);
  for (const [i, item] of (pagina[0].itens as Row[]).entries()) item.pdmCodigo = String(2640 + i);
  const primeira = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: RUN });
  assertEquals([primeira.recebidos, primeira.novos, primeira.erros], [4, 4, 0]);
  const vinculos = db.rows("pca_item_pdm");
  assertEquals(vinculos.map((r) => r.codigo_pdm).sort(), [2640, 2641, 2642]);
  for (const [i, item] of (pagina[0].itens as Row[]).entries()) {
    const persistido = db.rows("pca_itens").find((r) => r.numero_item === item.numeroItem)!;
    assertEquals(vinculos.find((r) => r.pca_item_id === persistido.id)?.codigo_pdm, 2640 + i);
  }
  const idsAntes = db.rows("pca_itens").map((r) => r.id);
  const eventosAntes = structuredClone(db.rows("pca_alteracoes"));
  const replay = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: RUN });
  assertEquals([replay.inalterados, replay.novos, replay.alterados, replay.erros], [4, 0, 0, 0]);
  assertEquals(db.rows("pca_item_pdm").length, 3);
  assertEquals(db.rows("pca_itens").map((r) => r.id), idsAntes);
  assertEquals(db.rows("pca_alteracoes"), eventosAntes);
});

Deno.test("REG-PDM-chave: falha em pagina intermediaria nao vira ausencia nem vinculo parcial", async () => {
  const db = bancoComSchemaPdm();
  db.maxRows = 1;
  db.tables.set("catmat_pdms", [{ codigo_pdm: 2640 }, { codigo_pdm: 2641 }]);
  let segundaPaginaAtingida = false;
  const executar = db.executar.bind(db);
  db.executar = (query) => {
    if (query.table === "catmat_pdms" && query.op === "select" && query.faixa?.[0] === 1) {
      segundaPaginaAtingida = true;
      return { data: null, error: { message: "falha injetada na segunda pagina PDM" } };
    }
    return executar(query);
  };
  const pagina = paginaSintetica(1, 2);
  (pagina[0].itens as Row[])[1].pdmCodigo = "2641";
  const stats = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: RUN });
  assert(segundaPaginaAtingida, "a falha deve ocorrer na segunda pagina, apos a primeira leitura valida");
  assertEquals(stats.erros, 0);
  assertEquals(stats.avisos, ["catmat_pdms: falha injetada na segunda pagina PDM"]);
  assertEquals(db.rows("pca_itens").length, 2);
  assertEquals(db.rows("pca_item_pdm"), []);
});

Deno.test("REG-PDM-chave: PDM ausente no catalogo nao cria vinculo nem erro de leitura", async () => {
  const db = bancoComSchemaPdm();
  const pagina = paginaSintetica(1, 2);
  (pagina[0].itens as Row[])[1].pdmCodigo = "99999";
  const stats = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(stats.erros, 0);
  assertEquals(db.rows("pca_itens").length, 2);
  assertEquals(db.rows("pca_item_pdm").map((r) => r.codigo_pdm), [2640]);
});
