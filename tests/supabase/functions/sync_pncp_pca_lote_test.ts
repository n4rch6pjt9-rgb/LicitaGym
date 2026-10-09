// Spec 0012, PR 1: gravação em lote de uma página do PCA.
// CA-1 (chamadas), CA-2 (mesmo resultado do caminho item a item), CA-3 (inalterado), CA-9 (erro ≠ vazio),
// CA-11 (vínculos de origem iguais).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
import { normalizePcaItem, normalizePcaPlano } from "../../../supabase/functions/_shared/pncp/normalize.ts";
import { upsertByHash } from "../../../supabase/functions/_shared/pncp/upsert.ts";
import { linkPcaItemOrigemCodes } from "../../../supabase/functions/_shared/pncp/pca-origem-link.ts";

type Row = Record<string, unknown>;
const RUN = "run-teste";

/** Caminho item a item atual (laço de syncClassificacao em sync-pncp-pca/index.ts), como referência. */
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
    for (const [k, x] of Object.entries(v as Row)) if (!VOLATEIS.has(k)) out[k] = semVolateis(x);
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

Deno.test("CA-2/CA-11: banco vazio — lote grava o mesmo que o caminho item a item", async () => {
  const pagina = paginaSintetica(3, 8);
  const a = bancoInicial();
  const b = a.clone();
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(estado(b), estado(a));
  assertEquals(sb.novos, 3 + 24);
  // vínculos: PDM 2640 existe; 99999 não; código 111 casa 2 itens do catálogo e não vincula.
  assert(b.rows("pca_item_pdm").length > 0);
  assert(b.rows("catalogo_ponte").every((r) => r.catalogo_item_id === "cat-1"));
});

Deno.test("CA-2: banco com linhas alteradas e inalteradas — mesmo resultado e mesmo histórico", async () => {
  const base = bancoInicial();
  await gravarItemAItem(base, paginaSintetica(3, 8, 0), 2026);
  // segunda rodada: datas do plano e alguns valores mudam (variante 1); o resto fica igual.
  const pagina = paginaSintetica(3, 8, 1);
  const a = base.clone();
  const b = base.clone();
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assert(sb.alterados > 0 && sb.inalterados > 0);
  assertEquals(estado(b), estado(a));
});

Deno.test("CA-3: hash igual — sem histórico, só last_seen_sync_id, last_synced_at e ativo = true", async () => {
  const db = bancoInicial();
  const pagina = paginaSintetica(2, 5);
  await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: "run-1" });
  for (const r of db.rows("pca_itens")) r.ativo = false;
  const historicoAntes = db.rows("pca_alteracoes").length;
  const s = await gravarPaginaPcaEmLote(db as never, pagina, { ano: 2026, runId: "run-2" });
  assertEquals(s.inalterados, 2 + 10);
  assertEquals(s.novos + s.alterados, 0);
  assertEquals(db.rows("pca_alteracoes").length, historicoAntes);
  assert(db.rows("pca_itens").every((r) => r.ativo === true && r.last_seen_sync_id === "run-2"));
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
  await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: "run-2" });
  assert(b.chamadas - antes <= 20, `inalterado: ${b.chamadas - antes}`);
});

Deno.test("CA-9: falha no insert em lote conta como erro e não como gravado", async () => {
  const db = bancoInicial();
  db.falhas.push({ table: "pca_itens", op: "insert" });
  const s = await gravarPaginaPcaEmLote(db as never, paginaSintetica(2, 4), { ano: 2026, runId: RUN });
  assertEquals(s.novos, 2);
  assertEquals(s.erros, 8);
  assertEquals(db.rows("pca_itens").length, 0);
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

Deno.test("linha que o banco rejeita derruba só ela: o lote refaz o bloco linha a linha", async () => {
  const pagina = paginaSintetica(2, 4);
  const rejeita = (table: string, row: Row) => table === "pca_itens" && row.numero_item === 2;
  const a = bancoInicial();
  const b = a.clone();
  a.falhaLinha = rejeita;
  b.falhaLinha = rejeita;
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(sb.erros, 2);
  assertEquals(b.rows("pca_itens").length, 6);
  assertEquals(estado(b), estado(a));
});

Deno.test("linha rejeitada num plano já gravado: o update em lote cai para linha a linha", async () => {
  const base = bancoInicial();
  await gravarItemAItem(base, paginaSintetica(2, 4, 0), 2026);
  const pagina = paginaSintetica(2, 4, 1);
  const rejeita = (table: string, row: Row) => table === "pca_itens" && row.numero_item === 3;
  const a = base.clone();
  const b = base.clone();
  a.falhaLinha = rejeita;
  b.falhaLinha = rejeita;
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(estado(b), estado(a));
});

Deno.test("max-rows menor que o pedido: a leitura dos existentes não trunca", async () => {
  const base = bancoInicial();
  await gravarItemAItem(base, paginaSintetica(3, 8, 0), 2026);
  const pagina = paginaSintetica(3, 8, 1);
  const a = base.clone();
  const b = base.clone();
  b.maxRows = 3;
  const sa = await gravarItemAItem(a, pagina, 2026);
  const sb = await gravarPaginaPcaEmLote(b as never, pagina, { ano: 2026, runId: RUN });
  assertEquals(sb, sa);
  assertEquals(sb.novos, 0);
  assertEquals(estado(b), estado(a));
});

Deno.test("falha na leitura do catálogo conta erro, não vincula e não aborta a página", async () => {
  const db = bancoInicial();
  db.falhas.push({ table: "catmat_pdms", op: "select" });
  const s = await gravarPaginaPcaEmLote(db as never, paginaSintetica(1, 4), { ano: 2026, runId: RUN });
  assertEquals(s.novos, 1 + 4);
  assertEquals(s.erros, 1);
  assertEquals(db.rows("pca_item_pdm").length, 0);
  assert(db.rows("catalogo_ponte").length > 0);
});
