import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "./hash.ts";
import { normalizePcaItem, normalizePcaPlano } from "./normalize.ts";

/**
 * Gravação em lote de uma página do PCA (spec 0012, PR 1).
 *
 * Mesma semântica de `upsertByHash` + `linkPcaItemOrigemCodes` chamados item a item: mesmo `payload_hash`,
 * mesmas colunas, histórico em `pca_alteracoes` só para novo/alterado, inalterado só toca `last_synced_at`,
 * `last_seen_sync_id` e `ativo = true`. Muda só o número de chamadas: de ~7,5 por item para algumas por página
 * (medição em specs/0012-pca-sync-cpu-pagina.md).
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
/** Limite de linhas por resposta do PostgREST (max-rows padrão do Supabase). */
const PAGE_ROWS = 1000;

function chunks<T>(values: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function selectIn(
  client: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: unknown[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const bloco of chunks([...new Set(values)])) {
    for (let from = 0;; from += PAGE_ROWS) {
      const { data, error } = await client.from(table).select(columns).in(column, bloco)
        .range(from, from + PAGE_ROWS - 1);
      // Erro de leitura não é "nada no banco": o caminho item a item também lança aqui.
      if (error) throw error;
      const page = (data ?? []) as unknown as Row[];
      rows.push(...page);
      if (page.length < PAGE_ROWS) break;
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

/**
 * Grava um conjunto de linhas já preparadas contra o estado atual (`existentes`, chave → linha completa).
 * `historyFields` monta as colunas de vínculo do histórico a partir do id da linha.
 */
async function gravar(
  client: SupabaseClient,
  table: string,
  onConflict: string,
  idColumns: string,
  keyOf: (row: Row) => string,
  itens: Preparado[],
  existentes: Map<string, Row>,
  historyFields: (id: string, p: Preparado) => Row,
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

  if (novos.length > 0) {
    const { data, error } = await client.from(table).insert(novos.map((p) => p.fullRow)).select(idColumns);
    if (error) {
      for (const p of novos) res.falhas.add(p.key);
    } else {
      const porChave = new Map(((data ?? []) as unknown as Row[]).map((r) => [keyOf(r), String(r.id)]));
      for (const p of novos) {
        const id = porChave.get(p.key);
        if (!id) {
          res.falhas.add(p.key);
          continue;
        }
        res.ids.set(p.key, id);
        res.novos++;
        historico.push({
          ...historyFields(id, p),
          tipo_operacao: "insert",
          dados_novos: p.fullRow,
          payload_hash_novo: p.hash,
          sync_run_id: runId,
        });
      }
    }
  }

  if (alterados.length > 0) {
    const { error } = await client.from(table).upsert(alterados.map((p) => p.fullRow), { onConflict });
    if (error) {
      for (const p of alterados) {
        res.falhas.add(p.key);
        res.ids.set(p.key, String(existentes.get(p.key)!.id));
      }
    } else {
      for (const p of alterados) {
        const atual = existentes.get(p.key)!;
        const id = String(atual.id);
        res.ids.set(p.key, id);
        res.alterados++;
        historico.push({
          ...historyFields(id, p),
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
    const { error } = await client.from(table)
      .update({ last_synced_at: now, last_seen_sync_id: runId, ativo: true })
      .in("id", ids);
    for (const p of bloco) {
      res.ids.set(p.key, String(existentes.get(p.key)!.id));
      if (error) res.falhas.add(p.key);
      else res.inalterados++;
    }
  }

  // Como no caminho item a item, falha ao gravar o histórico não desfaz a linha nem conta como erro.
  if (historico.length > 0) await client.from("pca_alteracoes").insert(historico);
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

  // Planos: a mesma chave pode repetir na página (a paginação da consulta repete itens na fronteira).
  // A última ocorrência vence, como no caminho item a item.
  const planosPorChave = new Map<string, { row: Row; raw: Row }>();
  for (const raw of planos) {
    const row = normalizePcaPlano(raw, ano) as Row;
    if (!row.id_pca_pncp) continue;
    stats.recebidos++;
    planosPorChave.set(planoKey(row), { row, raw });
  }
  if (planosPorChave.size === 0) return stats;

  const planosPrep = await Promise.all(
    [...planosPorChave.entries()].map(([k, v]) => preparar(v.row, k, runId, now)),
  );
  const planosExistentes = new Map(
    (await selectIn(client, "pca_planos", "*", "id_pca_pncp", [...planosPorChave.keys()]))
      .map((r) => [planoKey(r), r]),
  );
  const rPlanos = await gravar(
    client,
    "pca_planos",
    "id_pca_pncp",
    "id, id_pca_pncp",
    planoKey,
    planosPrep,
    planosExistentes,
    (id) => ({ pca_plano_id: id }),
    runId,
    now,
  );
  stats.novos += rPlanos.novos;
  stats.alterados += rPlanos.alterados;
  stats.inalterados += rPlanos.inalterados;
  stats.erros += rPlanos.falhas.size;

  // Itens dos planos com id. Plano novo cuja inserção falhou não tem id: os itens são pulados, como no caminho item a item.
  const itensPorChave = new Map<string, Row>();
  for (const [chave, { raw }] of planosPorChave) {
    const planoId = rPlanos.ids.get(chave);
    if (!planoId) continue;
    const itens = Array.isArray(raw.itens) ? raw.itens as Row[] : [];
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
  const planoIds = [...new Set([...itensPorChave.values()].map((r) => String(r.pca_plano_id)))];
  const itensExistentes = new Map(
    (await selectIn(client, "pca_itens", "*", "pca_plano_id", planoIds)).map((r) => [itemKey(r), r]),
  );
  const rItens = await gravar(
    client,
    "pca_itens",
    "pca_plano_id,numero_item",
    "id, pca_plano_id, numero_item",
    itemKey,
    itensPrep,
    itensExistentes,
    (id, p) => ({ pca_plano_id: p.row.pca_plano_id, pca_item_id: id }),
    runId,
    now,
  );
  stats.novos += rItens.novos;
  stats.alterados += rItens.alterados;
  stats.inalterados += rItens.inalterados;
  stats.erros += rItens.falhas.size;

  await vincularOrigemEmLote(client, itensPorChave, rItens.ids, now);
  return stats;
}

/** Equivalente em lote de `linkPcaItemOrigemCodes` (pca-origem-link.ts). */
async function vincularOrigemEmLote(
  client: SupabaseClient,
  itens: Map<string, Row>,
  ids: Map<string, string>,
  now: string,
) {
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
    // Leitura do catálogo: erro aqui não vira "PDM inexistente"; propaga como no select do upsert.
    const existentes = new Set(
      (await selectIn(client, "catmat_pdms", "codigo_pdm", "codigo_pdm", comPdm.map((x) => x.pdm)))
        .map((r) => Number(r.codigo_pdm)),
    );
    const linhas = comPdm.filter((x) => existentes.has(x.pdm)).map((x) => ({
      pca_item_id: x.id,
      codigo_pdm: x.pdm,
      tipo_correspondencia: "exata",
      evidencia: "pncp:pdmCodigo",
      confirmado: true,
      updated_at: now,
    }));
    if (linhas.length > 0) {
      await client.from("pca_item_pdm").upsert(linhas, { onConflict: "pca_item_id,codigo_pdm" });
    }
  }

  if (comCodigo.length > 0) {
    const porCodigo = new Map<string, string[]>();
    for (const r of await selectIn(client, "catalogo_itens", "id, codigo_catmat", "codigo_catmat", comCodigo.map((x) => x.codigo))) {
      const k = String(r.codigo_catmat);
      porCodigo.set(k, [...(porCodigo.get(k) ?? []), String(r.id)]);
    }
    const vistos = new Set<string>();
    const linhas: Row[] = [];
    for (const x of comCodigo) {
      const cat = porCodigo.get(x.codigo);
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
      await client.from("catalogo_ponte").upsert(linhas, {
        onConflict: "catalogo_item_id,entidade_tipo,entidade_id",
      });
    }
  }
}
