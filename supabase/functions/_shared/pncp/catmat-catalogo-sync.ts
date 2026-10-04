/**
 * Sync CATMAT pelo catálogo da empresa.
 * A lista de PDMs vem de public.catalogo_catmat_pdms_efetivos().
 * A política TRANSITIONAL_FITNESS_SCOPE continua no PCA, no link e nos órgãos.
 */

import { COMPRAS_GOV_PAGE_SIZE } from "../compras-gov/material-client.ts";

/** Padrão do sync periódico: só itens ativos. Ver resolverIncluirInativos. */
export const CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO = false;

export const CATMAT_SYNC_INCLUIR_INATIVOS_ENV = "CATMAT_SYNC_INCLUIR_INATIVOS";

/** Página do modulo-material. Igual a COMPRAS_GOV_PAGE_SIZE.default. */
export const CATMAT_TAMANHO_PAGINA = COMPRAS_GOV_PAGE_SIZE.default;

export const CATMAT_SYNC_LOCK_CATALOGO = "compras-catmat:catalogo";

export type PdmEfetivo = {
  codigo_pdm: number;
  codigo_classe: number;
  codigo_grupo: number;
};

/** Próximo codigo_pdm a processar (inclusive). Não é índice da lista. */
export type CatalogoContinuation = {
  codigo_pdm: number;
  pending: { codigo_pdm: number }[];
};

/** Item oficial incompleto: a página inteira falha, o run não conclui. */
export class ItemCatmatInvalidoError extends Error {
  constructor() {
    super("Item CATMAT sem codigoItem, codigoPdm, codigoClasse ou codigoGrupo oficial");
    this.name = "ItemCatmatInvalidoError";
  }
}

function inteiro(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Precedência: corpo da requisição, depois env CATMAT_SYNC_INCLUIR_INATIVOS
 * ("true" | "false"), depois CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO (false).
 * false manda statusItem=true. true omite o filtro e grava status_item oficial.
 */
export function resolverIncluirInativos(
  body: { incluir_inativos?: boolean },
  envValue?: string | null,
): boolean {
  if (typeof body.incluir_inativos === "boolean") return body.incluir_inativos;
  const env = envValue === undefined
    ? Deno.env.get(CATMAT_SYNC_INCLUIR_INATIVOS_ENV)
    : envValue;
  if (env === "true") return true;
  if (env === "false") return false;
  return CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO;
}

/** modo presente e diferente de catalogo/classe. Corpo sem modo não é desconhecido. */
export function modoDesconhecido(modo: unknown): boolean {
  if (modo == null || modo === "") return false;
  return modo !== "catalogo" && modo !== "classe";
}

/**
 * JSON inválido não vira {}. Corpo vazio é objeto vazio (o cron manda o modo no corpo).
 */
export function parseCorpoSync(
  text: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON do corpo precisa ser um objeto" };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "JSON inválido" };
  }
}

/**
 * Corpo vazio ou modo "catalogo" sincroniza os PDMs efetivos.
 * modo "classe", ou par grupo/classe explícito, segue a política fixa.
 * modo desconhecido não escolhe o catálogo: o handler responde 400.
 */
export function deveSincronizarCatalogo(body: {
  modo?: string;
  codigo_grupo?: number;
  codigo_classe?: number;
}): boolean {
  if (modoDesconhecido(body.modo)) return false;
  if (body.modo === "classe") return false;
  if (body.modo === "catalogo") return true;
  return body.codigo_grupo == null && body.codigo_classe == null;
}

/** Características continuam no sync por classe: o modo catálogo não as promete. */
export function bloqueioModoCatalogo(body: {
  incluir_caracteristicas?: boolean;
  somente_caracteristicas?: boolean;
}): string | null {
  if (body.somente_caracteristicas || body.incluir_caracteristicas) {
    return "Características ficam no sync por classe (incluir_caracteristicas / somente_caracteristicas). O modo catálogo sincroniza itens, naturezas e unidades dos PDMs efetivos.";
  }
  return null;
}

export function normalizarPdmsEfetivos(rows: unknown): PdmEfetivo[] {
  if (!Array.isArray(rows)) return [];
  const vistos = new Set<number>();
  const out: PdmEfetivo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const codigo_pdm = inteiro(record.codigo_pdm);
    const codigo_classe = inteiro(record.codigo_classe);
    const codigo_grupo = inteiro(record.codigo_grupo);
    if (codigo_pdm == null || codigo_classe == null || codigo_grupo == null) continue;
    if (vistos.has(codigo_pdm)) continue;
    vistos.add(codigo_pdm);
    out.push({ codigo_pdm, codigo_classe, codigo_grupo });
  }
  out.sort((a, b) => a.codigo_pdm - b.codigo_pdm);
  return out;
}

export function paramsItemDoPdm(
  pdm: PdmEfetivo,
  incluirInativos: boolean,
): { codigoPdm: number; statusItem?: true } {
  return incluirInativos
    ? { codigoPdm: pdm.codigo_pdm }
    : { codigoPdm: pdm.codigo_pdm, statusItem: true };
}

/**
 * Fatia a partir de um codigo_pdm (inclusive), não de um índice.
 * Remover um PDM já processado não desloca o cursor.
 */
export function fatiaPdms(
  pdms: readonly PdmEfetivo[],
  aPartirDe: number,
  limite: number | undefined,
): { fatia: PdmEfetivo[]; proximo: number | null } {
  const elegiveis = pdms.filter((p) => p.codigo_pdm >= aPartirDe);
  const fatia = limite == null ? elegiveis : elegiveis.slice(0, Math.max(0, limite));
  if (fatia.length === 0) return { fatia, proximo: null };
  return {
    fatia,
    proximo: elegiveis.length > fatia.length ? elegiveis[fatia.length].codigo_pdm : null,
  };
}

export function continuationCatalogo(codigoPdm: number): CatalogoContinuation {
  return { codigo_pdm: codigoPdm, pending: [{ codigo_pdm: codigoPdm }] };
}

/** Só lê codigo_pdm. offset_pdm antigo era índice e é ignorado. */
export function codigoPdmDaContinuation(continuation: unknown): number | null {
  if (!continuation || typeof continuation !== "object") return null;
  const record = continuation as { codigo_pdm?: unknown; pending?: unknown };
  const direto = inteiro(record.codigo_pdm);
  if (direto != null && direto >= 0) return direto;
  if (!Array.isArray(record.pending) || record.pending.length === 0) return null;
  const primeiro = record.pending[0];
  if (!primeiro || typeof primeiro !== "object") return null;
  const aninhado = inteiro((primeiro as { codigo_pdm?: unknown }).codigo_pdm);
  if (aninhado != null && aninhado >= 0) return aninhado;
  return null;
}

/**
 * codigo_pdm do corpo vence. Sem ele, herda continuation.
 * somente_retomada sem continuation não dispara uma carga nova.
 * 0 significa o início da lista ordenada.
 */
export function decidirInicioCatalogo(input: {
  bodyCodigoPdm?: number;
  inheritedContinuation: unknown;
  somenteRetomada: boolean;
}): { pular: boolean; codigoPdm: number } {
  if (typeof input.bodyCodigoPdm === "number" && input.bodyCodigoPdm >= 0) {
    return { pular: false, codigoPdm: input.bodyCodigoPdm };
  }
  const herdado = codigoPdmDaContinuation(input.inheritedContinuation);
  if (herdado != null) return { pular: false, codigoPdm: herdado };
  if (input.somenteRetomada) return { pular: true, codigoPdm: 0 };
  return { pular: false, codigoPdm: 0 };
}

function statusOficial(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/**
 * Identificadores oficiais obrigatórios. Descrição ausente fica null
 * (catmat_item_pdm aceita). status ausente ou desconhecido fica null:
 * não vira ativo.
 */
export function linhaCatmatItemPdm(raw: unknown): {
  codigo_item: number;
  codigo_pdm: number;
  codigo_classe: number;
  codigo_grupo: number;
  descricao: string | null;
  status_item: boolean | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const codigo_item = inteiro(record.codigoItem);
  const codigo_pdm = inteiro(record.codigoPdm);
  const codigo_classe = inteiro(record.codigoClasse);
  const codigo_grupo = inteiro(record.codigoGrupo);
  if (codigo_item == null || codigo_pdm == null || codigo_classe == null || codigo_grupo == null) {
    return null;
  }
  const descricao = typeof record.descricaoItem === "string" && record.descricaoItem.trim()
    ? record.descricaoItem.trim()
    : null;
  return {
    codigo_item,
    codigo_pdm,
    codigo_classe,
    codigo_grupo,
    descricao,
    status_item: statusOficial(record.statusItem),
  };
}

/** Falha a página inteira se algum item não tiver os códigos oficiais. */
export function exigirItensOficiais(raws: readonly unknown[]): NonNullable<ReturnType<typeof linhaCatmatItemPdm>>[] {
  const linhas = [];
  for (const raw of raws) {
    const linha = linhaCatmatItemPdm(raw);
    if (!linha) throw new ItemCatmatInvalidoError();
    linhas.push(linha);
  }
  return linhas;
}
