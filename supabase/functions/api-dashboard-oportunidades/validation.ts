import type {
  ActionParams,
  GetActionParams,
  LicitacaoFiltros,
  ListActionParams,
  SortField,
  SortOrder,
} from "./types.ts";
import { sanitizeSearchTerm } from "./query.ts";

export const ALLOWED_SORT_FIELDS: Record<string, SortField> = {
  data_fim: "data_fim",
  data_publicacao: "data_publicacao",
  valor_total: "valor_total",
};

export const DEFAULT_SORT_FIELD: SortField = "data_fim";
export const DEFAULT_SORT_ORDER: SortOrder = "desc";
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 10000;

export function validatePagination(
  pageRaw: unknown,
  limitRaw: unknown,
): { page: number; limit: number; offset: number } | { error: string } {
  // Page validation: inteiro seguro >= 1 ou default quando ausente/vazio
  let page = 1;
  if (pageRaw !== undefined && pageRaw !== null && pageRaw !== "") {
    if (typeof pageRaw === "number") {
      if (!Number.isSafeInteger(pageRaw) || pageRaw < 1) {
        return { error: "Parâmetro 'page' deve ser um número inteiro maior ou igual a 1." };
      }
      page = pageRaw;
    } else if (typeof pageRaw === "string") {
      const trimmed = pageRaw.trim();
      if (!/^\d+$/.test(trimmed) || trimmed === "0") {
        return { error: "Parâmetro 'page' deve ser um número inteiro maior ou igual a 1." };
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return { error: "Parâmetro 'page' deve ser um número inteiro maior ou igual a 1." };
      }
      page = parsed;
    } else {
      return { error: "Parâmetro 'page' deve ser um número inteiro maior ou igual a 1." };
    }
  }

  // Limit validation: inteiro seguro >= 1 e <= 100 ou default quando ausente/vazio
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== "") {
    if (typeof limitRaw === "number") {
      if (!Number.isSafeInteger(limitRaw) || limitRaw < 1) {
        return { error: "Parâmetro 'limit' deve ser um número inteiro maior ou igual a 1." };
      }
      if (limitRaw > MAX_LIMIT) {
        return { error: `Parâmetro 'limit' não pode ser maior que ${MAX_LIMIT}.` };
      }
      limit = limitRaw;
    } else if (typeof limitRaw === "string") {
      const trimmed = limitRaw.trim();
      if (!/^\d+$/.test(trimmed) || trimmed === "0") {
        return { error: "Parâmetro 'limit' deve ser um número inteiro maior ou igual a 1." };
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return { error: "Parâmetro 'limit' deve ser um número inteiro maior ou igual a 1." };
      }
      if (parsed > MAX_LIMIT) {
        return { error: `Parâmetro 'limit' não pode ser maior que ${MAX_LIMIT}.` };
      }
      limit = parsed;
    } else {
      return { error: "Parâmetro 'limit' deve ser um número inteiro maior ou igual a 1." };
    }
  }

  const offset = (page - 1) * limit;
  if (offset > MAX_OFFSET) {
    return {
      error: `Offset de paginação (${offset}) excede o limite máximo permitido de ${MAX_OFFSET}. Ajuste 'page' ou 'limit'.`,
    };
  }

  return { page, limit, offset };
}

export function sanitizeString(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Valida formato de data ISO 8601 (YYYY-MM-DD ou com hora).
 * Contrato de fuso: America/Sao_Paulo (UTC-3 fixo, sem horário de verão).
 * Para formato só-data YYYY-MM-DD, valida estritamente round-trip via Date.UTC
 * para evitar rolagem de mês/dia (ex: 2026-02-30, 2026-13-01, 2026-00-10).
 * Para timestamps com hora, EXIGE 'Z' ou offset de fuso explícito (ex: +00:00, -03:00).
 * Timestamps sem Z ou offset são rejeitados (retornam undefined).
 */
export function sanitizeDate(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return undefined;
    }

    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    ) {
      return undefined;
    }

    return trimmed;
  }

  // Timestamps com hora DEVEM usar 'T' como separador e ter Z ou offset explícito (+HH:MM ou -HH:MM)
  const isoDateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[-+]\d{2}:?\d{2})$/i.exec(trimmed);
  if (isoDateTimeMatch) {
    const year = Number(isoDateTimeMatch[1]);
    const month = Number(isoDateTimeMatch[2]);
    const day = Number(isoDateTimeMatch[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return undefined;
    }

    const dUtc = new Date(Date.UTC(year, month - 1, day));
    if (
      dUtc.getUTCFullYear() !== year ||
      dUtc.getUTCMonth() !== month - 1 ||
      dUtc.getUTCDate() !== day
    ) {
      return undefined;
    }

    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return undefined;
    return trimmed;
  }

  return undefined;
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
    const trimmed = val.trim();
    if (trimmed.length === 0) return undefined;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
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
): ListActionParams | { error: string } {
  const pagination = validatePagination(source.page, source.limit);
  if ("error" in pagination) {
    return { error: pagination.error };
  }
  const { page, limit } = pagination;

  const orderByRaw = sanitizeString(source.order_by);
  const order_by: SortField = orderByRaw && ALLOWED_SORT_FIELDS[orderByRaw]
    ? ALLOWED_SORT_FIELDS[orderByRaw]
    : DEFAULT_SORT_FIELD;

  const orderDirRaw = sanitizeString(source.order_direction)?.toLowerCase();
  const order_direction: SortOrder = orderDirRaw === "asc" ? "asc" : DEFAULT_SORT_ORDER;

  // Validação de datas: se enviou algo não vazio mas inválido (ex: sem Z ou formato quebrado), retorna 400
  const dateFields: Array<[keyof LicitacaoFiltros, string]> = [
    ["data_publicacao_inicio", "data_publicacao_inicio"],
    ["data_publicacao_fim", "data_publicacao_fim"],
    ["data_inicio_min", "data_inicio_min"],
    ["data_inicio_max", "data_inicio_max"],
    ["data_fim_min", "data_fim_min"],
    ["data_fim_max", "data_fim_max"],
    ["data_homologacao_min", "data_homologacao_min"],
    ["data_homologacao_max", "data_homologacao_max"],
  ];

  for (const [key, label] of dateFields) {
    const rawVal = source[key];
    if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
      const sanitized = sanitizeDate(rawVal);
      if (!sanitized) {
        return {
          error: `Data inválida no campo '${label}'. Formatos aceitos: 'YYYY-MM-DD' ou ISO 8601 com Z/offset (ex: 'YYYY-MM-DDTHH:MM:SSZ' ou '-03:00').`,
        };
      }
    }
  }

  const filtros: LicitacaoFiltros = {
    prioridade: sanitizeString(source.prioridade),
    uf: sanitizeString(source.uf)?.toUpperCase(),
    municipio: sanitizeSearchTerm(source.municipio),
    orgao_cnpj: sanitizeString(source.orgao_cnpj)?.replace(/\D/g, "") || undefined,
    orgao_nome: sanitizeSearchTerm(source.orgao_nome),
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
    busca: sanitizeSearchTerm(source.busca ?? source.q),
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
    if (!fonte) {
      return {
        ok: false,
        error: "Parâmetro 'fonte' é obrigatório ao consultar por 'codigo_externo'",
      };
    }
    return {
      ok: true,
      params: {
        action: "get",
        codigo_externo: codigoExterno,
        fonte,
      },
    };
  }

  if (orgaoCnpj && processoNorm) {
    const pagination = validatePagination(source.page, source.limit);
    if ("error" in pagination) {
      return { ok: false, error: pagination.error };
    }
    const { page, limit } = pagination;

    return {
      ok: true,
      params: {
        action: "get",
        orgao_cnpj: orgaoCnpj,
        processo_norm: processoNorm,
        page,
        limit,
      },
    };
  }

  return {
    ok: false,
    error: "Identificador ausente: informe 'id', ('codigo_externo' e 'fonte') ou o par ('orgao_cnpj' e 'processo_norm')",
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
    const result = parseListParams(raw);
    if ("error" in result) return { error: result.error };
    return result;
  }

  if (actionParam === "acompanhamento") {
    const idRaw = url.searchParams.get("id");
    if (!idRaw || !idRaw.trim()) {
      return { error: "Parâmetro 'id' é obrigatório para a ação 'acompanhamento'." };
    }
    return { action: "acompanhamento", id: idRaw.trim() };
  }

  return { error: `Ação inválida: '${actionParam}'. Use 'list', 'get', 'readiness' ou 'acompanhamento'.` };
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
    const result = parseListParams(body);
    if ("error" in result) return { error: result.error };
    return result;
  }

  if (action === "acompanhamento") {
    const idRaw = body.id;
    if (idRaw === undefined || idRaw === null || String(idRaw).trim() === "") {
      return { error: "Parâmetro 'id' é obrigatório para a ação 'acompanhamento'." };
    }
    return { action: "acompanhamento", id: String(idRaw).trim() };
  }

  return { error: `Ação inválida: '${action}'. Use 'list', 'get', 'readiness' ou 'acompanhamento'.` };
}
