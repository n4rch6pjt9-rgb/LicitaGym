import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "./hash.ts";
import { normalizePcaItem, normalizePcaPlano } from "./normalize.ts";
import { persistirLoteAtomico, type UnidadePcaAtomica } from "./pca-atomico.ts";

/**
 * Gravação em lote de uma página do PCA (spec 0012, PR 1).
 *
 * Normaliza e calcula payload_hash no TypeScript; a RPC privada persiste registros e histórico
 * atomicamente por bloco de até 100 unidades. Planos são persistidos antes dos itens.
 * A vinculação com o catálogo ocorre depois, fora da transação da RPC.
 *
 * Diferenças conhecidas em relação ao caminho item a item:
 * - chave repetida na página (a paginação da consulta repete itens na fronteira) é gravada uma vez, com a última
 *   ocorrência. `recebidos` conta todas as ocorrências; o caminho antigo gravava duas vezes (novo + inalterado).
 * - falha na leitura do catálogo (`catmat_pdms`, `catalogo_itens`) é aviso (spec 0056, decisão de 11/11/2026): não
 *   vincula, não conta em `erros` e vai para `avisos` com a tabela e a mensagem do PostgREST.
 * - falha da RPC é propagada sem fallback; blocos anteriores podem já ter sido confirmados.
 */

export type LoteStats = {
  recebidos: number;
  novos: number;
  alterados: number;
  inalterados: number;
  erros: number;
  /** Falhas que não invalidam a gravação (vínculo com o catálogo): "tabela: mensagem". */
  avisos?: string[];
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
 * paginado por chave estável (`id` por padrão; o chamador informa outra chave quando necessário). Erro de leitura lança: não é "nada no banco".
 */
export async function selectIn(
  client: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: unknown[],
  extra?: { column: string; values: unknown[] },
  orderColumn = "id",
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const bloco of chunks([...new Set(values)])) {
    for (let from = 0;;) {
      let query = client.from(table).select(columns).in(column, bloco);
      if (extra) query = query.in(extra.column, [...new Set(extra.values)]);
      const { data, error } = await query.order(orderColumn).range(from, from + PAGE_ROWS - 1);
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
  ids: Map<string, string>;
  novos: number;
  alterados: number;
  inalterados: number;
};

/**
 * A RPC persiste o registro e seu histórico na mesma transação.
 * Cada posição da resposta corresponde à posição da unidade enviada.
 * Qualquer falha interrompe o fluxo; não existe fallback não atômico.
 */
async function gravarAtomico(
  client: SupabaseClient,
  tabela: UnidadePcaAtomica["tabela"],
  preparados: Preparado[],
  chave: (p: Preparado) => Record<string, unknown>,
  runId: string,
): Promise<Resultado> {
  const unidades: UnidadePcaAtomica[] = preparados.map((p) => ({
    tabela,
    chave: chave(p),
    linha: p.fullRow,
  }));
  const resultados = await persistirLoteAtomico(client, unidades, runId);
  const res: Resultado = {
    ids: new Map(),
    novos: 0,
    alterados: 0,
    inalterados: 0,
  };
  for (const [indice, resultado] of resultados.entries()) {
    res.ids.set(preparados[indice].key, resultado.id);
    if (resultado.resultado === "novo") res.novos++;
    else if (resultado.resultado === "alterado") res.alterados++;
    else res.inalterados++;
  }
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
  const rPlanos = await gravarAtomico(
    client,
    "pca_planos",
    planosPrep,
    (p) => ({ id_pca_pncp: p.row.id_pca_pncp }),
    runId,
  );
  stats.novos += rPlanos.novos;
  stats.alterados += rPlanos.alterados;
  stats.inalterados += rPlanos.inalterados;

  // Os IDs retornados pela RPC associam os itens ao plano persistido.
  const entradas: { planoId: string; raw: Row; itens: Row[] }[] = [];
  for (const [chave, { raw, itens }] of planosPorChave) {
    const planoId = rPlanos.ids.get(chave);
    if (planoId) entradas.push({ planoId, raw, itens });
  }
  await gravarItensEmLote(client, entradas, stats, runId, now);
  return stats;
}

/**
 * Grava os itens de um plano que já existe no banco (sem regravar o cabeçalho). Usado pela fila (spec 0012) quando o
 * plano não apareceu na descoberta mas a integração ainda traz itens do escopo.
 */
export async function gravarItensDePlanoExistente(
  client: SupabaseClient,
  planoId: string,
  itens: Row[],
  opts: { runId: string },
): Promise<LoteStats> {
  const stats: LoteStats = { recebidos: 0, novos: 0, alterados: 0, inalterados: 0, erros: 0 };
  await gravarItensEmLote(client, [{ planoId, raw: {}, itens }], stats, opts.runId, new Date().toISOString());
  return stats;
}

async function gravarItensEmLote(
  client: SupabaseClient,
  entradas: { planoId: string; raw: Row; itens: Row[] }[],
  stats: LoteStats,
  runId: string,
  now: string,
): Promise<void> {
  // A mesma chave de item repetida: a última ocorrência vence.
  const itensPorChave = new Map<string, Row>();
  for (const { planoId, raw, itens } of entradas) {
    for (const rawItem of itens) {
      const itemRow = normalizePcaItem(rawItem, raw) as Row;
      if (!itemRow.numero_item) continue;
      stats.recebidos++;
      const row = { ...itemRow, pca_plano_id: planoId };
      itensPorChave.set(itemKey(row), row);
    }
  }
  if (itensPorChave.size === 0) return;

  const itensPrep = await Promise.all(
    [...itensPorChave.entries()].map(([k, row]) => preparar(row, k, runId, now)),
  );
  const rItens = await gravarAtomico(
    client,
    "pca_itens",
    itensPrep,
    (p) => ({
      pca_plano_id: p.row.pca_plano_id,
      numero_item: p.row.numero_item,
    }),
    runId,
  );
  stats.novos += rItens.novos;
  stats.alterados += rItens.alterados;
  stats.inalterados += rItens.inalterados;

  const avisos = await vincularOrigemEmLote(client, itensPorChave, rItens.ids, now, runId);
  if (avisos.length) stats.avisos = [...(stats.avisos ?? []), ...avisos];
}

/**
 * Equivalente em lote de `linkPcaItemOrigemCodes` (pca-origem-link.ts). Devolve as leituras do catálogo que
 * falharam ("tabela: mensagem"): o item fica sem vínculo, a falha é aviso e o sync segue.
 */
async function vincularOrigemEmLote(
  client: SupabaseClient,
  itens: Map<string, Row>,
  ids: Map<string, string>,
  now: string,
  runId: string,
): Promise<string[]> {
  const avisos: string[] = [];
  const mensagem = (error: unknown) => String((error as { message?: string })?.message ?? error);
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
        (await selectIn(
          client,
          "catmat_pdms",
          "codigo_pdm",
          "codigo_pdm",
          comPdm.map((x) => x.pdm),
          undefined,
          "codigo_pdm",
        ))
          .map((r) => Number(r.codigo_pdm)),
      );
    } catch (error) {
      avisarFalha("catmat_pdms", "select", comPdm.length, runId, error as { message?: string });
      avisos.push(`catmat_pdms: ${mensagem(error)}`);
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
      avisos.push(`catalogo_itens: ${mensagem(error)}`);
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
  return avisos;
}
