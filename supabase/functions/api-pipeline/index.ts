import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { createSupabaseRepo, ErroPipeline, type PipelineRepo } from "./repo.ts";
import { ACOES_ADMIN } from "./types.ts";
import { parseActionFromBody } from "./validation.ts";

/**
 * api-pipeline: pipeline comercial da equipe (Dashboard #29).
 *   Leitura e movimentação (etapas_listar, pipeline_listar/estado/historico, pipeline_adicionar/mover/remover):
 *   qualquer usuário autenticado. Configuração das etapas (etapa_criar/atualizar/excluir): só
 *   app_metadata.licitagym_role = 'admin'. O banco é acessado com service_role; o JWT só identifica e autoriza.
 *   O pipeline é do tenant (equipe); hoje há um tenant ativo e o usuário ainda não é ligado a empresa.
 */

export interface ApiPipelineContext {
  getRepo?: () => PipelineRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handleRequest(req: Request, ctx: ApiPipelineContext = {}): Promise<Response> {
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
    return jsonResponse({ error: "Sem permissão: só administradores configuram as etapas do pipeline." }, 403);
  }

  try {
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(getDefaultServiceClient())))();
    const tenant = await repo.tenantDoUsuario(user.id);

    switch (params.action) {
      case "etapas_listar":
        return jsonResponse({ action: params.action, etapas: await repo.listarEtapas(tenant) });

      case "pipeline_listar":
        return jsonResponse({ action: params.action, ...(await repo.listarPipeline(tenant, params.etapa_id)) });

      case "pipeline_estado":
        return jsonResponse({ action: params.action, estado: await repo.estado(tenant, params.licitacao_ids) });

      case "pipeline_adicionar": {
        // Entra na primeira etapa sem desfecho; quem já está no pipeline não muda de etapa (atômico no banco).
        const etapas = await repo.listarEtapas(tenant);
        const inicial = etapas.filter((e) => !e.desfecho)[0] ?? etapas[0];
        if (!inicial) return jsonResponse({ error: "O pipeline não tem etapas configuradas." }, 409);
        const n = await repo.mover(tenant, params.licitacao_ids, inicial.id, null, user.id, true);
        console.info("[api-pipeline] adicionar", { user: user.id, n, pedidas: params.licitacao_ids.length });
        return jsonResponse({ action: params.action, adicionadas: n, ja_no_pipeline: params.licitacao_ids.length - n, etapa: inicial });
      }

      case "pipeline_mover": {
        const n = await repo.mover(tenant, params.licitacao_ids, params.etapa_id, params.motivo, user.id);
        console.info("[api-pipeline] mover", { user: user.id, etapa: params.etapa_id, n });
        return jsonResponse({ action: params.action, movidas: n, etapa_id: params.etapa_id });
      }

      case "pipeline_remover": {
        const n = await repo.mover(tenant, params.licitacao_ids, null, null, user.id);
        console.info("[api-pipeline] remover", { user: user.id, n });
        return jsonResponse({ action: params.action, removidas: n });
      }

      case "pipeline_historico":
        return jsonResponse({ action: params.action, eventos: await repo.historico(tenant, params.licitacao_id) });

      case "etapa_criar": {
        const { action: _a, ...e } = params;
        const etapa = await repo.criarEtapa(tenant, e, user.id);
        console.info("[api-pipeline] etapa_criar", { user: user.id, etapa: etapa.id });
        return jsonResponse({ action: params.action, etapa }, 201);
      }

      case "etapa_atualizar": {
        const { action: _a, id, ...campos } = params;
        const etapa = await repo.atualizarEtapa(tenant, id, campos, user.id);
        if (!etapa) return jsonResponse({ error: "Etapa não encontrada." }, 404);
        return jsonResponse({ action: params.action, etapa });
      }

      case "etapa_excluir": {
        const movidas = await repo.excluirEtapa(tenant, params.id, params.mover_para, user.id);
        console.info("[api-pipeline] etapa_excluir", { user: user.id, etapa: params.id, movidas });
        return jsonResponse({ action: params.action, excluida: params.id, movidas });
      }
    }
  } catch (e) {
    if (e instanceof ErroPipeline) return jsonResponse({ error: e.message }, e.status);
    console.error("[api-pipeline] erro interno:", e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
