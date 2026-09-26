/**
 * P0 reprojeção — testes pós dry-run fix (paginação, legacy v1/v2, UPDATE completo, JSON snapshot).
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { hashPayload } from "../../../../../supabase/functions/_shared/pncp/hash.ts";
import {
  normalizePcaItem,
  normalizePcaItemLegacyV1,
  normalizePcaItemLegacyV2,
} from "../../../../../supabase/functions/_shared/pncp/normalize.ts";
import {
  decideReprojection,
  defaultSnapshotPath,
  restorePcaItensSnapshotFromFile,
  runPcaReprojecaoClassificacao,
  selectLatestSourceItems,
  writePcaItensSnapshotFile,
  type PcaItemTarget,
} from "../../../../../supabase/functions/_shared/pncp/pca-reprojecao.ts";

const PLAN = { idPcaPncp: "00000000000191-0-000001/2026" };
const ITEM = {
  numeroItem: 10,
  classificacaoCatalogoId: 1,
  descricaoItem: "Aparelho",
  classificacaoSuperiorCodigo: "7830",
  pdmCodigo: "18481",
  codigoItem: "123456",
};

function baseTarget(overrides: Partial<PcaItemTarget> = {}): PcaItemTarget {
  return {
    id: "item-1",
    pca_plano_id: "plano-1",
    numero_item: 10,
    id_pca_pncp: String(PLAN.idPcaPncp),
    payload_hash: "x",
    classificacao_catalogo_id: null,
    descricao: "Aparelho",
    categoria: null,
    classe_material_servico: "7830",
    codigo_classe_catmat: null,
    quantidade: null,
    unidade_medida: null,
    valor_unitario_estimado: null,
    valor_total_estimado: null,
    data_prevista_contratacao: null,
    status: null,
    pdm_codigo_origem: null,
    codigo_item_origem: null,
    updated_at: "2026-09-18T12:00:00Z",
    ...overrides,
  };
}

function sourceOcc(item: Record<string, unknown> = ITEM) {
  return {
    idPcaPncp: String(PLAN.idPcaPncp),
    numeroItem: 10,
    plan: PLAN,
    item,
    fetchedAt: "2026-09-19T00:00:00Z",
    sourceRecordId: "src-1",
  };
}

Deno.test("1: hash legacy_v2 igual → atualizar com patch completo + match_v2", async () => {
  const v2 = {
    ...normalizePcaItemLegacyV2(ITEM, PLAN),
    pca_plano_id: "plano-1",
  };
  const novo = {
    ...normalizePcaItem(ITEM, PLAN),
    pca_plano_id: "plano-1",
  };
  const hashV2 = await hashPayload(v2);
  const hashNovo = await hashPayload(novo);
  const decision = await decideReprojection(
    baseTarget({
      payload_hash: hashV2,
      codigo_classe_catmat: 7830,
      pdm_codigo_origem: "18481",
      codigo_item_origem: "123456",
    }),
    sourceOcc(),
  );
  assertEquals(decision.kind, "atualizar");
  if (decision.kind === "atualizar") {
    assertEquals(decision.matchVersion, "v2");
    assertEquals(decision.hashNovo, hashNovo);
    assertEquals(decision.patch.classificacao_catalogo_id, "1");
    assertEquals(decision.patch.pdm_codigo_origem, "18481");
    assertEquals(decision.patch.payload_hash, hashNovo);
  }
});

Deno.test("1b: hash legacy_v1 igual → match_v1 e preenche pdm/item origem", async () => {
  const v1 = {
    ...normalizePcaItemLegacyV1(ITEM, PLAN),
    pca_plano_id: "plano-1",
  };
  const hashV1 = await hashPayload(v1);
  const decision = await decideReprojection(
    baseTarget({ payload_hash: hashV1 }),
    sourceOcc(),
  );
  assertEquals(decision.kind, "atualizar");
  if (decision.kind === "atualizar") {
    assertEquals(decision.matchVersion, "v1");
    assertEquals(decision.patch.pdm_codigo_origem, "18481");
    assertEquals(decision.patch.codigo_item_origem, "123456");
    assertEquals(decision.patch.codigo_classe_catmat, 7830);
    assertEquals(decision.diffs.pdm_codigo_origem, 1);
    assertEquals(decision.diffs.classificacao_catalogo_id, 1);
    assertEquals(decision.diffs.outros, 0);
  }
});

Deno.test("2: hash divergente de v1 e v2 → STALE_SOURCE_MISMATCH", async () => {
  const decision = await decideReprojection(
    baseTarget({ payload_hash: "hash-que-nao-bate" }),
    sourceOcc(),
  );
  assertEquals(decision.kind, "STALE_SOURCE_MISMATCH");
});

Deno.test("3: 2ª execução (hash já novo) → ja_atualizado", async () => {
  const novo = {
    ...normalizePcaItem(ITEM, PLAN),
    pca_plano_id: "plano-1",
  };
  const hashNovo = await hashPayload(novo);
  const decision = await decideReprojection(
    baseTarget({
      payload_hash: hashNovo,
      classificacao_catalogo_id: "1",
      codigo_classe_catmat: 7830,
      pdm_codigo_origem: "18481",
      codigo_item_origem: "123456",
    }),
    sourceOcc(),
  );
  assertEquals(decision.kind, "ja_atualizado");
});

Deno.test("7: duas versões na fonte → selectLatestSourceItems fica com a mais recente", () => {
  const latest = selectLatestSourceItems([
    {
      id: "old",
      fetched_at: "2026-09-18T10:00:00Z",
      payload: {
        data: [{
          idPcaPncp: PLAN.idPcaPncp,
          itens: [{ ...ITEM, classificacaoCatalogoId: 2 }],
        }],
      },
    },
    {
      id: "new",
      fetched_at: "2026-09-19T18:00:00Z",
      payload: {
        data: [{
          idPcaPncp: PLAN.idPcaPncp,
          itens: [{ ...ITEM, classificacaoCatalogoId: 1 }],
        }],
      },
    },
  ]);
  const hit = latest.get(`${PLAN.idPcaPncp}|10`);
  assertEquals(hit?.sourceRecordId, "new");
  assertEquals(hit?.item.classificacaoCatalogoId, 1);
});

type FakeState = {
  lockBusy: boolean;
  source: Array<{ id: string; fetched_at: string; payload: unknown }>;
  itens: Array<Record<string, unknown>>;
  updates: Array<{ table: string; id: string; patch: Record<string, unknown> }>;
  alteracoesInserts: number;
  syncRuns: Array<Record<string, unknown>>;
};

function fakeClient(state: FakeState) {
  function headCount(n: number) {
    const result = Promise.resolve({ count: n, error: null, data: null });
    const chain = Object.assign(result, {
      eq(_k: string, _v: unknown) {
        return chain;
      },
    });
    return chain;
  }

  function rangeChain(rows: Record<string, unknown>[]) {
    const api = {
      eq(_k: string, _v: unknown) {
        return api;
      },
      order(_c: string, _o: unknown) {
        return api;
      },
      range(from: number, to: number) {
        return Promise.resolve({
          data: rows.slice(from, to + 1),
          error: null,
        });
      },
    };
    return api;
  }

  const client = {
    schema(name: string) {
      return {
        from(table: string) {
          if (name === "private" && table === "pncp_sync_run") {
            return {
              select(_cols: string) {
                return {
                  eq(_k: string, _v: unknown) {
                    return this;
                  },
                  async maybeSingle() {
                    if (state.lockBusy) {
                      return {
                        data: {
                          id: "busy-run",
                          iniciada_em: new Date().toISOString(),
                        },
                        error: null,
                      };
                    }
                    return { data: null, error: null };
                  },
                };
              },
              insert(row: Record<string, unknown>) {
                const id = `run-${state.syncRuns.length + 1}`;
                state.syncRuns.push({ ...row, id });
                return {
                  select(_c: string) {
                    return {
                      async single() {
                        return { data: { id }, error: null };
                      },
                    };
                  },
                };
              },
              update(patch: Record<string, unknown>) {
                return {
                  async eq(_k: string, id: string) {
                    const run = state.syncRuns.find((r) => r.id === id);
                    if (run) Object.assign(run, patch);
                    return { error: null };
                  },
                };
              },
            };
          }
          if (name === "private" && table === "source_record") {
            return {
              select(_cols: string, opts?: { count?: string; head?: boolean }) {
                if (opts?.head) return headCount(state.source.length);
                return rangeChain(
                  state.source as unknown as Record<string, unknown>[],
                );
              },
            };
          }
          throw new Error(`unexpected private table ${table}`);
        },
      };
    },
    from(table: string) {
      if (table === "pca_alteracoes") {
        return {
          insert(_row: unknown) {
            state.alteracoesInserts += 1;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "pca_itens") {
        return {
          select(_cols: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.head) return headCount(state.itens.length);
            return rangeChain(state.itens);
          },
          update(patch: Record<string, unknown>) {
            return {
              async eq(_k: string, id: string) {
                state.updates.push({ table, id: String(id), patch });
                const row = state.itens.find((r) => String(r.id) === String(id));
                if (row) Object.assign(row, patch);
                return { error: null };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return client as never;
}

function itemRow(hash: string, extras: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    pca_plano_id: "plano-1",
    numero_item: 10,
    payload_hash: hash,
    classificacao_catalogo_id: null,
    descricao: "Aparelho",
    categoria: null,
    classe_material_servico: "7830",
    codigo_classe_catmat: null,
    quantidade: null,
    unidade_medida: null,
    valor_unitario_estimado: null,
    valor_total_estimado: null,
    data_prevista_contratacao: null,
    status: null,
    pdm_codigo_origem: null,
    codigo_item_origem: null,
    updated_at: "2026-09-18T12:00:00Z",
    pca_planos: { id_pca_pncp: PLAN.idPcaPncp },
    ...extras,
  };
}

Deno.test("4+5: confirmar grava patch completo; dry-run não grava; zero pca_alteracoes", async () => {
  const v1 = {
    ...normalizePcaItemLegacyV1(ITEM, PLAN),
    pca_plano_id: "plano-1",
  };
  const hashV1 = await hashPayload(v1);

  const baseState = (): FakeState => ({
    lockBusy: false,
    source: [{
      id: "src",
      fetched_at: "2026-09-19T00:00:00Z",
      payload: { data: [{ idPcaPncp: PLAN.idPcaPncp, itens: [ITEM] }] },
    }],
    itens: [itemRow(hashV1)],
    updates: [],
    alteracoesInserts: 0,
    syncRuns: [],
  });

  const dry = baseState();
  const dryReport = await runPcaReprojecaoClassificacao(
    fakeClient(dry),
    { dryRun: true, takeSnapshot: false },
  );
  assertEquals(dryReport.atualizados, 1);
  assertEquals(dryReport.lidos_pca_itens, 1);
  assertEquals(dryReport.match_v1, 1);
  assertEquals(dry.updates.length, 0);
  assertEquals(dry.alteracoesInserts, 0);

  const tmpDir = await Deno.makeTempDir({ prefix: "pca-p0-" });
  const snapPath = `${tmpDir}/snap.json`;
  const live = baseState();
  const liveReport = await runPcaReprojecaoClassificacao(
    fakeClient(live),
    {
      dryRun: false,
      takeSnapshot: true,
      snapshotPath: snapPath,
      abortOnDiffOutros: true,
    },
  );
  assertEquals(liveReport.atualizados, 1);
  assertEquals(live.updates.length, 1);
  assertEquals(live.updates[0].patch.classificacao_catalogo_id, "1");
  assertEquals(live.updates[0].patch.pdm_codigo_origem, "18481");
  assertEquals(live.updates[0].patch.codigo_item_origem, "123456");
  assertEquals(typeof live.updates[0].patch.payload_hash, "string");
  assertEquals(live.updates[0].patch.updated_at, undefined);
  assertEquals(live.alteracoesInserts, 0);
  assertEquals(liveReport.snapshot_sha256 != null, true);

  // 2ª execução sobre estado já atualizado
  const again = await runPcaReprojecaoClassificacao(
    fakeClient(live),
    { dryRun: false, takeSnapshot: false },
  );
  assertEquals(again.atualizados, 0);
  assertEquals(again.ja_atualizado, 1);
});

Deno.test("6: lock ocupado → erro explícito", async () => {
  const state: FakeState = {
    lockBusy: true,
    source: [],
    itens: [],
    updates: [],
    alteracoesInserts: 0,
    syncRuns: [],
  };
  await assertRejects(
    () =>
      runPcaReprojecaoClassificacao(fakeClient(state), {
        dryRun: true,
        takeSnapshot: false,
      }),
    Error,
    "Lock ocupado",
  );
});

Deno.test("8: rollback JSON restaura exatamente o snapshot", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "pca-rb-" });
  const path = `${tmpDir}/snap.json`;
  await writePcaItensSnapshotFile(path, "snap-1", [{
    id: "item-1",
    classificacao_catalogo_id: null,
    payload_hash: "hash-antigo",
    updated_at: "2026-09-18T00:00:00Z",
    descricao: "Aparelho",
    categoria: null,
    classe_material_servico: "7830",
    codigo_classe_catmat: null,
    quantidade: null,
    unidade_medida: null,
    valor_unitario_estimado: null,
    valor_total_estimado: null,
    data_prevista_contratacao: null,
    status: null,
    pdm_codigo_origem: null,
    codigo_item_origem: null,
    numero_item: 10,
  }]);

  const state: FakeState = {
    lockBusy: false,
    source: [],
    itens: [itemRow("hash-novo", {
      classificacao_catalogo_id: "1",
      pdm_codigo_origem: "18481",
    })],
    updates: [],
    alteracoesInserts: 0,
    syncRuns: [],
  };
  const n = await restorePcaItensSnapshotFromFile(fakeClient(state), path);
  assertEquals(n, 1);
  assertEquals(state.itens[0].classificacao_catalogo_id, null);
  assertEquals(state.itens[0].payload_hash, "hash-antigo");
  assertEquals(state.itens[0].pdm_codigo_origem, null);
  assertEquals(state.alteracoesInserts, 0);
});

Deno.test("A1: lidos_pca_itens espelha count e pagina via range", async () => {
  const itensPayload = [10, 11, 12].map((n) => ({ ...ITEM, numeroItem: n }));
  const many: Record<string, unknown>[] = [];
  for (const raw of itensPayload) {
    const hash = await hashPayload({
      ...normalizePcaItemLegacyV1(raw, PLAN),
      pca_plano_id: "plano-1",
    });
    many.push(itemRow(hash, {
      id: `item-${raw.numeroItem}`,
      numero_item: raw.numeroItem,
    }));
  }
  const state: FakeState = {
    lockBusy: false,
    source: [{
      id: "src",
      fetched_at: "2026-09-19T00:00:00Z",
      payload: {
        data: [{ idPcaPncp: PLAN.idPcaPncp, itens: itensPayload }],
      },
    }],
    itens: many,
    updates: [],
    alteracoesInserts: 0,
    syncRuns: [],
  };
  const report = await runPcaReprojecaoClassificacao(
    fakeClient(state),
    { dryRun: true, takeSnapshot: false },
  );
  assertEquals(report.erros, []);
  assertEquals(report.lidos_pca_itens, 3);
  assertEquals(report.alvo, 3);
  assertEquals(report.atualizados, 3);
});

Deno.test("normalizePcaItemLegacyV1 omite origem e classificacao", () => {
  const v1 = normalizePcaItemLegacyV1(ITEM, PLAN);
  assertEquals("classificacao_catalogo_id" in v1, false);
  assertEquals("pdm_codigo_origem" in v1, false);
  assertEquals("codigo_item_origem" in v1, false);
  assertEquals("codigo_classe_catmat" in v1, false);
  const v2 = normalizePcaItemLegacyV2(ITEM, PLAN);
  assertEquals("classificacao_catalogo_id" in v2, false);
  assertEquals(v2.pdm_codigo_origem, "18481");
});

Deno.test("defaultSnapshotPath fica sob var/p0/", () => {
  const p = defaultSnapshotPath("2026-09-26T12:00:00.000Z");
  assertEquals(p.startsWith("var/p0/pca_itens_snapshot_"), true);
  assertEquals(p.endsWith(".json"), true);
});
