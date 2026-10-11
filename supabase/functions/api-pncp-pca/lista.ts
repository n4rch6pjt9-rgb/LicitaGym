/**
 * GET api-pncp-pca (sem visao): lista os planos ativos do ano. Exige login como as outras rotas; sem token responde
 * 401 antes de tocar no banco (antes, a consulta ia como anon e voltava 400 com a mensagem do Postgres). Erro de banco
 * vai para o log; o chamador recebe mensagem genérica e 502.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { errorDetail, jsonResponse, parseQueryInt, requireUserAuth } from "../_shared/http.ts";
import { COLUNAS_LISTA_PLANOS } from "./planos.ts";

export const ERRO_LISTA = "Falha ao ler os planos do PCA.";

export interface ListaDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente: (req: Request) => SupabaseClient;
}

export async function responderLista(req: Request, url: URL, deps: ListaDeps): Promise<Response> {
  const denied = await (deps.requireAuth ?? requireUserAuth)(req);
  if (denied) return denied;
  const client = deps.criarCliente(req);
  const ano = parseQueryInt(url, "ano", new Date().getUTCFullYear());
  const page = parseQueryInt(url, "page", 1);
  const limit = Math.min(parseQueryInt(url, "limit", 20), 100);
  const offset = (page - 1) * limit;

  const { data, error, count } = await client
    .from("pca_planos")
    .select(COLUNAS_LISTA_PLANOS, { count: "exact" })
    .eq("ativo", true)
    .eq("ano_exercicio", ano)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[api-pncp-pca] lista", errorDetail(error));
    return jsonResponse({ error: ERRO_LISTA }, 502);
  }
  return jsonResponse({ data, page, limit, total: count ?? 0 });
}
