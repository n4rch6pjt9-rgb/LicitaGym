/**
 * Reprojeção administrativa Stream A: alinha pca_itens ao mapper atual
 * a partir de private.source_record, sem gravar pca_alteracoes.
 *
 * Pós dry-run 26/09: paginação PostgREST, legacy_v1/v2, UPDATE completo,
 * snapshot JSON em var/p0/.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload, sha256Hex } from "./hash.ts";
import {
  normalizePcaItem,
  normalizePcaItemLegacyV1,
  normalizePcaItemLegacyV2,
} from "./normalize.ts";
import { acquireSyncLock } from "./lock.ts";
import { fetchAllByRange } from "./postgrest-paginate.ts";
import { finishSyncRun } from "./supabase-admin.ts";

export const DEFAULT_PCA_REPROJECTION_LOCK_KEY = "pca-sync:2026:7830";

/** Colunas produzidas por normalizePcaItem — o UPDATE grava todas. */
export const PCA_ITEM_MAPPER_COLUMNS = [
  "numero_item",
  "descricao",
  "categoria",
  "classe_material_servico",
  "codigo_classe_catmat",
  "classificacao_catalogo_id",
  "quantidade",
  "unidade_medida",
  "valor_unitario_estimado",
  "valor_total_estimado",
  "data_prevista_contratacao",
  "status",
  "pdm_codigo_origem",
  "codigo_item_origem",
] as const;

export type MapperColumn = (typeof PCA_ITEM_MAPPER_COLUMNS)[number];

/**
 * Diferenças esperadas no P0 (mapper antigo → atual). Não entram em `diff_outros`.
 * `codigo_classe_catmat` entra no v1 (coluna existia no DB via backfill SQL, mas
 * o hash v1 não a incluía — o UPDATE completo a preenche a partir da fonte).
 */
const EXPECTED_DIFF_COLUMNS = new Set<MapperColumn>([
  "classificacao_catalogo_id",
  "pdm_codigo_origem",
  "codigo_item_origem",
  "codigo_classe_catmat",
]);

export type SourceItemOccurrence = {
  idPcaPncp: string;
  numeroItem: number;
  plan: Record<string, unknown>;
  item: Record<string, unknown>;
  fetchedAt: string;
  sourceRecordId: string;
};

export type PcaItemTarget = {
  id: string;
  pca_plano_id: string;
  numero_item: number;
  id_pca_pncp: string;
  payload_hash: string;
  classificacao_catalogo_id: string | null;
  descricao: string | null;
  categoria: string | null;
  classe_material_servico: string | null;
  codigo_classe_catmat: number | null;
  quantidade: number | null;
  unidade_medida: string | null;
  valor_unitario_estimado: number | null;
  valor_total_estimado: number | null;
  data_prevista_contratacao: string | null;
  status: string | null;
  pdm_codigo_origem: string | null;
  codigo_item_origem: string | null;
  updated_at?: string | null;
};

export type ReprojDecision =
  | {
    kind: "atualizar";
    matchVersion: "v1" | "v2" | "current";
    hashNovo: string;
    patch: Record<string, unknown>;
    diffs: ColumnDiffCounts;
  }
  | { kind: "ja_atualizado" }
  | {
    kind: "STALE_SOURCE_MISMATCH";
    hashV1: string;
    hashV2: string;
    hashNovo: string;
  }
  | { kind: "sem_fonte" };

export type ColumnDiffCounts = {
  classificacao_catalogo_id: number;
  pdm_codigo_origem: number;
  codigo_item_origem: number;
  outros: number;
  outros_cols: string[];
};

export type SnapshotRow = {
  id: string;
  classificacao_catalogo_id: string | null;
  payload_hash: string;
  updated_at: string | null;
  // full mapper columns for A3 rollback
  descricao: string | null;
  categoria: string | null;
  classe_material_servico: string | null;
  codigo_classe_catmat: number | null;
  quantidade: number | null;
  unidade_medida: string | null;
  valor_unitario_estimado: number | null;
  valor_total_estimado: number | null;
  data_prevista_contratacao: string | null;
  status: string | null;
  pdm_codigo_origem: string | null;
  codigo_item_origem: string | null;
  numero_item: number;
};

export type SnapshotFile = {
  snapshot_id: string;
  created_at: string;
  row_count: number;
  content_sha256: string;
  rows: SnapshotRow[];
};

export type ReprojReport = {
  alvo: number;
  lidos_pca_itens: number;
  lidos_source_record: number;
  atualizados: number;
  ja_atualizado: number;
  STALE_SOURCE_MISMATCH: number;
  sem_fonte: number;
  fonte_sem_projecao: number;
  match_v1: number;
  match_v2: number;
  valor_1: number;
  valor_2: number;
  outros: number;
  diff_classificacao_catalogo_id: number;
  diff_pdm_codigo_origem: number;
  diff_codigo_item_origem: number;
  diff_outros: number;
  diff_outros_cols: string[];
  erros: Array<{ id?: string; motivo: string }>;
  stale_ids: string[];
  duracao_s: number;
  dry_run: boolean;
  snapshot_path: string | null;
  snapshot_sha256: string | null;
  sync_run_id: string | null;
};

export type ReprojOptions = {
  dryRun: boolean;
  limite?: number;
  lockKey?: string;
  snapshotPath?: string;
  takeSnapshot?: boolean;
  /** Abort --confirmar when unexpected column diffs exist. Default true. */
  abortOnDiffOutros?: boolean;
  nowIso?: () => string;
};

function extractPlans(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object"
    );
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "content", "itens", "resultado"]) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).filter((
          x,
        ): x is Record<string, unknown> => !!x && typeof x === "object");
      }
    }
  }
  return [];
}

/** Latest occurrence per (idPcaPncp, numeroItem) by fetched_at. */
export function selectLatestSourceItems(
  records: Array<{
    id: string;
    fetched_at: string;
    payload: unknown;
  }>,
): Map<string, SourceItemOccurrence> {
  const latest = new Map<string, SourceItemOccurrence>();
  for (const rec of records) {
    const plans = extractPlans(rec.payload);
    for (const plan of plans) {
      const idPcaPncp = String(plan.idPcaPncp ?? plan.id_pca_pncp ?? "").trim();
      if (!idPcaPncp) continue;
      const itens = Array.isArray(plan.itens) ? plan.itens : [];
      for (const rawItem of itens) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const numeroItem = Number(item.numeroItem ?? item.numero_item ?? 0);
        if (!numeroItem) continue;
        const key = `${idPcaPncp}|${numeroItem}`;
        const prev = latest.get(key);
        if (!prev || String(rec.fetched_at) > prev.fetchedAt) {
          latest.set(key, {
            idPcaPncp,
            numeroItem,
            plan,
            item,
            fetchedAt: String(rec.fetched_at),
            sourceRecordId: rec.id,
          });
        }
      }
    }
  }
  return latest;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return String(a) === String(b);
}

export function diffMapperColumns(
  current: PcaItemTarget,
  next: Record<string, unknown>,
): ColumnDiffCounts {
  const counts: ColumnDiffCounts = {
    classificacao_catalogo_id: 0,
    pdm_codigo_origem: 0,
    codigo_item_origem: 0,
    outros: 0,
    outros_cols: [],
  };
  for (const col of PCA_ITEM_MAPPER_COLUMNS) {
    if (col === "numero_item") continue;
    const curVal = current[col as keyof PcaItemTarget];
    const nextVal = next[col];
    if (valuesEqual(curVal, nextVal)) continue;
    if (col === "classificacao_catalogo_id") {
      counts.classificacao_catalogo_id = 1;
    } else if (col === "pdm_codigo_origem") counts.pdm_codigo_origem = 1;
    else if (col === "codigo_item_origem") counts.codigo_item_origem = 1;
    else if (!EXPECTED_DIFF_COLUMNS.has(col)) {
      counts.outros += 1;
      counts.outros_cols.push(col);
    }
  }
  return counts;
}

export function buildMapperPatch(
  newRow: ReturnType<typeof normalizePcaItem>,
  hashNovo: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { payload_hash: hashNovo };
  for (const col of PCA_ITEM_MAPPER_COLUMNS) {
    if (col === "numero_item") continue; // identity part of UNIQUE
    patch[col] = newRow[col];
  }
  return patch;
}

export async function decideReprojection(
  target: PcaItemTarget,
  source: SourceItemOccurrence | undefined,
): Promise<ReprojDecision> {
  if (!source) return { kind: "sem_fonte" };

  const v1Row = {
    ...normalizePcaItemLegacyV1(source.item, source.plan),
    pca_plano_id: target.pca_plano_id,
  };
  const v2Row = {
    ...normalizePcaItemLegacyV2(source.item, source.plan),
    pca_plano_id: target.pca_plano_id,
  };
  const newRow = {
    ...normalizePcaItem(source.item, source.plan),
    pca_plano_id: target.pca_plano_id,
  };
  const hashV1 = await hashPayload(v1Row);
  const hashV2 = await hashPayload(v2Row);
  const hashNovo = await hashPayload(newRow);

  const diffs = diffMapperColumns(target, newRow);
  const hasColumnDiffs = diffs.classificacao_catalogo_id > 0 ||
    diffs.pdm_codigo_origem > 0 ||
    diffs.codigo_item_origem > 0 ||
    diffs.outros > 0;

  if (target.payload_hash === hashNovo && !hasColumnDiffs) {
    return { kind: "ja_atualizado" };
  }

  if (target.payload_hash === hashNovo) {
    return {
      kind: "atualizar",
      matchVersion: "current",
      hashNovo,
      patch: buildMapperPatch(newRow, hashNovo),
      diffs,
    };
  }

  let matchVersion: "v1" | "v2" | null = null;
  if (target.payload_hash === hashV1) matchVersion = "v1";
  else if (target.payload_hash === hashV2) matchVersion = "v2";

  if (!matchVersion) {
    return {
      kind: "STALE_SOURCE_MISMATCH",
      hashV1,
      hashV2,
      hashNovo,
    };
  }
  const patch = buildMapperPatch(newRow, hashNovo);
  return {
    kind: "atualizar",
    matchVersion,
    hashNovo,
    patch,
    diffs,
  };
}

function emptyReport(dryRun: boolean): ReprojReport {
  return {
    alvo: 0,
    lidos_pca_itens: 0,
    lidos_source_record: 0,
    atualizados: 0,
    ja_atualizado: 0,
    STALE_SOURCE_MISMATCH: 0,
    sem_fonte: 0,
    fonte_sem_projecao: 0,
    match_v1: 0,
    match_v2: 0,
    valor_1: 0,
    valor_2: 0,
    outros: 0,
    diff_classificacao_catalogo_id: 0,
    diff_pdm_codigo_origem: 0,
    diff_codigo_item_origem: 0,
    diff_outros: 0,
    diff_outros_cols: [],
    erros: [],
    stale_ids: [],
    duracao_s: 0,
    dry_run: dryRun,
    snapshot_path: null,
    snapshot_sha256: null,
    sync_run_id: null,
  };
}

function countClassificacao(report: ReprojReport, value: string | null) {
  if (value === "1") report.valor_1 += 1;
  else if (value === "2") report.valor_2 += 1;
  else report.outros += 1;
}

function targetToSnapshotRow(t: PcaItemTarget): SnapshotRow {
  return {
    id: t.id,
    classificacao_catalogo_id: t.classificacao_catalogo_id,
    payload_hash: t.payload_hash,
    updated_at: t.updated_at ?? null,
    descricao: t.descricao,
    categoria: t.categoria,
    classe_material_servico: t.classe_material_servico,
    codigo_classe_catmat: t.codigo_classe_catmat,
    quantidade: t.quantidade,
    unidade_medida: t.unidade_medida,
    valor_unitario_estimado: t.valor_unitario_estimado,
    valor_total_estimado: t.valor_total_estimado,
    data_prevista_contratacao: t.data_prevista_contratacao,
    status: t.status,
    pdm_codigo_origem: t.pdm_codigo_origem,
    codigo_item_origem: t.codigo_item_origem,
    numero_item: t.numero_item,
  };
}

export async function writePcaItensSnapshotFile(
  path: string,
  snapshotId: string,
  rows: SnapshotRow[],
  createdAt?: string,
): Promise<SnapshotFile> {
  const bodyRows = rows;
  const contentForHash = JSON.stringify(bodyRows);
  const contentSha = await sha256Hex(contentForHash);
  const file: SnapshotFile = {
    snapshot_id: snapshotId,
    created_at: createdAt ?? new Date().toISOString(),
    row_count: bodyRows.length,
    content_sha256: contentSha,
    rows: bodyRows,
  };
  try {
    await Deno.stat(path);
    throw new Error(`Snapshot já existe: ${path}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  const dir = path.includes("/") || path.includes("\\")
    ? path.replace(/[/\\][^/\\]+$/, "") || "."
    : ".";
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(file, null, 2));
  return file;
}

export async function readPcaItensSnapshotFile(
  path: string,
): Promise<SnapshotFile> {
  const raw = await Deno.readTextFile(path);
  const parsed = JSON.parse(raw) as SnapshotFile;
  if (!parsed?.rows || !Array.isArray(parsed.rows)) {
    throw new Error(`Snapshot inválido: ${path}`);
  }
  const recomputed = await sha256Hex(JSON.stringify(parsed.rows));
  if (parsed.content_sha256 !== recomputed) {
    throw new Error(
      `Snapshot SHA-256 diverge: file=${parsed.content_sha256} recomputed=${recomputed}`,
    );
  }
  return parsed;
}

/** Rollback from JSON snapshot — restores mapper columns + payload_hash. */
export async function restorePcaItensSnapshotFromFile(
  client: SupabaseClient,
  path: string,
): Promise<number> {
  const snap = await readPcaItensSnapshotFile(path);
  let restored = 0;
  const failures: string[] = [];
  for (const row of snap.rows) {
    const patch: Record<string, unknown> = {
      classificacao_catalogo_id: row.classificacao_catalogo_id,
      payload_hash: row.payload_hash,
      descricao: row.descricao,
      categoria: row.categoria,
      classe_material_servico: row.classe_material_servico,
      codigo_classe_catmat: row.codigo_classe_catmat,
      quantidade: row.quantidade,
      unidade_medida: row.unidade_medida,
      valor_unitario_estimado: row.valor_unitario_estimado,
      valor_total_estimado: row.valor_total_estimado,
      data_prevista_contratacao: row.data_prevista_contratacao,
      status: row.status,
      pdm_codigo_origem: row.pdm_codigo_origem,
      codigo_item_origem: row.codigo_item_origem,
    };
    const { data, error: upErr } = await client
      .from("pca_itens")
      .update(patch)
      .eq("id", row.id)
      .select("id");
    if (upErr) {
      failures.push(`${row.id}: ${upErr.message}`);
      continue;
    }
    if (!Array.isArray(data) || data.length !== 1) {
      failures.push(
        `${row.id}: update afetou ${
          Array.isArray(data) ? data.length : 0
        } linhas`,
      );
      continue;
    }
    restored += 1;
  }
  if (failures.length > 0) {
    throw new Error(
      `Rollback incompleto do snapshot ${snap.snapshot_id}: restored=${restored} failed=${failures.length} (${
        failures.join("; ")
      })`,
    );
  }
  return restored;
}

/** @deprecated Prefer restorePcaItensSnapshotFromFile (JSON). */
export async function restorePcaItensSnapshot(
  client: SupabaseClient,
  snapshotIdOrPath: string,
): Promise<number> {
  if (
    snapshotIdOrPath.endsWith(".json") || snapshotIdOrPath.includes("/") ||
    snapshotIdOrPath.includes("\\")
  ) {
    return restorePcaItensSnapshotFromFile(client, snapshotIdOrPath);
  }
  throw new Error(
    "Snapshot em tabela private.pca_itens_snapshot_p0 removido (A4). Use --snapshot-file path.json",
  );
}

/** @deprecated Prefer writePcaItensSnapshotFile. */
export async function takePcaItensSnapshot(
  _client: SupabaseClient,
  _snapshotId: string,
): Promise<number> {
  throw new Error(
    "Snapshot em tabela removido (A4). Use writePcaItensSnapshotFile / --snapshot-only",
  );
}

const ITEM_SELECT_COLS = [
  "id",
  "pca_plano_id",
  "numero_item",
  "payload_hash",
  "classificacao_catalogo_id",
  "descricao",
  "categoria",
  "classe_material_servico",
  "codigo_classe_catmat",
  "quantidade",
  "unidade_medida",
  "valor_unitario_estimado",
  "valor_total_estimado",
  "data_prevista_contratacao",
  "status",
  "pdm_codigo_origem",
  "codigo_item_origem",
  "updated_at",
  "pca_planos!inner(id_pca_pncp)",
].join(", ");

function mapItemRow(r: Record<string, unknown>): PcaItemTarget {
  const plano = r.pca_planos as unknown as { id_pca_pncp: string };
  return {
    id: String(r.id),
    pca_plano_id: String(r.pca_plano_id),
    numero_item: Number(r.numero_item),
    id_pca_pncp: String(plano.id_pca_pncp),
    payload_hash: String(r.payload_hash),
    classificacao_catalogo_id: (r.classificacao_catalogo_id as string | null) ??
      null,
    descricao: (r.descricao as string | null) ?? null,
    categoria: (r.categoria as string | null) ?? null,
    classe_material_servico: (r.classe_material_servico as string | null) ??
      null,
    codigo_classe_catmat: r.codigo_classe_catmat == null
      ? null
      : Number(r.codigo_classe_catmat),
    quantidade: r.quantidade == null ? null : Number(r.quantidade),
    unidade_medida: (r.unidade_medida as string | null) ?? null,
    valor_unitario_estimado: r.valor_unitario_estimado == null
      ? null
      : Number(r.valor_unitario_estimado),
    valor_total_estimado: r.valor_total_estimado == null
      ? null
      : Number(r.valor_total_estimado),
    data_prevista_contratacao: (r.data_prevista_contratacao as string | null) ??
      null,
    status: (r.status as string | null) ?? null,
    pdm_codigo_origem: (r.pdm_codigo_origem as string | null) ?? null,
    codigo_item_origem: (r.codigo_item_origem as string | null) ?? null,
    updated_at: (r.updated_at as string | null) ?? null,
  };
}

type Writer = {
  updateItem: (
    id: string,
    patch: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null; affectedCount: number }>;
};

export async function loadAllPcaItens(
  client: SupabaseClient,
): Promise<{ rows: PcaItemTarget[]; countExact: number }> {
  const { count, error: countErr } = await client
    .from("pca_itens")
    .select("id", { count: "exact", head: true });
  if (countErr) throw countErr;
  const countExact = count ?? 0;

  const { rows } = await fetchAllByRange<Record<string, unknown>>(
    async (from, to) => {
      const { data, error } = await client
        .from("pca_itens")
        .select(ITEM_SELECT_COLS)
        .order("id", { ascending: true })
        .range(from, to);
      return {
        data: (data as Record<string, unknown>[] | null) ?? null,
        error,
      };
    },
    { orderBy: "id" },
  );

  if (rows.length !== countExact) {
    throw new Error(
      `Paginação pca_itens incompleta: lidos=${rows.length} count(*)=${countExact}`,
    );
  }
  return { rows: rows.map(mapItemRow), countExact };
}

export async function loadAllSourceRecords(
  client: SupabaseClient,
): Promise<
  {
    rows: Array<{ id: string; fetched_at: string; payload: unknown }>;
    countExact: number;
  }
> {
  const { count, error: countErr } = await client
    .schema("private")
    .from("source_record")
    .select("id", { count: "exact", head: true })
    .eq("resource_type", "pca");
  if (countErr) throw countErr;
  const countExact = count ?? 0;

  const { rows } = await fetchAllByRange<{
    id: string;
    fetched_at: string;
    payload: unknown;
  }>(
    async (from, to) => {
      const { data, error } = await client
        .schema("private")
        .from("source_record")
        .select("id, fetched_at, payload")
        .eq("resource_type", "pca")
        .order("id", { ascending: true })
        .range(from, to);
      return {
        data: (data as
          | Array<{
            id: string;
            fetched_at: string;
            payload: unknown;
          }>
          | null) ?? null,
        error,
      };
    },
    { orderBy: "id" },
  );

  if (rows.length !== countExact) {
    throw new Error(
      `Paginação source_record incompleta: lidos=${rows.length} count(*)=${countExact}`,
    );
  }
  return { rows, countExact };
}

export function defaultSnapshotPath(nowIso: string): string {
  const stamp = nowIso.replace(/[:.]/g, "-");
  return `var/p0/pca_itens_snapshot_${stamp}.json`;
}

export async function runPcaReprojecaoClassificacao(
  client: SupabaseClient,
  options: ReprojOptions,
  deps?: { writer?: Writer },
): Promise<ReprojReport> {
  const started = Date.now();
  const report = emptyReport(options.dryRun);
  const lockKey = options.lockKey ?? DEFAULT_PCA_REPROJECTION_LOCK_KEY;
  const nowIso = options.nowIso?.() ?? new Date().toISOString();
  const snapshotPath = options.snapshotPath ?? defaultSnapshotPath(nowIso);
  const abortOnDiffOutros = options.abortOnDiffOutros === true; // P0: permitir diff_outros

  const { runId, alreadyRunning } = await acquireSyncLock(
    client,
    lockKey,
    "pca",
    {
      modo: "reprocessamento",
      job: "pca-reprojecao-classificacao",
      dry_run: options.dryRun,
      limite: options.limite ?? null,
      snapshot_path: snapshotPath,
    },
  );
  if (alreadyRunning) {
    throw new Error(
      `Lock ocupado: sync PCA já em execução (run_id=${runId}, lock_key=${lockKey})`,
    );
  }
  report.sync_run_id = runId;

  await client.schema("private").from("pncp_sync_run").update({
    modo: "reprocessamento",
  }).eq("id", runId);

  try {
    let sourceRows: Array<{ id: string; fetched_at: string; payload: unknown }>;
    try {
      const loaded = await loadAllSourceRecords(client);
      sourceRows = loaded.rows;
      report.lidos_source_record = loaded.countExact;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.erros.push({ motivo: `fonte: ${msg}` });
      await finishSyncRun(client, runId, {
        status: "concluida_com_erros",
        totalErros: report.erros.length,
        erroPrincipal: msg,
        parametros: { report },
      });
      report.duracao_s = (Date.now() - started) / 1000;
      return report;
    }

    const latestSource = selectLatestSourceItems(sourceRows);

    let targets: PcaItemTarget[];
    try {
      const loaded = await loadAllPcaItens(client);
      targets = loaded.rows;
      report.lidos_pca_itens = loaded.countExact;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.erros.push({ motivo: `pca_itens: ${msg}` });
      await finishSyncRun(client, runId, {
        status: "concluida_com_erros",
        totalErros: report.erros.length,
        erroPrincipal: msg,
        parametros: { report },
      });
      report.duracao_s = (Date.now() - started) / 1000;
      return report;
    }

    if (options.takeSnapshot !== false && !options.dryRun) {
      const snapId = `pca-pre-p0-${nowIso.replace(/[:.]/g, "-")}`;
      const snapRows = targets.map(targetToSnapshotRow);
      let file: SnapshotFile;
      try {
        file = await readPcaItensSnapshotFile(snapshotPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          file = await writePcaItensSnapshotFile(
            snapshotPath,
            snapId,
            snapRows,
            nowIso,
          );
        } else {
          throw error;
        }
      }
      report.snapshot_path = snapshotPath;
      report.snapshot_sha256 = file.content_sha256;
    } else if (options.takeSnapshot !== false && options.dryRun) {
      report.snapshot_path = snapshotPath;
    }

    const projectedKeys = new Set(
      targets.map((t) => `${t.id_pca_pncp}|${t.numero_item}`),
    );
    for (const key of latestSource.keys()) {
      if (!projectedKeys.has(key)) report.fonte_sem_projecao += 1;
    }

    let work = targets;
    if (options.limite != null && options.limite >= 0) {
      work = targets.slice(0, options.limite);
    }
    report.alvo = work.length;

    const writer: Writer = deps?.writer ?? {
      updateItem: async (id, patch) => {
        const { data, error } = await client
          .from("pca_itens")
          .update(patch)
          .eq("id", id)
          .select("id");
        return {
          error,
          affectedCount: Array.isArray(data) ? data.length : 0,
        };
      },
    };

    const outrosCols = new Set<string>();
    const pendingWrites: Array<{ id: string; patch: Record<string, unknown> }> =
      [];

    for (const target of work) {
      const key = `${target.id_pca_pncp}|${target.numero_item}`;
      const source = latestSource.get(key);
      try {
        const decision = await decideReprojection(target, source);
        switch (decision.kind) {
          case "ja_atualizado":
            report.ja_atualizado += 1;
            break;
          case "sem_fonte":
            report.sem_fonte += 1;
            break;
          case "STALE_SOURCE_MISMATCH":
            report.STALE_SOURCE_MISMATCH += 1;
            report.stale_ids.push(target.id);
            break;
          case "atualizar": {
            if (decision.matchVersion === "v1") report.match_v1 += 1;
            else report.match_v2 += 1;
            report.diff_classificacao_catalogo_id +=
              decision.diffs.classificacao_catalogo_id;
            report.diff_pdm_codigo_origem += decision.diffs.pdm_codigo_origem;
            report.diff_codigo_item_origem += decision.diffs.codigo_item_origem;
            report.diff_outros += decision.diffs.outros;
            for (const c of decision.diffs.outros_cols) outrosCols.add(c);

            const classif = decision.patch.classificacao_catalogo_id as
              | string
              | null;
            countClassificacao(report, classif);
            if (options.dryRun) {
              report.atualizados += 1;
            }
            pendingWrites.push({ id: target.id, patch: decision.patch });
            break;
          }
          default: {
            const _never: never = decision;
            void _never;
          }
        }
      } catch (e) {
        report.erros.push({
          id: target.id,
          motivo: e instanceof Error ? e.message : String(e),
        });
      }
    }

    report.diff_outros_cols = [...outrosCols].sort();

    if (
      !options.dryRun &&
      abortOnDiffOutros &&
      report.diff_outros > 0
    ) {
      const msg = `diff_outros=${report.diff_outros} cols=[${
        report.diff_outros_cols.join(",")
      }] — abortar antes de confirmar`;
      report.erros.push({ motivo: msg });
      report.duracao_s = (Date.now() - started) / 1000;
      await finishSyncRun(client, runId, {
        status: "concluida_com_erros",
        totalErros: report.erros.length,
        erroPrincipal: msg,
        parametros: { report },
      });
      throw new Error(msg);
    }

    if (!options.dryRun) {
      for (const w of pendingWrites) {
        const { error: upErr, affectedCount } = await writer.updateItem(
          w.id,
          w.patch,
        );
        if (upErr) {
          report.erros.push({ id: w.id, motivo: upErr.message });
          continue;
        }
        if (affectedCount !== 1) {
          report.erros.push({
            id: w.id,
            motivo: `update afetou ${affectedCount} linhas`,
          });
          continue;
        }
        report.atualizados += 1;
      }
    }

    report.duracao_s = (Date.now() - started) / 1000;
    const status = report.erros.length > 0
      ? "concluida_com_erros"
      : "concluida";
    await finishSyncRun(client, runId, {
      status,
      totalRecebidos: report.alvo,
      totalAtualizados: options.dryRun ? 0 : report.atualizados,
      totalInalterados: report.ja_atualizado,
      totalErros: report.erros.length + report.STALE_SOURCE_MISMATCH,
      erroPrincipal: report.erros[0]?.motivo,
      parametros: {
        modo: "reprocessamento",
        dry_run: options.dryRun,
        snapshot_path: report.snapshot_path,
        snapshot_sha256: report.snapshot_sha256,
        report,
      },
    });
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!report.erros.some((x) => x.motivo === msg)) {
      report.erros.push({ motivo: msg });
    }
    report.duracao_s = (Date.now() - started) / 1000;
    await finishSyncRun(client, runId, {
      status: "falhou",
      totalErros: report.erros.length,
      erroPrincipal: msg,
      parametros: { report },
    });
    throw e;
  }
}
