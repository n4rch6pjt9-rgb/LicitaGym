#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
/**
 * Reprojeção P0: alinha pca_itens ao mapper atual a partir de source_record.
 *
 * Uso:
 *   deno run -A scripts/ops/reprojetar-pca-classificacao.ts
 *   deno run -A scripts/ops/reprojetar-pca-classificacao.ts --limite 50 --confirmar
 *   deno run -A scripts/ops/reprojetar-pca-classificacao.ts --snapshot-only
 *   deno run -A scripts/ops/reprojetar-pca-classificacao.ts --rollback --snapshot-file var/p0/….json
 *
 * Padrão: --dry-run (não grava). Exige SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Snapshot: JSON em var/p0/ (fora do git) + SHA-256 no log.
 */
import { createServiceClient } from "../../supabase/functions/_shared/pncp/supabase-admin.ts";
import {
  DEFAULT_PCA_REPROJECTION_LOCK_KEY,
  defaultSnapshotPath,
  loadAllPcaItens,
  restorePcaItensSnapshotFromFile,
  runPcaReprojecaoClassificacao,
  writePcaItensSnapshotFile,
} from "../../supabase/functions/_shared/pncp/pca-reprojecao.ts";

function parseArgs(argv: string[]) {
  const out = {
    dryRun: true,
    confirmar: false,
    limite: undefined as number | undefined,
    lockKey: DEFAULT_PCA_REPROJECTION_LOCK_KEY,
    snapshotFile: undefined as string | undefined,
    rollback: false,
    snapshotOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirmar") {
      out.confirmar = true;
      out.dryRun = false;
    } else if (a === "--dry-run") {
      out.dryRun = true;
      out.confirmar = false;
    } else if (a === "--limite") {
      out.limite = Number(argv[++i]);
    } else if (a === "--lock-key") {
      out.lockKey = argv[++i];
    } else if (a === "--snapshot-file" || a === "--snapshot-id") {
      // --snapshot-id aceito como alias legado → path
      out.snapshotFile = argv[++i];
    } else if (a === "--rollback") {
      out.rollback = true;
    } else if (a === "--snapshot-only") {
      out.snapshotOnly = true;
    }
  }
  return out;
}

const args = parseArgs(Deno.args);
const client = createServiceClient();

if (args.rollback) {
  if (!args.snapshotFile) {
    console.error("--rollback exige --snapshot-file path.json");
    Deno.exit(2);
  }
  const n = await restorePcaItensSnapshotFromFile(client, args.snapshotFile);
  console.log(JSON.stringify({
    rollback: true,
    snapshot_file: args.snapshotFile,
    restored: n,
  }, null, 2));
  Deno.exit(0);
}

if (args.snapshotOnly) {
  const nowIso = new Date().toISOString();
  const path = args.snapshotFile ?? defaultSnapshotPath(nowIso);
  const snapId = `pca-pre-p0-${nowIso.replace(/[:.]/g, "-")}`;
  const { rows } = await loadAllPcaItens(client);
  const snapRows = rows.map((t) => ({
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
  }));
  const file = await writePcaItensSnapshotFile(path, snapId, snapRows, nowIso);
  console.log(JSON.stringify({
    snapshot_id: file.snapshot_id,
    snapshot_file: path,
    rows: file.row_count,
    content_sha256: file.content_sha256,
  }, null, 2));
  Deno.exit(0);
}

try {
  const report = await runPcaReprojecaoClassificacao(client, {
    dryRun: args.dryRun,
    limite: args.limite,
    lockKey: args.lockKey,
    snapshotPath: args.snapshotFile,
    takeSnapshot: !args.dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.erros.length > 0) Deno.exit(2);
  if (report.diff_outros > 0 && args.dryRun) {
    console.error(
      `ATENÇÃO: diff_outros=${report.diff_outros} — não rode --confirmar sem investigar`,
    );
    Deno.exit(3);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  Deno.exit(1);
}
