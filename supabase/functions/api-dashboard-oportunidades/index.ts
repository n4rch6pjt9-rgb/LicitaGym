import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractBearerToken, jsonResponse, requireUserAuth } from "../_shared/http.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
import type { ActionParams, GetActionParams, ListActionParams } from "./types.ts";
import { parseActionFromBody, parseActionFromUrl } from "./validation.ts";
import { applyLicitacaoFilters, calculateRange } from "./query.ts";

/**
 * Colunas públicas explícitas da tabela licitacoes_externas expostas para o dashboard.
 * Projeção seletiva: inclui identificadores de fonte não-secretos (modulo, id_externo)
 * necessários para fontes como SEST SENAT onde codigo_externo é nulo.
 * Exclui estritamente colunas técnicas e internas (raw, esclarecimentos, notas,
 * anexo_raiz_id, edital_id).
 */
export const PUBLIC_LICITACAO_COLUMNS = [
  "id",
  "fonte",
  "modulo",
  "id_externo",
  "codigo_externo",
  "numero_processo",
  "processo_norm",
  "numero_edital",
  "objeto",
  "unidade_compradora",
  "modalidade",
  "fase",
  "situacao",
  "data_inicio",
  "data_fim",
  "valor_total",
  "orgao_cnpj",
  "orgao_nome",
  "municipio",
  "uf",
  "data_publicacao",
  "data_homologacao",
  "categoria_escopo",
  "interesse_borracha",
  "prioridade",
  "termos_busca",
  "created_at",
  "updated_at",
  "last_synced_at",
].join(",");

export interface DashboardOportunidadesClientContext {
  getClient?: () => SupabaseClient;
  requireAuth?: (req: Request) => Promise<Response | null> | Response | null;
}

/**
 * Cria o cliente Supabase server-side com service_role_key.
 * A chave NUNCA é exposta ao cliente/navegador.
 * O Authorization do usuário final não é repassado para o client com service_role.
 */
export function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Ação: readiness
 * Verifica se a tabela licitacoes_externas está acessível e retorna contagem e data da última sincronização,
 * sem expor credenciais ou segredos.
 */
async function handleReadiness(
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : getDefaultServiceClient();

    // Contagem rápida e última atualização
    const { count, error: countError } = await client
      .from("licitacoes_externas")
      .select("id", { count: "exact", head: true });

    if (countError || count === null) {
      console.error("[api-dashboard-oportunidades] Erro de readiness ao consultar count:", countError ?? "count null");
      return jsonResponse(
        {
          status: "unhealthy",
          ready: false,
          error: "Falha ao verificar disponibilidade da base de dados",
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
      console.error("[api-dashboard-oportunidades] Erro de readiness ao consultar latest:", latestError);
      return jsonResponse(
        {
          status: "unhealthy",
          ready: false,
          error: "Falha ao verificar disponibilidade da base de dados",
        },
        503,
      );
    }

    return jsonResponse({
      status: "ready",
      ready: true,
      table: "licitacoes_externas",
      total_registros: count,
      ultima_atualizacao: latest?.updated_at ?? null,
      ultimo_sync: latest?.last_synced_at ?? null,
    });
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em readiness:", err);
    return jsonResponse(
      { status: "error", ready: false, error: "Erro interno no servidor" },
      500,
    );
  }
}

/**
 * Ação: get
 * - Se buscado por `id` ou `codigo_externo`: lookup único (retorna `{ item: ... }`, ou 404 claro).
 * - Se buscado por `orgao_cnpj` + `processo_norm`: pode haver 1..N compras (AGENTS.md L66-77),
 *   portanto retorna coleção (`{ items: [...] }`), sem maybeSingle().
 */
async function handleGet(
  params: GetActionParams,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : getDefaultServiceClient();

    // Caso 1: Busca única por ID
    if (params.id !== undefined && params.id !== null) {
      const { data, error } = await client
        .from("licitacoes_externas")
        .select(PUBLIC_LICITACAO_COLUMNS)
        .eq("id", params.id)
        .maybeSingle();

      if (error) {
        console.error("[api-dashboard-oportunidades] Erro ao buscar por ID:", error);
        return jsonResponse({ error: "Falha ao consultar licitação" }, 500);
      }

      if (!data) {
        return jsonResponse(
          { error: "Licitação não encontrada", item: null },
          404,
        );
      }

      return jsonResponse({ item: data });
    }

    // Caso 2: Busca única por codigo_externo + fonte
    if (params.codigo_externo) {
      if (!params.fonte) {
        return jsonResponse(
          { error: "Parâmetro 'fonte' é obrigatório ao consultar por 'codigo_externo'" },
          400,
        );
      }

      const query = client
        .from("licitacoes_externas")
        .select(PUBLIC_LICITACAO_COLUMNS)
        .eq("codigo_externo", params.codigo_externo)
        .eq("fonte", params.fonte);

      const { data, error } = await query.maybeSingle();

      if (error) {
        console.error("[api-dashboard-oportunidades] Erro ao buscar por codigo_externo:", error);
        return jsonResponse({ error: "Falha ao consultar licitação" }, 500);
      }

      if (!data) {
        return jsonResponse(
          { error: "Licitação não encontrada", item: null },
          404,
        );
      }

      return jsonResponse({ item: data });
    }

    // Caso 3: Busca por par órgão + processo (1..N compras/certames do mesmo processo administrativo) paginada
    if (params.orgao_cnpj && params.processo_norm) {
      const page = params.page && params.page > 0 ? params.page : 1;
      const limit = params.limit && params.limit > 0 ? params.limit : 20;
      const { from, to } = calculateRange(page, limit);

      const { data, error, count } = await client
        .from("licitacoes_externas")
        .select(PUBLIC_LICITACAO_COLUMNS, { count: "exact" })
        .eq("orgao_cnpj", params.orgao_cnpj)
        .eq("processo_norm", params.processo_norm)
        .order("data_publicacao", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to);

      if (error) {
        console.error("[api-dashboard-oportunidades] Erro ao buscar por processo:", error);
        return jsonResponse({ error: "Falha ao consultar compras do processo" }, 500);
      }

      if (count === null) {
        console.error("[api-dashboard-oportunidades] Contagem indisponível ao consultar compras do processo");
        return jsonResponse({ error: "Falha ao consultar compras do processo" }, 500);
      }

      const items = data ?? [];
      const total = count;
      if (total === 0 && items.length === 0) {
        return jsonResponse(
          { error: "Nenhuma licitação encontrada para este processo", items: [] },
          404,
        );
      }

      return jsonResponse({
        orgao_cnpj: params.orgao_cnpj,
        processo_norm: params.processo_norm,
        page,
        limit,
        total,
        items,
      });
    }

    return jsonResponse(
      { error: "Identificador ausente: informe 'id', ('codigo_externo' e 'fonte') ou o par ('orgao_cnpj' e 'processo_norm')" },
      400,
    );
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em get:", err);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

/**
 * Ação: list
 * Lista oportunidades com paginação, ordenação e múltiplos filtros.
 * Distingue resultado vazio (200 com items: []) de erro (400/500).
 */
async function handleList(
  params: ListActionParams,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : getDefaultServiceClient();
    const { page, limit, order_by, order_direction, filtros } = params;
    const { from, to } = calculateRange(page, limit);

    let baseQuery = client
      .from("licitacoes_externas")
      .select(PUBLIC_LICITACAO_COLUMNS, { count: "exact" });

    baseQuery = applyLicitacaoFilters(baseQuery, filtros);

    const isAscending = order_direction === "asc";
    baseQuery = baseQuery
      .order(order_by, { ascending: isAscending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to);

    const { data, error, count } = await baseQuery;

    if (error) {
      console.error("[api-dashboard-oportunidades] Erro ao listar oportunidades:", error);
      return jsonResponse({ error: "Falha ao consultar lista de oportunidades" }, 500);
    }

    if (count === null) {
      console.error("[api-dashboard-oportunidades] Contagem indisponível ao listar oportunidades");
      return jsonResponse({ error: "Falha ao consultar lista de oportunidades" }, 500);
    }

    return jsonResponse({
      action: "list",
      page,
      limit,
      total: count,
      order_by,
      order_direction,
      items: data ?? [],
    });
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em list:", err);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

export async function authenticateUserWithFallback(req: Request): Promise<Response | null> {
  const token = extractBearerToken(req);
  if (!token) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const cronSecret = Deno.env.get("SYNC_CRON_SECRET")?.trim();
  if (cronSecret && token === cronSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const anon = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))?.trim();
  if (!url || !anon) {
    return requireUserAuth(req);
  }

  try {
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return null;
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
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
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Corpo JSON inválido. Verifique a sintaxe da requisição." }, 400);
    }

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

  // readiness pode ser público (sem dados de linhas, apenas status e contagem de saúde)
  if (actionParams.action === "readiness") {
    return await handleReadiness(ctx);
  }

  // Autenticação obrigatória para leitura de dados (list e get)
  const authChecker = ctx?.requireAuth ?? authenticateUserWithFallback;
  const authError = await authChecker(req);
  if (authError) {
    return authError;
  }

  switch (actionParams.action) {
    case "get":
      return await handleGet(actionParams, ctx);
    case "list":
      return await handleList(actionParams, ctx);
    default:
      return jsonResponse({ error: "Ação não suportada" }, 400);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
