import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse, requireUserAuth } from "../_shared/http.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
import type { ActionParams, AcompanhamentoActionParams, GetActionParams, LicitacaoFiltros, ListActionParams } from "./types.ts";
import { parseActionFromBody, parseActionFromUrl } from "./validation.ts";
import { applyLicitacaoFilters, applyOportunidadesScope, calculateRange } from "./query.ts";
import { buildEditalUrl } from "../_shared/edital-url.ts";
import { handleAcompanhamento } from "./acompanhamento.ts";
import type { UnifiedHttpClient } from "../_shared/http-client/index.ts";

/**
 * Fonte de leitura de list/get: a view com a prioridade EFETIVA (migration
 * 20260930200000_licitacoes_prioridade_efetiva). Mesmas colunas públicas da tabela, mas `prioridade`
 * recalculada só para baixo (historico com qualquer sinal de encerramento; leads -> monitorar com o
 * prazo vencido). security_invoker + SELECT só para service_role (o client desta função).
 * readiness e acompanhamento continuam lendo a tabela (saúde da base e `raw` server-side).
 */
export const OPORTUNIDADES_VIEW = "licitacoes_externas_prioridade_efetiva";

/**
 * Prioridades que aparecem em Oportunidades (decisão de produto 30/09/2026): compra homologada ou
 * encerrada (`historico`) é só do BI. O list exclui `historico` por padrão (lista e contagem);
 * `prioridade=historico` responde 200 vazio (ver handleList). NULL (fonte que não grava prioridade e
 * sem sinal de encerramento) continua aparecendo.
 */
export const PRIORIDADE_FORA_DE_OPORTUNIDADES = "historico";

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
  httpClient?: UnifiedHttpClient;
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
 * Lê da view com a prioridade efetiva. Uma compra `historico` é devolvida normalmente (com
 * `prioridade: "historico"`): links do BI e links diretos continuam funcionando; ela só não aparece
 * no list de Oportunidades.
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
        .from(OPORTUNIDADES_VIEW)
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

      const itemRecord = data as unknown as Record<string, unknown>;
      const itemWithUrl = {
        ...itemRecord,
        url_edital: buildEditalUrl(itemRecord),
      };

      return jsonResponse({ item: itemWithUrl });
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
        .from(OPORTUNIDADES_VIEW)
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

      const itemRecord = data as unknown as Record<string, unknown>;
      const itemWithUrl = {
        ...itemRecord,
        url_edital: buildEditalUrl(itemRecord),
      };

      return jsonResponse({ item: itemWithUrl });
    }

    // Caso 3: Busca por par órgão + processo (1..N compras/certames do mesmo processo administrativo) paginada
    if (params.orgao_cnpj && params.processo_norm) {
      const page = params.page && params.page > 0 ? params.page : 1;
      const limit = params.limit && params.limit > 0 ? params.limit : 20;
      const { from, to } = calculateRange(page, limit);

      const { data, error, count } = await client
        .from(OPORTUNIDADES_VIEW)
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

      const rawItems = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const items = rawItems.map((row) => ({
        ...row,
        url_edital: buildEditalUrl(row),
      }));
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
/**
 * Teto de licitações resolvidas pelo recorte CATMAT antes do filtro por id (evita URL gigante no PostgREST).
 * licitacoes_ids_por_catmat não trunca (sem LIMIT), então r.ids é completo e o teto é verificado sobre o total real.
 */
export const MAX_IDS_CATMAT = 1000;

export interface CatmatMatch {
  codigo_pdm: number;
  nome_pdm: string | null;
  codigo_item: number | null;
  motivo: string;
}

export function temRecorteCatmat(f: LicitacaoFiltros): boolean {
  return !!(f.catmat_grupo || f.catmat_classe || f.catmat_pdm || f.catmat_item || f.catalogo === true);
}

/**
 * Resolve o recorte CATMAT em ids de licitacoes_externas via public.licitacoes_ids_por_catmat
 * (código numérico do item quando existe; senão padrões de texto do PDM no item e no objeto).
 */
async function resolverCatmat(
  client: SupabaseClient,
  filtros: LicitacaoFiltros,
): Promise<{ ids: number[]; porLicitacao: Map<number, CatmatMatch[]> }> {
  const { data, error } = await client.rpc("licitacoes_ids_por_catmat", {
    p_grupos: filtros.catmat_grupo ?? null,
    p_classes: filtros.catmat_classe ?? null,
    p_pdms: filtros.catmat_pdm ?? null,
    p_itens: filtros.catmat_item ?? null,
    p_somente_catalogo: filtros.catalogo === true,
  });
  if (error) throw error;
  const linhas = (data ?? []) as Array<{ licitacao_id: number; codigo_pdm: number; codigo_item: number | null; motivo: string }>;

  const pdms = [...new Set(linhas.map((l) => l.codigo_pdm))];
  const nomes = new Map<number, string>();
  if (pdms.length > 0) {
    const { data: rows, error: nomesError } = await client.from("catmat_pdms").select("codigo_pdm,nome_pdm").in("codigo_pdm", pdms);
    if (nomesError) throw nomesError;
    for (const r of (rows ?? []) as Array<{ codigo_pdm: number; nome_pdm: string }>) nomes.set(r.codigo_pdm, r.nome_pdm);
  }

  const porLicitacao = new Map<number, CatmatMatch[]>();
  for (const l of linhas) {
    const lista = porLicitacao.get(Number(l.licitacao_id)) ?? [];
    lista.push({ codigo_pdm: l.codigo_pdm, nome_pdm: nomes.get(l.codigo_pdm) ?? null, codigo_item: l.codigo_item ?? null, motivo: l.motivo });
    porLicitacao.set(Number(l.licitacao_id), lista);
  }
  return { ids: [...porLicitacao.keys()], porLicitacao };
}

async function handleList(
  params: ListActionParams,
  ctx?: DashboardOportunidadesClientContext,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : getDefaultServiceClient();
    const { page, limit, order_by, order_direction } = params;
    let filtros = params.filtros;
    const { from, to } = calculateRange(page, limit);

    // historico não é Oportunidade (é do BI): o filtro explícito responde vazio, sem consultar o banco.
    // 200 vazio (e não 400) porque o Dashboard ainda oferece "Histórico de Certames" no seletor.
    if (filtros.prioridade === PRIORIDADE_FORA_DE_OPORTUNIDADES) {
      return jsonResponse({ action: "list", page, limit, total: 0, order_by, order_direction, items: [] });
    }

    // Recorte CATMAT: resolve em ids antes da consulta principal
    let matches: Map<number, CatmatMatch[]> | null = null;
    if (temRecorteCatmat(filtros)) {
      const r = await resolverCatmat(client, filtros);
      if (r.ids.length === 0) {
        return jsonResponse({ action: "list", page, limit, total: 0, order_by, order_direction, items: [] });
      }
      if (r.ids.length > MAX_IDS_CATMAT) {
        return jsonResponse({
          error: `O recorte CATMAT casa ${r.ids.length} licitações (limite ${MAX_IDS_CATMAT}). Refine por classe, PDM ou outro filtro.`,
        }, 422);
      }
      filtros = { ...filtros, ids: r.ids };
      matches = r.porLicitacao;
    }

    let baseQuery = client
      .from(OPORTUNIDADES_VIEW)
      .select(PUBLIC_LICITACAO_COLUMNS, { count: "exact" });

    baseQuery = applyOportunidadesScope(applyLicitacaoFilters(baseQuery, filtros), filtros);

    const isAscending = order_direction === "asc";
    baseQuery = baseQuery
      .order(order_by, { ascending: isAscending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to);

    const { data, error, count } = await baseQuery;

    // Página além do fim: o PostgREST responde 416 (PGRST103). Para o cliente é uma página vazia,
    // não uma falha; o total vem de uma contagem com os mesmos filtros.
    if (error && (error as { code?: string }).code === "PGRST103") {
      let countQuery = client
        .from(OPORTUNIDADES_VIEW)
        .select("id", { count: "exact", head: true });
      countQuery = applyOportunidadesScope(applyLicitacaoFilters(countQuery, filtros), filtros);
      const { count: total, error: countError } = await countQuery;
      if (countError || total === null || total === undefined) {
        console.error("[api-dashboard-oportunidades] Contagem indisponível após página além do fim:", countError);
        return jsonResponse({ error: "Falha ao consultar lista de oportunidades" }, 500);
      }
      return jsonResponse({
        action: "list",
        page,
        limit,
        total,
        order_by,
        order_direction,
        items: [],
      });
    }

    if (error) {
      console.error("[api-dashboard-oportunidades] Erro ao listar oportunidades:", error);
      return jsonResponse({ error: "Falha ao consultar lista de oportunidades" }, 500);
    }

    if (count === null) {
      console.error("[api-dashboard-oportunidades] Contagem indisponível ao listar oportunidades");
      return jsonResponse({ error: "Falha ao consultar lista de oportunidades" }, 500);
    }

    const rawItems = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const items = rawItems.map((row) => ({
      ...row,
      url_edital: buildEditalUrl(row),
      ...(matches ? { catmat_match: matches.get(Number(row.id)) ?? [] } : {}),
    }));

    return jsonResponse({
      action: "list",
      page,
      limit,
      total: count,
      order_by,
      order_direction,
      items,
    });
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em list:", err);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
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

  // Autenticação obrigatória para leitura de dados (list, get e acompanhamento)
  const authChecker = ctx?.requireAuth ?? requireUserAuth;
  const authError = await authChecker(req);
  if (authError) {
    return authError;
  }

  switch (actionParams.action) {
    case "get":
      return await handleGet(actionParams, ctx);
    case "list":
      return await handleList(actionParams, ctx);
    case "acompanhamento":
      return await handleAcompanhamento(actionParams, ctx, getDefaultServiceClient);
    default:
      return jsonResponse({ error: "Ação não suportada" }, 400);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
