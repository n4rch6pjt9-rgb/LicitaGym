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
 * prazo vencido), mais `canonica_id`/`eh_canonica` (20261003170000_licitacoes_pncp_canonica: o list
 * mostra só a publicação canônica de uma compra PNCP republicada; o get devolve qualquer linha).
 * security_invoker + SELECT só para service_role (o client desta função).
 * readiness e acompanhamento continuam lendo a tabela (saúde da base e `raw` server-side).
 */
export const OPORTUNIDADES_VIEW = "licitacoes_externas_prioridade_efetiva";

/**
 * Prioridades que aparecem em Oportunidades (decisão de produto 30/09/2026): compra homologada ou
 * encerrada (`historico`) é só do BI. O list exclui `historico` por padrão (lista e contagem);
 * `prioridade=historico` responde 200 vazio (ver handleList). NULL (compra fora do escopo, gravada
 * pelo reclassificador) também fica fora desde 02/10/2026 (ver query.ts PRIORIDADES_DE_OPORTUNIDADES).
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
  "objeto_categoria",
  "objeto_registro_preco",
].join(",");

/**
 * Colunas da view da prioridade efetiva que não existem na tabela (migration
 * 20261003170000_licitacoes_pncp_canonica): compra PNCP republicada (mesmo órgão, processo e edital)
 * aparece uma vez em Oportunidades. `canonica_id` é o id da publicação canônica do grupo (o próprio id
 * quando a compra não tem republicação) e `eh_canonica` diz se a linha é ela.
 */
export const CANONICA_COLUMNS = "canonica_id,eh_canonica";

/** Projeção de list/get (sempre na view): colunas públicas da tabela + as da canônica. */
export const OPORTUNIDADES_COLUMNS = `${PUBLIC_LICITACAO_COLUMNS},${CANONICA_COLUMNS}`;

/** Colunas do objeto canônico (migration 20261004140000_objeto_canonico). */
const COLUNAS_OBJETO = ["objeto_categoria", "objeto_registro_preco"];
/** Mesmas colunas sem as do objeto canônico: usadas se a função for publicada antes de a migration existir no banco. */
export const OPORTUNIDADES_COLUMNS_SEM_OBJETO = OPORTUNIDADES_COLUMNS.split(",")
  .filter((c) => !COLUNAS_OBJETO.includes(c))
  .join(",");

/** O banco respondeu "coluna não existe" (42703) para uma coluna do objeto canônico? */
function colunaDoObjetoAusente(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === "42703" && COLUNAS_OBJETO.some((c) => (e.message ?? "").includes(c));
}

/**
 * Executa a leitura com as colunas do objeto canônico e, se a view ainda não as tiver (função publicada antes da
 * migration, ou migration atrasada), repete sem elas: list e get continuam respondendo, só sem a categoria.
 */
async function comColunasDoObjeto<R extends { error: unknown }>(ler: (colunas: string) => PromiseLike<R>): Promise<R> {
  const r = await ler(OPORTUNIDADES_COLUMNS);
  if (!colunaDoObjetoAusente(r.error)) return r;
  console.warn("[api-dashboard-oportunidades] colunas do objeto canônico ausentes na view; respondendo sem elas");
  return await ler(OPORTUNIDADES_COLUMNS_SEM_OBJETO);
}

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

/** Catálogo canônico do objeto (opções do filtro), na ordem de precedência, mais "outros". */
async function handleObjetoCategorias(ctx?: DashboardOportunidadesClientContext): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : getDefaultServiceClient();
    const { data, error } = await client
      .from("objeto_categorias")
      .select("slug,nome,ordem")
      .eq("ativo", true)
      .order("ordem");
    if (error) {
      console.error("[api-dashboard-oportunidades] objeto_categorias:", error);
      return jsonResponse({ error: "Falha ao consultar o catálogo de objetos" }, 500);
    }
    return jsonResponse({
      action: "objeto_categorias",
      categorias: [...(data ?? []), { slug: "outros", nome: "OUTROS", ordem: 9999 }],
    });
  } catch (e) {
    console.error("[api-dashboard-oportunidades] objeto_categorias:", e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
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
 * Aderência ao catálogo CATMAT de licitações já carregadas (detalhe): lê public.licitacao_match (texto do item ou do
 * objeto casando com padrões de PDM) e devolve, por licitação, a mesma forma do catmat_match da lista. É um extra:
 * se a consulta falhar, o detalhe sai sem aderência (com log) em vez de falhar.
 * Diferença conhecida do catmat_match da lista (licitacoes_ids_por_catmat_unica): aqui não entram o casamento pelo
 * código do item (em 04/10/2026, 2 itens em toda a base) nem os objetos ainda pendentes de recálculo.
 * Só no detalhe, cada entrada traz `itens`: os numero_item (licitacao_itens) que casaram para aquele (PDM, motivo),
 * sem repetição, em ordem crescente, no máximo MAX_ITENS_ADERENCIA ([] para texto_objeto ou se a leitura falhar).
 */
async function aderenciaPorLicitacao(
  client: SupabaseClient,
  ids: number[],
): Promise<Map<number, CatmatMatchDetalhe[]>> {
  const porLicitacao = new Map<number, CatmatMatchDetalhe[]>();
  if (ids.length === 0) return porLicitacao;
  try {
    const { data, error } = await client
      .from("licitacao_match")
      .select("licitacao_id,codigo_pdm,origem,item_id")
      .in("licitacao_id", ids)
      .order("licitacao_id")
      .order("codigo_pdm")
      .limit(2000);
    if (error || !Array.isArray(data)) {
      console.warn("[api-dashboard-oportunidades] aderência do detalhe indisponível (licitacao_match):", error ?? "resposta inválida");
      return porLicitacao;
    }
    const linhas = data as Array<{ licitacao_id: number; codigo_pdm: number; origem: string; item_id?: number | string | null }>;
    const pdms = [...new Set(linhas.map((l) => Number(l.codigo_pdm)))];
    const nomes = new Map<number, string>();
    if (pdms.length > 0) {
      const { data: rows, error: nomesError } = await client.from("catmat_pdms").select("codigo_pdm,nome_pdm").in("codigo_pdm", pdms);
      if (nomesError) console.warn("[api-dashboard-oportunidades] nomes dos PDMs indisponíveis:", nomesError);
      for (const r of (Array.isArray(rows) ? rows : []) as Array<{ codigo_pdm: number; nome_pdm: string }>) {
        nomes.set(Number(r.codigo_pdm), r.nome_pdm);
      }
    }
    const numeros = await numerosDosItens(
      client,
      linhas.map((l) => l.item_id).filter((v): v is number | string => v !== null && v !== undefined).map(Number),
    );
    const porChave = new Map<string, { entrada: CatmatMatchDetalhe; itens: Set<number> }>();
    for (const l of linhas) {
      const chave = `${l.licitacao_id}:${l.codigo_pdm}:${l.origem}`;
      let grupo = porChave.get(chave);
      if (!grupo) {
        grupo = {
          entrada: { codigo_pdm: Number(l.codigo_pdm), nome_pdm: nomes.get(Number(l.codigo_pdm)) ?? null, codigo_item: null, motivo: l.origem, itens: [] },
          itens: new Set<number>(),
        };
        porChave.set(chave, grupo);
        const lista = porLicitacao.get(Number(l.licitacao_id)) ?? [];
        lista.push(grupo.entrada);
        porLicitacao.set(Number(l.licitacao_id), lista);
      }
      const numero = l.item_id === null || l.item_id === undefined ? undefined : numeros.get(Number(l.item_id));
      if (numero !== undefined) grupo.itens.add(numero);
    }
    for (const { entrada, itens } of porChave.values()) {
      entrada.itens = [...itens].sort((a, b) => a - b).slice(0, MAX_ITENS_ADERENCIA);
    }
  } catch (e) {
    console.warn("[api-dashboard-oportunidades] aderência do detalhe indisponível:", e instanceof Error ? e.message : String(e));
  }
  return porLicitacao;
}

/**
 * numero_item (public.licitacao_itens) por id de item, lido só pelos ids pedidos, em lotes (URL curta no PostgREST).
 * É um extra da aderência: se qualquer lote falhar, devolve o mapa vazio (com log) e todas as entradas saem com
 * `itens: []`, em vez de listas parciais que pareceriam completas.
 */
async function numerosDosItens(client: SupabaseClient, itemIds: number[]): Promise<Map<number, number>> {
  const numeros = new Map<number, number>();
  const unicos = [...new Set(itemIds.filter((id) => Number.isFinite(id)))];
  try {
    for (let i = 0; i < unicos.length; i += ITENS_ADERENCIA_LOTE) {
      const lote = unicos.slice(i, i + ITENS_ADERENCIA_LOTE);
      const { data, error } = await client.from("licitacao_itens").select("id,numero_item").in("id", lote);
      if (error || !Array.isArray(data)) {
        console.warn("[api-dashboard-oportunidades] números dos itens da aderência indisponíveis (licitacao_itens):", error ?? "resposta inválida");
        return new Map();
      }
      for (const r of data as Array<{ id: number | string; numero_item: number | string | null }>) {
        const numero = r.numero_item === null || r.numero_item === undefined ? NaN : Number(r.numero_item);
        if (Number.isFinite(numero)) numeros.set(Number(r.id), numero);
      }
    }
  } catch (e) {
    console.warn("[api-dashboard-oportunidades] números dos itens da aderência indisponíveis:", e instanceof Error ? e.message : String(e));
    return new Map();
  }
  return numeros;
}

/** Acrescenta catmat_match ao item só quando há casamento (a resposta não muda para quem não tem). */
function comAderencia(item: Record<string, unknown>, ader: Map<number, CatmatMatchDetalhe[]>): Record<string, unknown> {
  const m = ader.get(Number(item.id));
  return m && m.length > 0 ? { ...item, catmat_match: m } : item;
}

/**
 * Ação: get
 * Lê da view com a prioridade efetiva. Uma compra `historico` é devolvida normalmente (com
 * `prioridade: "historico"`): links do BI e links diretos continuam funcionando; ela só não aparece
 * no list de Oportunidades. O mesmo vale para uma republicação PNCP não canônica (`eh_canonica: false`,
 * `canonica_id` = id da publicação que aparece no list): o get não filtra a canônica.
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
      const { data, error } = await comColunasDoObjeto((colunas) =>
        client
          .from(OPORTUNIDADES_VIEW)
          .select(colunas)
          .eq("id", params.id)
          .maybeSingle()
      );

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
      const itemWithUrl = comAderencia({
        ...itemRecord,
        url_edital: buildEditalUrl(itemRecord),
      }, await aderenciaPorLicitacao(client, [Number(itemRecord.id)]));

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

      const { data, error } = await comColunasDoObjeto((colunas) =>
        client
          .from(OPORTUNIDADES_VIEW)
          .select(colunas)
          .eq("codigo_externo", params.codigo_externo as string)
          .eq("fonte", params.fonte as string)
          .maybeSingle()
      );

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
      const itemWithUrl = comAderencia({
        ...itemRecord,
        url_edital: buildEditalUrl(itemRecord),
      }, await aderenciaPorLicitacao(client, [Number(itemRecord.id)]));

      return jsonResponse({ item: itemWithUrl });
    }

    // Caso 3: Busca por par órgão + processo (1..N compras/certames do mesmo processo administrativo) paginada
    if (params.orgao_cnpj && params.processo_norm) {
      const page = params.page && params.page > 0 ? params.page : 1;
      const limit = params.limit && params.limit > 0 ? params.limit : 20;
      const { from, to } = calculateRange(page, limit);

      const { data, error, count } = await comColunasDoObjeto((colunas) =>
        client
          .from(OPORTUNIDADES_VIEW)
          .select(colunas, { count: "exact" })
          .eq("orgao_cnpj", params.orgao_cnpj as string)
          .eq("processo_norm", params.processo_norm as string)
          .order("data_publicacao", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, to)
      );

      if (error) {
        console.error("[api-dashboard-oportunidades] Erro ao buscar por processo:", error);
        return jsonResponse({ error: "Falha ao consultar compras do processo" }, 500);
      }

      if (count === null) {
        console.error("[api-dashboard-oportunidades] Contagem indisponível ao consultar compras do processo");
        return jsonResponse({ error: "Falha ao consultar compras do processo" }, 500);
      }

      const rawItems = (data ?? []) as unknown as Array<Record<string, unknown>>;
      const ader = await aderenciaPorLicitacao(client, rawItems.map((r) => Number(r.id)));
      const items = rawItems.map((row) => comAderencia({
        ...row,
        url_edital: buildEditalUrl(row),
      }, ader));
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
 * licitacoes_ids_por_catmat_unica não trunca (sem LIMIT nem paginação), então r.ids é completo. Acima do teto, os ids são
 * primeiro reduzidos ao escopo de Oportunidades (idsNoEscopo) e o teto vale sobre o que sobra.
 */
export const MAX_IDS_CATMAT = 1000;

/** Tamanho do lote de ids por consulta ao reduzir o recorte CATMAT ao escopo (URL curta no PostgREST). */
export const CATMAT_ESCOPO_LOTE = 500;

export interface CatmatMatch {
  codigo_pdm: number;
  nome_pdm: string | null;
  codigo_item: number | null;
  motivo: string;
}

/** Entrada de catmat_match no get: a mesma da lista mais os numero_item que casaram (só no detalhe). */
export interface CatmatMatchDetalhe extends CatmatMatch {
  itens: number[];
}

/** Máximo de numero_item por entrada de catmat_match no get (em 04/10/2026, o maior grupo tinha 44). */
export const MAX_ITENS_ADERENCIA = 50;

/** Tamanho do lote de ids por leitura de licitacao_itens na aderência do get. */
export const ITENS_ADERENCIA_LOTE = 500;

/** SQLSTATE do Postgres para statement_timeout (query_canceled). */
export const PG_STATEMENT_TIMEOUT = "57014";

/** Erro de banco por statement_timeout (ex.: licitacoes_ids_por_catmat_unica acima do limite do PostgREST). */
export function ehStatementTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === PG_STATEMENT_TIMEOUT;
}

export function temRecorteCatmat(f: LicitacaoFiltros): boolean {
  return !!(f.catmat_grupo || f.catmat_classe || f.catmat_pdm || f.catmat_item || f.catalogo === true);
}

/** RPC que resolve o recorte CATMAT numa chamada só (ids distintos + matches), sem paginação PostgREST. */
export const CATMAT_RPC = "licitacoes_ids_por_catmat_unica";

/** Linha devolvida por public.licitacoes_ids_por_catmat_unica (sempre uma). */
interface CatmatRpcUnica {
  ids: Array<number | string> | null;
  matches: Array<{ licitacao_id: number | string; codigo_pdm: number; codigo_item: number | string | null; motivo: string }> | null;
}

/**
 * Resolve o recorte CATMAT em ids de licitacoes_externas via public.licitacoes_ids_por_catmat_unica
 * (código numérico do item quando existe; senão padrões de texto do PDM no item e no objeto, lidos de
 * public.licitacao_match). Uma chamada só: a função devolve uma linha com os ids distintos (bigint[]) e os
 * matches (jsonb), então o max_rows do PostgREST não pagina e o statement_timeout (8 s por chamada do
 * role authenticator) vale uma vez.
 */
async function resolverCatmat(
  client: SupabaseClient,
  filtros: LicitacaoFiltros,
): Promise<{ ids: number[]; porLicitacao: Map<number, CatmatMatch[]> }> {
  const { data, error } = await client
    .rpc(CATMAT_RPC, {
      p_grupos: filtros.catmat_grupo ?? null,
      p_classes: filtros.catmat_classe ?? null,
      p_pdms: filtros.catmat_pdm ?? null,
      p_itens: filtros.catmat_item ?? null,
      p_somente_catalogo: filtros.catalogo === true,
    })
    .single();
  if (error) throw error;
  const resultado = (data ?? { ids: [], matches: [] }) as CatmatRpcUnica;
  const linhas = (resultado.matches ?? []).map((m) => ({
    licitacao_id: Number(m.licitacao_id),
    codigo_pdm: Number(m.codigo_pdm),
    codigo_item: m.codigo_item === null || m.codigo_item === undefined ? null : Number(m.codigo_item),
    motivo: m.motivo,
  }));

  const pdms = [...new Set(linhas.map((l) => l.codigo_pdm))];
  const nomes = new Map<number, string>();
  if (pdms.length > 0) {
    const { data: rows, error: nomesError } = await client.from("catmat_pdms").select("codigo_pdm,nome_pdm").in("codigo_pdm", pdms);
    if (nomesError) throw nomesError;
    for (const r of (rows ?? []) as Array<{ codigo_pdm: number; nome_pdm: string }>) nomes.set(r.codigo_pdm, r.nome_pdm);
  }

  const porLicitacao = new Map<number, CatmatMatch[]>();
  for (const l of linhas) {
    const lista = porLicitacao.get(l.licitacao_id) ?? [];
    lista.push({ codigo_pdm: l.codigo_pdm, nome_pdm: nomes.get(l.codigo_pdm) ?? null, codigo_item: l.codigo_item, motivo: l.motivo });
    porLicitacao.set(l.licitacao_id, lista);
  }
  return { ids: (resultado.ids ?? []).map(Number), porLicitacao };
}

/**
 * Reduz os ids do recorte CATMAT ao escopo pedido, na view da prioridade efetiva: sem filtro de
 * prioridade, só leads e monitorar; com filtro, só aquela prioridade; nos dois casos só a publicação
 * canônica (applyOportunidadesScope, o mesmo recorte da consulta principal). Assim um
 * recorte com muitas compras arquivadas (historico) e poucas Oportunidades não bate no teto à toa.
 * Consulta em lotes de CATMAT_ESCOPO_LOTE ids; falha de consulta levanta (vira 500).
 */
export async function idsNoEscopo(
  client: SupabaseClient,
  ids: number[],
  filtros: LicitacaoFiltros,
): Promise<number[]> {
  const mantidos: number[] = [];
  for (let i = 0; i < ids.length; i += CATMAT_ESCOPO_LOTE) {
    const lote = ids.slice(i, i + CATMAT_ESCOPO_LOTE);
    let query = client.from(OPORTUNIDADES_VIEW).select("id").in("id", lote);
    if (filtros.prioridade) query = query.eq("prioridade", filtros.prioridade);
    query = applyOportunidadesScope(query, filtros);
    const { data, error } = await query;
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number }>) mantidos.push(Number(row.id));
  }
  return mantidos;
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
      let r: Awaited<ReturnType<typeof resolverCatmat>>;
      try {
        r = await resolverCatmat(client, filtros);
      } catch (err: unknown) {
        // statement_timeout na resolução do recorte: indisponibilidade temporária (503), não erro interno (500)
        if (ehStatementTimeout(err)) {
          console.error("[api-dashboard-oportunidades] Timeout ao resolver o recorte CATMAT:", err);
          return jsonResponse({ error: "filtro de catálogo indisponível" }, 503);
        }
        throw err;
      }
      if (r.ids.length === 0) {
        return jsonResponse({ action: "list", page, limit, total: 0, order_by, order_direction, items: [] });
      }
      let ids = r.ids;
      if (ids.length > MAX_IDS_CATMAT) {
        // O teto vale sobre as Oportunidades do recorte, não sobre as compras arquivadas (historico):
        // reduz ao escopo pedido antes de decidir o 422. Abaixo do teto, a consulta principal já recorta.
        ids = await idsNoEscopo(client, ids, filtros);
        if (ids.length === 0) {
          return jsonResponse({ action: "list", page, limit, total: 0, order_by, order_direction, items: [] });
        }
        if (ids.length > MAX_IDS_CATMAT) {
          return jsonResponse({
            error: `O recorte CATMAT casa ${ids.length} oportunidades (limite ${MAX_IDS_CATMAT}). Refine por classe, PDM ou outro filtro.`,
          }, 422);
        }
      }
      filtros = { ...filtros, ids };
      matches = r.porLicitacao;
    }

    const isAscending = order_direction === "asc";
    const { data, error, count } = await comColunasDoObjeto((colunas) => {
      let baseQuery = client
        .from(OPORTUNIDADES_VIEW)
        .select(colunas, { count: "exact" });
      baseQuery = applyOportunidadesScope(applyLicitacaoFilters(baseQuery, filtros), filtros);
      return baseQuery
        .order(order_by, { ascending: isAscending, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to);
    });

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
    case "objeto_categorias":
      return await handleObjetoCategorias(ctx);
    default:
      return jsonResponse({ error: "Ação não suportada" }, 400);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
