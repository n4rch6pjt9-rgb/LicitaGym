import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import type { ActionParams, GetActionParams, ListActionParams } from "./types.ts";
import { parseActionFromBody, parseActionFromUrl } from "./validation.ts";
import { applyLicitacaoFilters, calculateRange } from "./query.ts";

export interface DashboardOportunidadesClientContext {
  getClient?: (req: Request) => SupabaseClient;
}

/**
 * Cliente Supabase com chave anon para consultas públicas / leitura do dashboard.
 * Preserva o header Authorization caso o usuário esteja autenticado via token JWT.
 */
export function getDefaultClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_ANON_KEY não configuradas");
  }

  const authHeader = req.headers.get("Authorization");
  const headers: Record<string, string> = {};
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  return createClient(url, anon, {
    global: { headers },
    auth: { persistSession: false },
  });
}

/**
 * Ação: readiness
 * Verifica se a tabela licitacoes_externas está acessível e retorna contagem e data da última sincronização,
 * sem expor credenciais ou segredos.
 */
async function handleReadiness(
  req: Request,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient(req) : getDefaultClient(req);

    // Contagem rápida e última atualização
    const { count, error: countError } = await client
      .from("licitacoes_externas")
      .select("id", { count: "exact", head: true });

    if (countError) {
      return jsonResponse(
        {
          status: "unhealthy",
          ready: false,
          error: countError.message,
        },
        503,
      );
    }

    const { data: latest, error: latestError } = await client
      .from("licitacoes_externas")
      .select("updated_at, last_synced_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      return jsonResponse(
        {
          status: "unhealthy",
          ready: false,
          error: latestError.message,
        },
        503,
      );
    }

    return jsonResponse({
      status: "ready",
      ready: true,
      table: "licitacoes_externas",
      total_registros: count ?? 0,
      ultima_atualizacao: latest?.updated_at ?? null,
      ultimo_sync: latest?.last_synced_at ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ status: "error", ready: false, error: msg }, 500);
  }
}

/**
 * Ação: get
 * Busca um certame por ID ou pelo par (orgao_cnpj, processo_norm).
 * 404 claro quando não encontrado.
 */
async function handleGet(
  req: Request,
  params: GetActionParams,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient(req) : getDefaultClient(req);

    let query = client.from("licitacoes_externas").select("*");

    if (params.id !== undefined && params.id !== null) {
      query = query.eq("id", params.id);
    } else if (params.orgao_cnpj && params.processo_norm) {
      query = query
        .eq("orgao_cnpj", params.orgao_cnpj)
        .eq("processo_norm", params.processo_norm);
    } else {
      return jsonResponse(
        { error: "Identificador ausente: informe 'id' ou o par ('orgao_cnpj' e 'processo_norm')" },
        400,
      );
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      return jsonResponse({ error: error.message }, 400);
    }

    if (!data) {
      return jsonResponse(
        { error: "Licitação não encontrada", item: null },
        404,
      );
    }

    return jsonResponse({ item: data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, 500);
  }
}

/**
 * Ação: list
 * Lista oportunidades com paginação, ordenação e múltiplos filtros.
 * Distingue resultado vazio (200 com items: []) de erro (400/500).
 */
async function handleList(
  req: Request,
  params: ListActionParams,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient(req) : getDefaultClient(req);
    const { page, limit, order_by, order_direction, filtros } = params;
    const { from, to } = calculateRange(page, limit);

    let baseQuery = client
      .from("licitacoes_externas")
      .select("*", { count: "exact" });

    baseQuery = applyLicitacaoFilters(baseQuery, filtros);

    const isAscending = order_direction === "asc";
    baseQuery = baseQuery
      .order(order_by, { ascending: isAscending, nullsFirst: false })
      .range(from, to);

    const { data, error, count } = await baseQuery;

    if (error) {
      return jsonResponse({ error: error.message }, 400);
    }

    return jsonResponse({
      action: "list",
      page,
      limit,
      total: count ?? 0,
      order_by,
      order_direction,
      items: data ?? [],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, 500);
  }
}

export async function handleRequest(
  req: Request,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let actionParams: ActionParams | { error: string };

  if (req.method === "GET") {
    const url = new URL(req.url);
    actionParams = parseActionFromUrl(url);
  } else if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ error: "Corpo JSON inválido. Esperado objeto JSON." }, 400);
    }
    actionParams = parseActionFromBody(body as Record<string, unknown>);
  } else {
    return jsonResponse({ error: "Método não permitido. Utilize GET ou POST." }, 405);
  }

  if ("error" in actionParams) {
    return jsonResponse({ error: actionParams.error }, 400);
  }

  switch (actionParams.action) {
    case "readiness":
      return await handleReadiness(req, ctx);
    case "get":
      return await handleGet(req, actionParams, ctx);
    case "list":
      return await handleList(req, actionParams, ctx);
    default:
      return jsonResponse({ error: "Ação não suportada" }, 400);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}

