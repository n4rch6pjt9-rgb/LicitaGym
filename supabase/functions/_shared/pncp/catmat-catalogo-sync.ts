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

export type CatalogoContinuation = {
  offset_pdm: number;
  pending: { offset_pdm: number }[];
};

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

/**
 * Corpo vazio ou modo "catalogo" sincroniza os PDMs efetivos.
 * modo "classe", ou par grupo/classe explícito, segue a política fixa.
 */
export function deveSincronizarCatalogo(body: {
  modo?: string;
  codigo_grupo?: number;
  codigo_classe?: number;
}): boolean {
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

export function fatiaPdms(
  pdms: readonly PdmEfetivo[],
  offset: number,
  limite: number | undefined,
): { fatia: PdmEfetivo[]; proximo: number | null } {
  const inicio = Math.max(0, offset);
  const fatia = limite == null ? pdms.slice(inicio) : pdms.slice(inicio, inicio + Math.max(0, limite));
  if (fatia.length === 0) return { fatia, proximo: null };
  const fim = inicio + fatia.length;
  return { fatia, proximo: fim < pdms.length ? fim : null };
}

export function continuationCatalogo(offsetPdm: number): CatalogoContinuation {
  return { offset_pdm: offsetPdm, pending: [{ offset_pdm: offsetPdm }] };
}

export function offsetPdmDaContinuation(continuation: unknown): number | null {
  if (!continuation || typeof continuation !== "object") return null;
  const record = continuation as { offset_pdm?: unknown; pending?: unknown };
  const direto = inteiro(record.offset_pdm);
  if (direto != null && direto >= 0) return direto;
  if (!Array.isArray(record.pending) || record.pending.length === 0) return null;
  const primeiro = record.pending[0];
  if (!primeiro || typeof primeiro !== "object") return null;
  const aninhado = inteiro((primeiro as { offset_pdm?: unknown }).offset_pdm);
  if (aninhado != null && aninhado >= 0) return aninhado;
  return null;
}

/**
 * offset do corpo vence. Sem offset, herda continuation (inclusive 0).
 * somente_retomada sem continuation não dispara uma carga nova.
 */
export function decidirInicioCatalogo(input: {
  bodyOffset?: number;
  inheritedContinuation: unknown;
  somenteRetomada: boolean;
}): { pular: boolean; offset: number } {
  if (typeof input.bodyOffset === "number" && input.bodyOffset >= 0) {
    return { pular: false, offset: input.bodyOffset };
  }
  const herdado = offsetPdmDaContinuation(input.inheritedContinuation);
  if (herdado != null) return { pular: false, offset: herdado };
  if (input.somenteRetomada) return { pular: true, offset: 0 };
  return { pular: false, offset: 0 };
}

export function linhaCatmatItemPdm(raw: {
  codigoItem?: number;
  codigoPdm?: number;
  codigoClasse?: number;
  codigoGrupo?: number;
  descricaoItem?: string;
  statusItem?: boolean;
}): {
  codigo_item: number;
  codigo_pdm: number;
  codigo_classe: number;
  codigo_grupo: number;
  descricao: string;
  status_item: boolean;
} | null {
  const codigo_item = inteiro(raw.codigoItem);
  const codigo_pdm = inteiro(raw.codigoPdm);
  const codigo_classe = inteiro(raw.codigoClasse);
  const codigo_grupo = inteiro(raw.codigoGrupo);
  if (codigo_item == null || codigo_pdm == null || codigo_classe == null || codigo_grupo == null) {
    return null;
  }
  const descricao = String(raw.descricaoItem ?? codigo_item).trim();
  return {
    codigo_item,
    codigo_pdm,
    codigo_classe,
    codigo_grupo,
    descricao,
    status_item: raw.statusItem !== false,
  };
}
