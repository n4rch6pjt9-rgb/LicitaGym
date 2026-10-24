import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { ErroTenantAcesso } from "../_shared/tenant.ts";
import { createSupabaseRepo, type TarefasRepo } from "./repo.ts";
import type { Bloqueio, Tarefa } from "./types.ts";
import { parseActionFromBody } from "./validation.ts";

/**
 * api-tarefas: tarefas da equipe por licitação, em cima do catálogo 14.133 (#252, spec 0019).
 *   catalogo_liberadas: prévia (não grava) do que uma fase ou um evento liberam. Admin ou operação.
 *   tarefas_liberar:    grava as tarefas (tarefas_equipe_liberar). Só admin da empresa ou o desenvolvedor.
 *   tarefas_listar:     admin vê todas da empresa; operação só as atribuídas a ela.
 *   tarefa_atualizar:   status (admin: qualquer; operação: só as dela) e prazo manual (só admin).
 *   tarefa_atribuir:    só admin; o responsável precisa ser membro ativo da mesma empresa; null volta à fila.
 *   Tarefa de agente (spec 0035, R-11): status só pela revisão da análise (api-agentes), nunca à mão (409);
 *   atribuir muda quem revisa, não o tipo.
 *   Tarefa de outra empresa responde 404 (toda leitura e escrita filtra tenant_id).
 * Só licitação no pipeline da empresa recebe tarefa. Regulamento nulo ou sem catálogo bloqueia a liberação (409).
 * Banco com service_role depois de conferir o usuário; empresa por _shared/tenant.ts.
 */

export interface ApiTarefasContext {
  getRepo?: () => TarefasRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
}

const MENSAGEM_BLOQUEIO: Record<Bloqueio, { status: number; mensagem: string }> = {
  fora_do_pipeline: { status: 404, mensagem: "Licitação fora do pipeline da empresa." },
  regulamento_nao_informado: {
    status: 409,
    mensagem: "O regulamento da licitação ainda não foi informado: as tarefas do catálogo aguardam o preenchimento do regulamento.",
  },
  regulamento_sem_catalogo: {
    status: 409,
    mensagem: "O regulamento da licitação não tem catálogo de tarefas (só Lei 14.133 e Lei 14.981).",
  },
};

/** Mesmo gate de tarefas_equipe_liberar, para a prévia. */
function bloqueioRegulamento(regulamento: string | null): Bloqueio | null {
  if (regulamento === null) return "regulamento_nao_informado";
  return ["LEI_14133", "LEI_14981"].includes(regulamento) ? null : "regulamento_sem_catalogo";
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handleRequest(req: Request, ctx: ApiTarefasContext = {}): Promise<Response> {
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
  try {
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(getDefaultServiceClient())))();
    const { tenant, papel } = await repo.tenantDoUsuario(user.id, isLicitagymAdmin(user));
    // Desenvolvedor (app_metadata) vale como admin da empresa em que caiu.
    const admin = isLicitagymAdmin(user) || papel === "admin";

    switch (params.action) {
      case "catalogo_liberadas": {
        if (!(await repo.estaNoPipeline(tenant, params.licitacao_id))) {
          return jsonResponse({ error: MENSAGEM_BLOQUEIO.fora_do_pipeline.mensagem }, 404);
        }
        const bloqueio = bloqueioRegulamento(await repo.regulamento(params.licitacao_id));
        const tarefas = await repo.previa(params.licitacao_id, params.fase, params.evento);
        return jsonResponse({ action: params.action, bloqueio, tarefas });
      }

      case "tarefas_liberar": {
        if (!admin) return jsonResponse({ error: "Sem permissão: só o admin da empresa libera tarefas." }, 403);
        const r = await repo.liberar(tenant, params.licitacao_id, params.fase, params.evento, user.id);
        if (r.bloqueio) {
          const b = MENSAGEM_BLOQUEIO[r.bloqueio];
          return jsonResponse({ error: b.mensagem, bloqueio: r.bloqueio }, b.status);
        }
        console.info("[api-tarefas] liberar", { user: user.id, licitacao: params.licitacao_id, criadas: r.criadas });
        return jsonResponse({ action: params.action, criadas: r.criadas, existentes: r.existentes });
      }

      case "tarefas_listar": {
        const responsavel = !admin || params.minhas ? user.id : null;
        const r = await repo.listar(tenant, { licitacao_id: params.licitacao_id, status: params.status, responsavel });
        return jsonResponse({ action: params.action, ...r });
      }

      case "tarefa_atualizar": {
        const tarefa = await repo.obter(tenant, params.id);
        if (!tarefa) return jsonResponse({ error: "Tarefa não encontrada." }, 404);
        if (!admin && tarefa.responsavel_user_id !== user.id) {
          return jsonResponse({ error: "Sem permissão: a tarefa não está atribuída a você." }, 403);
        }
        if (params.prazo_em !== undefined && !admin) {
          return jsonResponse({ error: "Sem permissão: só o admin da empresa informa o prazo." }, 403);
        }
        if (params.status !== undefined && params.status !== tarefa.status && tarefa.responsavel_tipo === "agente") {
          return jsonResponse({ error: "Tarefa de agente: conclua ou reabra pela revisão da análise do agente." }, 409);
        }
        const campos: Partial<Tarefa> = {};
        if (params.status !== undefined && params.status !== tarefa.status) {
          campos.status = params.status;
          campos.concluida_em = params.status === "concluida" ? new Date().toISOString() : null;
        }
        if (params.prazo_em !== undefined) {
          campos.prazo_situacao = "manual";
          campos.prazo_em = params.prazo_em;
          campos.prazo_informado_por = user.id;
          campos.prazo_informado_em = new Date().toISOString();
        }
        if (Object.keys(campos).length === 0) return jsonResponse({ action: params.action, tarefa });
        // Operação: o UPDATE só vale se a tarefa ainda está com ela (o admin pode ter reatribuído no meio).
        const atualizada = await repo.atualizar(tenant, params.id, campos, user.id, admin ? undefined : user.id);
        if (!atualizada) return jsonResponse({ error: "Sem permissão: a tarefa não está atribuída a você." }, 403);
        return jsonResponse({ action: params.action, tarefa: atualizada });
      }

      case "tarefa_atribuir": {
        if (!admin) return jsonResponse({ error: "Sem permissão: só o admin da empresa atribui tarefas." }, 403);
        const tarefa = await repo.obter(tenant, params.id);
        if (!tarefa) return jsonResponse({ error: "Tarefa não encontrada." }, 404);
        let papelResp: "admin" | "operacao" = "admin";
        if (params.user_id !== null) {
          const p = await repo.papelDoMembro(tenant, params.user_id);
          if (!p) return jsonResponse({ error: "O usuário não é membro ativo da empresa." }, 400);
          papelResp = p;
        }
        const atualizada = await repo.atualizar(
          tenant, params.id, {
            responsavel_user_id: params.user_id,
            responsavel_papel: papelResp,
            // tarefa de agente segue de agente (R-11); as outras passam a usuário ou voltam à fila do papel
            ...(tarefa.responsavel_tipo === "agente" ? {} : { responsavel_tipo: params.user_id !== null ? "usuario" as const : "papel" as const }),
          }, user.id,
        );
        if (!atualizada) return jsonResponse({ error: "Tarefa não encontrada." }, 404);
        console.info("[api-tarefas] atribuir", { user: user.id, tarefa: params.id, para: params.user_id });
        return jsonResponse({ action: params.action, tarefa: atualizada });
      }
    }
  } catch (e) {
    if (e instanceof ErroTenantAcesso) return jsonResponse({ error: e.message }, e.status);
    console.error("[api-tarefas] erro interno:", e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
