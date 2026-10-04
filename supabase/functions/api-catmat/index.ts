import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { anotar, ErroCatalogo, listarCatalogo, removerRegra, salvarPalavra, salvarRegra } from "./catalog.ts";
import { type CatmatRepo, createSupabaseRepo } from "./repo.ts";
import { ComprasGovIndisponivel, obterArvore } from "./tree.ts";
import { ACOES_ADMIN } from "./types.ts";
import { parseActionFromBody } from "./validation.ts";

/**
 * api-catmat: árvore CATMAT (Compras.gov ao vivo, com cache) e catálogo CATMAT da empresa.
 *   Leitura (arvore, catalogo_listar, palavras_listar): qualquer usuário autenticado.
 *   Escrita (catalogo_*, palavras_salvar/remover): só app_metadata.licitagym_role = 'admin'.
 * O banco é acessado com service_role; o JWT do usuário serve só para identificar e autorizar.
 */

export interface ApiCatmatContext {
  getRepo?: () => CatmatRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  fetchFn?: typeof fetch;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handleRequest(req: Request, ctx: ApiCatmatContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const user = await (ctx.getUser ?? authenticateUser)(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse({ error: "Corpo JSON inválido. Esperado objeto JSON." }, 400);
  }

  const params = parseActionFromBody(body as Record<string, unknown>);
  if ("error" in params) return jsonResponse({ error: params.error }, 400);

  if (ACOES_ADMIN.has(params.action) && !isLicitagymAdmin(user)) {
    return jsonResponse({ error: "Sem permissão: só administradores alteram o catálogo CATMAT." }, 403);
  }
  if (params.action === "arvore" && params.refresh && !isLicitagymAdmin(user)) {
    return jsonResponse({ error: "Sem permissão: só administradores forçam a atualização da árvore." }, 403);
  }

  try {
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(getDefaultServiceClient())))();
    const deps = { repo, fetchFn: ctx.fetchFn, agora: ctx.agora, dormir: ctx.dormir };

    switch (params.action) {
      case "arvore": {
        const arvore = await obterArvore(deps, params.nivel, params.codigo, { refresh: params.refresh });
        const nos = params.incluir_inativos ? arvore.nos : arvore.nos.filter((n) => n.ativo);
        const regras = await repo.listarRegras();
        return jsonResponse({
          action: "arvore",
          nivel: params.nivel,
          codigo: params.codigo,
          fonte: arvore.fonte,
          stale: arvore.stale,
          total: nos.length,
          inativos_ocultos: arvore.nos.length - nos.length,
          nos: anotar(nos, regras),
        });
      }

      case "catalogo_listar":
        return jsonResponse({ action: "catalogo_listar", ...(await listarCatalogo(repo)) });

      case "catalogo_salvar": {
        const r = await salvarRegra(deps, user.id, params, {
          aPartirDoPdm: params.a_partir_do_pdm ?? undefined,
        });
        console.info("[api-catmat] catalogo_salvar", { user: user.id, chave: r.regra.chave, incluido: r.regra.incluido });
        return jsonResponse({ action: "catalogo_salvar", ...r }, r.criada ? 201 : 200);
      }

      case "catalogo_remover": {
        const regra = await removerRegra(repo, params.id);
        console.info("[api-catmat] catalogo_remover", { user: user.id, chave: regra.chave });
        return jsonResponse({ action: "catalogo_remover", removida: regra });
      }

      case "palavras_listar":
        return jsonResponse({
          action: "palavras_listar",
          codigo_pdm: params.codigo_pdm,
          palavras: await repo.listarPalavras(params.codigo_pdm),
          nos_taxonomia: await repo.nosTaxonomiaDoPdm(params.codigo_pdm),
        });

      case "palavras_salvar": {
        const palavra = await salvarPalavra(repo, user.id, params);
        console.info("[api-catmat] palavras_salvar", { user: user.id, codigo_pdm: palavra.codigo_pdm, id: palavra.id, tipo: palavra.tipo });
        return jsonResponse({ action: "palavras_salvar", palavra }, params.id === null ? 201 : 200);
      }

      case "palavras_remover": {
        const ok = await repo.removerPalavra(params.id, params.tipo);
        if (!ok) return jsonResponse({ error: "Padrão não encontrado." }, 404);
        console.info("[api-catmat] palavras_remover", { user: user.id, id: params.id, tipo: params.tipo });
        return jsonResponse({ action: "palavras_remover", id: params.id, tipo: params.tipo });
      }
    }
  } catch (e) {
    if (e instanceof ErroCatalogo) return jsonResponse({ error: e.message }, e.status);
    if (e instanceof ComprasGovIndisponivel) {
      return jsonResponse({ error: "O Compras.gov não respondeu a tempo. Tente de novo em instantes.", detalhe: e.message }, 504);
    }
    console.error("[api-catmat] erro interno:", e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
