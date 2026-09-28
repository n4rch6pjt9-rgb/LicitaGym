import type {
  ActionParams,
  GetActionParams,
  LicitacaoFiltros,
  ListActionParams,
  SortField,
  SortOrder,
} from "./types.ts";

export const ALLOWED_SORT_FIELDS: Record<string, SortField> = {
  data_fim: "data_fim",
  data_publicacao: "data_publicacao",
  valor_total: "valor_total",
};

export const DEFAULT_SORT_FIELD: SortField = "data_fim";
export const DEFAULT_SORT_ORDER: SortOrder = "desc";
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function sanitizeString(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Valida formato de data ISO 8601 (YYYY-MM-DD ou com hora).
 */
export function sanitizeDate(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return undefined;
  return trimmed;
}

/**
 * Retorna true se a string representa apenas uma data no formato YYYY-MM-DD.
 */
export function isDateOnly(val: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(val);
}

/**
 * Calcula o dia seguinte (YYYY-MM-DD) para limites superiores estritos (< dia seguinte).
 * Garante que a data YYYY-MM-DD cubra todo o dia até 23:59:59.999Z.
 */
export function getNextDayIso(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return nextDate.toISOString().slice(0, 10);
}

export function sanitizeNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const parsed = Number.parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function sanitizeBoolean(val: unknown): boolean | undefined {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "t" || lower === "sim") return true;
    if (lower === "false" || lower === "0" || lower === "f" || lower === "nao") return false;
  }
  return undefined;
}

export function sanitizeStringList(val: unknown): string[] | undefined {
  if (Array.isArray(val)) {
    const list = val
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((s) => s.length > 0);
    return list.length > 0 ? list : undefined;
  }
  if (typeof val === "string") {
    const list = val
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

export function parseListParams(
  source: Record<string, unknown>,
): ListActionParams {
  const pageRaw = sanitizeNumber(source.page);
  const page = pageRaw !== undefined && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const limitRaw = sanitizeNumber(source.limit);
  const limit = limitRaw !== undefined && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const orderByRaw = sanitizeString(source.order_by);
  const order_by: SortField = orderByRaw && ALLOWED_SORT_FIELDS[orderByRaw]
    ? ALLOWED_SORT_FIELDS[orderByRaw]
    : DEFAULT_SORT_FIELD;

  const orderDirRaw = sanitizeString(source.order_direction)?.toLowerCase();
  const order_direction: SortOrder = orderDirRaw === "asc" ? "asc" : DEFAULT_SORT_ORDER;

  const filtros: LicitacaoFiltros = {
    prioridade: sanitizeString(source.prioridade),
    uf: sanitizeString(source.uf)?.toUpperCase(),
    municipio: sanitizeString(source.municipio),
    orgao_cnpj: sanitizeString(source.orgao_cnpj)?.replace(/\D/g, "") || undefined,
    orgao_nome: sanitizeString(source.orgao_nome),
    modalidade: sanitizeStringList(source.modalidade),
    situacao: sanitizeString(source.situacao),
    fase: sanitizeString(source.fase),
    categoria_escopo: sanitizeString(source.categoria_escopo),
    interesse_borracha: sanitizeBoolean(source.interesse_borracha),
    fonte: sanitizeString(source.fonte),
    data_publicacao_inicio: sanitizeDate(source.data_publicacao_inicio),
    data_publicacao_fim: sanitizeDate(source.data_publicacao_fim),
    data_inicio_min: sanitizeDate(source.data_inicio_min),
    data_inicio_max: sanitizeDate(source.data_inicio_max),
    data_fim_min: sanitizeDate(source.data_fim_min),
    data_fim_max: sanitizeDate(source.data_fim_max),
    data_homologacao_min: sanitizeDate(source.data_homologacao_min),
    data_homologacao_max: sanitizeDate(source.data_homologacao_max),
    valor_min: sanitizeNumber(source.valor_min),
    valor_max: sanitizeNumber(source.valor_max),
    busca: sanitizeString(source.busca ?? source.q),
  };

  return {
    action: "list",
    page,
    limit,
    order_by,
    order_direction,
    filtros,
  };
}

export function parseGetParams(
  source: Record<string, unknown>,
): { ok: true; params: GetActionParams } | { ok: false; error: string } {
  const idRaw = source.id;
  const codigoExterno = sanitizeString(source.codigo_externo);
  const fonte = sanitizeString(source.fonte);
  const orgaoCnpj = sanitizeString(source.orgao_cnpj)?.replace(/\D/g, "");
  const processoNorm = sanitizeString(source.processo_norm)?.replace(/\D/g, "");

  if (idRaw !== undefined && idRaw !== null && String(idRaw).trim() !== "") {
    return {
      ok: true,
      params: {
        action: "get",
        id: String(idRaw).trim(),
      },
    };
  }

  if (codigoExterno) {
    return {
      ok: true,
      params: {
        action: "get",
        codigo_externo: codigoExterno,
        ...(fonte ? { fonte } : {}),
      },
    };
  }

  if (orgaoCnpj && processoNorm) {
    return {
      ok: true,
      params: {
        action: "get",
        orgao_cnpj: orgaoCnpj,
        processo_norm: processoNorm,
      },
    };
  }

  return {
    ok: false,
    error: "Identificador ausente: informe 'id', 'codigo_externo' ou o par ('orgao_cnpj' e 'processo_norm')",
  };
}

export function parseActionFromUrl(url: URL): ActionParams | { error: string } {
  const actionParam = url.searchParams.get("action") ?? "list";

  if (actionParam === "readiness") {
    return { action: "readiness" };
  }

  if (actionParam === "get") {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      raw[key] = value;
    }
    const result = parseGetParams(raw);
    if (!result.ok) return { error: result.error };
    return result.params;
  }

  if (actionParam === "list") {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      raw[key] = value;
    }
    return parseListParams(raw);
  }

  return { error: `Ação inválida: '${actionParam}'. Use 'list', 'get' ou 'readiness'.` };
}

export function parseActionFromBody(
  body: Record<string, unknown>,
): ActionParams | { error: string } {
  const action = (body.action as string) ?? "list";

  if (action === "readiness") {
    return { action: "readiness" };
  }

  if (action === "get") {
    const result = parseGetParams(body);
    if (!result.ok) return { error: result.error };
    return result.params;
  }

  if (action === "list") {
    return parseListParams(body);
  }

  return { error: `Ação inválida: '${action}'. Use 'list', 'get' ou 'readiness'.` };
}
