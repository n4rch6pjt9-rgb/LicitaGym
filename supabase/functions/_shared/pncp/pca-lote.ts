import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "./hash.ts";
import { normalizePcaItem, normalizePcaPlano } from "./normalize.ts";
import { upsertByHash } from "./upsert.ts";

/**
 * Gravação em lote de uma página do PCA (spec 0012, PR 1).
 *
 * Mesma semântica de `upsertByHash` + `linkPcaItemOrigemCodes` chamados item a item: mesmo `payload_hash`,
 * mesmas colunas, histórico em `pca_alteracoes` só para novo/alterado, inalterado só toca `last_synced_at`,
 * `last_seen_sync_id` e `ativo = true`. Muda o número de chamadas: de ~7,5 por item para algumas por página
 * (medição em specs/0012-pca-sync-cpu-pagina.md).
 *
 * Diferenças conhecidas em relação ao caminho item a item:
 * - chave repetida na página (a paginação da consulta repete itens na fronteira) é gravada uma vez, com a última
 *   ocorrência. `recebidos` conta todas as ocorrências; o caminho antigo gravava duas vezes (novo + inalterado).
 * - falha na leitura do catálogo (`catmat_pdms`, `catalogo_itens`) conta em `erros` e não vincula; o caminho antigo
 *   ignorava o erro sem contar.
 */

export type LoteStats = {
  recebidos: number;
  novos: number;
  alterados: number;
  inalterados: number;
  erros: number;
};

type Row = Record<string, unknown>;

/** Tamanho dos blocos de `in (...)`: mantém a URL do PostgREST curta. */
const IN_CHUNK = 100;
/** Linhas pedidas por requisição. O PostgREST pode devolver menos (max-rows); a leitura só para em página vazia. */
const PAGE_ROWS = 1000;

/** Falha de escrita ou leitura em lote: tabela, operação, contagem, runId e a mensagem do PostgREST (sem payload). */
function avisarFalha(table: string, op: string, linhas: number, runId: string, error: { message?: string } | null) {
  if (!error) return;
  console.warn(JSON.stringify({ evento: "pca_lote_falha", table, op, linhas, runId, erro: error.message ?? "?" }));
}

function chunks<T>(values: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * `select columns from table where column in (values) [and extra.column in (extra.values)]`, em blocos e
 * paginado com ordem estável por `id`. Erro de leitura lança: não é "nada no banco".
 */
export async function selectIn(
  client: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: unknown[],
  extra?: { column: string; values: unknown[] },
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const bloco of chunks([...new Set(values)])) {
    for (let from = 0;;) {
      let query = client.from(table).select(columns).in(column, bloco);
      if (extra) query = query.in(extra.column, [...new Set(extra.values)]);
      const { data, error } = await query.order("id").range(from, from + PAGE_ROWS - 1);
      if (error) throw error;
      const page = (data ?? []) as unknown as Row[];
      if (page.length === 0) break;
      rows.push(...page);
      from += page.length;
    }
  }
  return rows;
}

type Preparado = { key: string; row: Row; fullRow: Row; hash: string };

async function preparar(row: Row, key: string, runId: string, now: string): Promise<Preparado> {
  const hash = await hashPayload(row);
  return {
    key,
    row,
    hash,
    fullRow: {
      ...row,
      payload_hash: hash,
      updated_at: now,
      last_synced_at: now,
      last_seen_sync_id: runId,
    },
  };
}

type Resultado = {
  /**
   * chave natural → id da linha no banco. Inclui linha existente cuja atualização falhou: no caminho item a item ela
   * continua sendo achada pela busca seguinte, e os itens/vínculos dela seguem sendo processados.
   */
  ids: Map<string, string>;
  /** chaves cuja gravação falhou. */
  falhas: Set<string>;
  novos: number;
  alterados: number;
  inalterados: number;
};

type Tabela = {
  table: string;
  onConflict: string;
  idColumns: string;
  keyOf: (row: Row) => string;
  uniqueKeyOf: (p: Preparado) => Row;
  historyFields: (id: string, p: Preparado) => Row;
};

/**
 * Lote que falhou (linha inválida, corrida com outra execução): refaz só aquele bloco linha a linha, com o
 * `upsertByHash` do caminho antigo, para que uma linha ruim não derrube as outras.
 */
async function gravarLinhaALinha(
  client: SupabaseClient,
  t: Tabela,
  bloco: Preparado[],
  res: Resultado,
  runId: string,
) {
  for (const p of bloco) {
    const r = await upsertByHash(client, t.table, t.uniqueKeyOf(p), p.row, {
      historyTable: "pca_alteracoes",
      historyFields: ({ rowId }) => t.historyFields(rowId, p),
      syncRunId: runId,
      lastSeenSyncId: runId,
      reactivateOnUnchanged: true,
    });
    let query = client.from(t.table).select("id");
    for (const [k, v] of Object.entries(t.uniqueKeyOf(p))) query = query.eq(k, v);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (data) res.ids.set(p.key, String((data as Row).id));
    if (r === "novo") res.novos++;
    else if (r === "alterado") res.alterados++;
    else if (r === "inalterado") res.inalterados++;
    else res.falhas.add(p.key);
  }
}

/** Grava linhas já preparadas contra o estado atual (`existentes`, chave → linha completa). */
async function gravar(
  client: SupabaseClient,
  t: Tabela,
  itens: Preparado[],
  existentes: Map<string, Row>,
  runId: string,
  now: string,
): Promise<Resultado> {
  const res: Resultado = { ids: new Map(), falhas: new Set(), novos: 0, alterados: 0, inalterados: 0 };
  const novos: Preparado[] = [];
  const alterados: Preparado[] = [];
  const inalterados: Preparado[] = [];
  for (const p of itens) {
    const atual = existentes.get(p.key);
    if (!atual) novos.push(p);
    else if (String(atual.payload_hash) === p.hash) inalterados.push(p);
    else alterados.push(p);
  }
  const historico: Row[] = [];
  const refazer: Preparado[] = [];

  if (novos.length > 0) {
    const { data, error } = await client.from(t.table).insert(novos.map((p) => p.fullRow)).select(t.idColumns);
    avisarFalha(t.table, "insert", novos.length, runId, error);
    if (error) {
      refazer.push(...novos);
    } else {
      const porChave = new Map(((data ?? []) as unknown as Row[]).map((r) => [t.keyOf(r), String(r.id)]));
      for (const p of novos) {
        const id = porChave.get(p.key);
        if (!id) {
          refazer.push(p);
          continue;
        }
        res.ids.set(p.key, id);
        res.novos++;
        historico.push({
          ...t.historyFields(id, p),
          tipo_operacao: "insert",
          dados_novos: p.fullRow,
          payload_hash_novo: p.hash,
          sync_run_id: runId,
        });
      }
    }
  }

  if (alterados.length > 0) {
    const { error } = await client.from(t.table).upsert(alterados.map((p) => p.fullRow), {
      onConflict: t.onConflict,
    });
    avisarFalha(t.table, "upsert", alterados.length, runId, error);
    if (error) {
      refazer.push(...alterados);
    } else {
      for (const p of alterados) {
        const atual = existentes.get(p.key)!;
        const id = String(atual.id);
        res.ids.set(p.key, id);
        res.alterados++;
        historico.push({
          ...t.historyFields(id, p),
          tipo_operacao: "update",
          dados_anteriores: atual,
          dados_novos: p.fullRow,
          payload_hash_anterior: String(atual.payload_hash),
          payload_hash_novo: p.hash,
          sync_run_id: runId,
        });
      }
    }
  }

  for (const bloco of chunks(inalterados)) {
    const ids = bloco.map((p) => String(existentes.get(p.key)!.id));
    const { error } = await client.from(t.table)
      .update({ last_synced_at: now, last_seen_sync_id: runId, ativo: true })
      .in("id", ids);
    avisarFalha(t.table, "update", bloco.length, runId, error);
    if (error) {
      refazer.push(...bloco);
      continue;
    }
    for (const p of bloco) {
      res.ids.set(p.key, String(existentes.get(p.key)!.id));
      res.inalterados++;
    }
  }

  // Como no caminho item a item, falha ao gravar o histórico não desfaz a linha nem conta como erro.
  if (historico.length > 0) {
    const { error } = await client.from("pca_alteracoes").insert(historico);
    avisarFalha("pca_alteracoes", "insert", historico.length, runId, error);
  }
  if (refazer.length > 0) await gravarLinhaALinha(client, t, refazer, res, runId);
  return res;
}

const planoKey = (r: Row) => String(r.id_pca_pncp);
const itemKey = (r: Row) => `${r.pca_plano_id}|${r.numero_item}`;

/** Grava os planos e itens de uma página da consulta `/pca/` e os vínculos de origem (PDM e catálogo). */
export async function gravarPaginaPcaEmLote(
  client: SupabaseClient,
  planos: Row[],
  opts: { ano: number; runId: string },
): Promise<LoteStats> {
  const { ano, runId } = opts;
  const now = new Date().toISOString();
  const stats: LoteStats = { recebidos: 0, novos: 0, alterados: 0, inalterados: 0, erros: 0 };

  // O mesmo plano pode aparecer mais de uma vez na página, com itens diferentes em cada ocorrência (a consulta
  // pagina por item). A linha do plano é a da última ocorrência; os itens de todas as ocorrências são somados.
  const planosPorChave = new Map<string, { row: Row; raw: Row; itens: Row[] }>();
  for (const raw of planos) {
    const row = normalizePcaPlano(raw, ano) as Row;
    if (!row.id_pca_pncp) continue;
    stats.recebidos++;
    const itens = Array.isArray(raw.itens) ? raw.itens as Row[] : [];
    const anterior = planosPorChave.get(planoKey(row));
    planosPorChave.set(planoKey(row), { row, raw, itens: [...(anterior?.itens ?? []), ...itens] });
  }
  if (planosPorChave.size === 0) return stats;

  const planosPrep = await Promise.all(
    [...planosPorChave.entries()].map(([k, v]) => preparar(v.row, k, runId, now)),
  );
  const planosExistentes = new Map(
    (await selectIn(client, "pca_planos", "*", "id_pca_pncp", [...planosPorChave.keys()]))
      .map((r) => [planoKey(r), r]),
  );
  const rPlanos = await gravar(client, {
    table: "pca_planos",
    onConflict: "id_pca_pncp",
    idColumns: "id, id_pca_pncp",
    keyOf: planoKey,
    uniqueKeyOf: (p) => ({ id_pca_pncp: p.row.id_pca_pncp }),
    historyFields: (id) => ({ pca_plano_id: id }),
  }, planosPrep, planosExistentes, runId, now);
  stats.novos += rPlanos.novos;
  stats.alterados += rPlanos.alterados;
  stats.inalterados += rPlanos.inalterados;
  stats.erros += rPlanos.falhas.size;

  // Itens dos planos com id. Plano novo cuja inserção falhou não tem id: os itens são pulados, como no caminho
  // item a item. A mesma chave de item repetida: a última ocorrência vence.
  const itensPorChave = new Map<string, Row>();
  for (const [chave, { raw, itens }] of planosPorChave) {
    const planoId = rPlanos.ids.get(chave);
    if (!planoId) continue;
    for (const rawItem of itens) {
      const itemRow = normalizePcaItem(rawItem, raw) as Row;
      if (!itemRow.numero_item) continue;
      stats.recebidos++;
      const row = { ...itemRow, pca_plano_id: planoId };
      itensPorChave.set(itemKey(row), row);
    }
  }
  if (itensPorChave.size === 0) return stats;

  const itensPrep = await Promise.all(
    [...itensPorChave.entries()].map(([k, row]) => preparar(row, k, runId, now)),
  );
  const valores = [...itensPorChave.values()];
  // Só os itens desta página (superconjunto pequeno): plano grande espalhado em várias páginas não é relido inteiro.
  const itensExistentes = new Map(
    (await selectIn(client, "pca_itens", "*", "pca_plano_id", valores.map((r) => r.pca_plano_id), {
      column: "numero_item",
      values: valores.map((r) => r.numero_item),
    })).filter((r) => itensPorChave.has(itemKey(r))).map((r) => [itemKey(r), r]),
  );
  const rItens = await gravar(client, {
    table: "pca_itens",
    onConflict: "pca_plano_id,numero_item",
    idColumns: "id, pca_plano_id, numero_item",
    keyOf: itemKey,
    uniqueKeyOf: (p) => ({ pca_plano_id: p.row.pca_plano_id, numero_item: p.row.numero_item }),
    historyFields: (id, p) => ({ pca_plano_id: p.row.pca_plano_id, pca_item_id: id }),
  }, itensPrep, itensExistentes, runId, now);
  stats.novos += rItens.novos;
  stats.alterados += rItens.alterados;
  stats.inalterados += rItens.inalterados;
  stats.erros += rItens.falhas.size;

  stats.erros += await vincularOrigemEmLote(client, itensPorChave, rItens.ids, now, runId);
  return stats;
}

/**
 * Equivalente em lote de `linkPcaItemOrigemCodes` (pca-origem-link.ts). Devolve o número de leituras do catálogo
 * que falharam: o item fica sem vínculo, a falha entra em `erros` e o sync segue.
 */
async function vincularOrigemEmLote(
  client: SupabaseClient,
  itens: Map<string, Row>,
  ids: Map<string, string>,
  now: string,
  runId: string,
): Promise<number> {
  let erros = 0;
  const comPdm: { id: string; pdm: number }[] = [];
  const comCodigo: { id: string; codigo: string }[] = [];
  for (const [chave, row] of itens) {
    const id = ids.get(chave);
    if (!id) continue;
    const pdm = typeof row.pdm_codigo_origem === "string" ? row.pdm_codigo_origem.trim() : "";
    if (pdm && /^\d+$/.test(pdm)) comPdm.push({ id, pdm: Number(pdm) });
    const codigo = typeof row.codigo_item_origem === "string" ? row.codigo_item_origem.trim() : "";
    if (codigo) comCodigo.push({ id, codigo });
  }

  if (comPdm.length > 0) {
    let existentes: Set<number> | null = null;
    try {
      existentes = new Set(
        (await selectIn(client, "catmat_pdms", "codigo_pdm", "codigo_pdm", comPdm.map((x) => x.pdm)))
          .map((r) => Number(r.codigo_pdm)),
      );
    } catch (error) {
      avisarFalha("catmat_pdms", "select", comPdm.length, runId, error as { message?: string });
      erros++;
    }
    const linhas = existentes
      ? comPdm.filter((x) => existentes!.has(x.pdm)).map((x) => ({
        pca_item_id: x.id,
        codigo_pdm: x.pdm,
        tipo_correspondencia: "exata",
        evidencia: "pncp:pdmCodigo",
        confirmado: true,
        updated_at: now,
      }))
      : [];
    if (linhas.length > 0) {
      const { error } = await client.from("pca_item_pdm").upsert(linhas, { onConflict: "pca_item_id,codigo_pdm" });
      avisarFalha("pca_item_pdm", "upsert", linhas.length, runId, error);
    }
  }

  if (comCodigo.length > 0) {
    let porCodigo: Map<string, string[]> | null = null;
    try {
      porCodigo = new Map();
      const lidos = await selectIn(
        client,
        "catalogo_itens",
        "id, codigo_catmat",
        "codigo_catmat",
        comCodigo.map((x) => x.codigo),
      );
      for (const r of lidos) {
        const k = String(r.codigo_catmat);
        porCodigo.set(k, [...(porCodigo.get(k) ?? []), String(r.id)]);
      }
    } catch (error) {
      avisarFalha("catalogo_itens", "select", comCodigo.length, runId, error as { message?: string });
      erros++;
      porCodigo = null;
    }
    const vistos = new Set<string>();
    const linhas: Row[] = [];
    for (const x of porCodigo ? comCodigo : []) {
      const cat = porCodigo!.get(x.codigo);
      // `maybeSingle` no caminho item a item não vincula quando o código casa mais de um item do catálogo.
      if (!cat || cat.length !== 1) continue;
      const k = `${cat[0]}|${x.id}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      linhas.push({
        catalogo_item_id: cat[0],
        entidade_tipo: "pca_item",
        entidade_id: x.id,
        tipo_correspondencia: "exata",
        evidencia: "pncp:codigoItem",
      });
    }
    if (linhas.length > 0) {
      const { error } = await client.from("catalogo_ponte").upsert(linhas, {
        onConflict: "catalogo_item_id,entidade_tipo,entidade_id",
      });
      avisarFalha("catalogo_ponte", "upsert", linhas.length, runId, error);
    }
  }
  return erros;
}
