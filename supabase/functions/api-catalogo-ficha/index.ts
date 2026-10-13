import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { ErroTenantAcesso, lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import { ErroFicha, planejar, validarFicha } from "./ficha.ts";
import { createSupabaseRepo, type FichaRepo } from "./repo.ts";

/**
 * api-catalogo-ficha: grava a ficha lida de uma página de produto no catálogo da empresa.
 * O navegador manda os campos já extraídos (não o HTML). service_role só depois do JWT
 * e da empresa de quem chama (_shared/tenant.ts). A marca sai do host da URL.
 */

export interface ApiFichaContext {
  getRepo?: () => FichaRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  tenantDe?: (user: AuthenticatedUser) => Promise<TenantResolvido>;
  agora?: () => string;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function handleRequest(req: Request, ctx: ApiFichaContext = {}): Promise<Response> {
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

  try {
    const entrada = validarFicha(body as Record<string, unknown>);
    const client = ctx.getRepo ? null : getDefaultServiceClient();
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(client!)))();
    const tenantDe = ctx.tenantDe ?? ((u: AuthenticatedUser) =>
      lerTenantDoUsuario(client!, u.id, isLicitagymAdmin(u)));
    const { tenant } = await tenantDe(user);
    const porUrl = await repo.porUrl(entrada.url);
    const porCodigo = await repo.porCodigo(tenant, entrada.codigo);
    const agora = (ctx.agora ?? (() => new Date().toISOString()))();
    const plano = planejar(tenant, entrada, porUrl, porCodigo, agora);
    let id: number;
    if (plano.id === null) {
      id = await repo.inserir(plano.linha);
    } else {
      await repo.atualizar(plano.id, plano.linha);
      id = plano.id;
    }
    if (entrada.medidas) await repo.gravarMedida(id, entrada.medidas);
    return jsonResponse({
      id,
      codigo: entrada.codigo,
      nome: entrada.nome,
      url: entrada.url,
      atualizado: plano.id !== null,
    });
  } catch (err) {
    if (err instanceof ErroFicha) return jsonResponse({ error: err.message }, err.status);
    if (err instanceof ErroTenantAcesso) return jsonResponse({ error: err.message }, err.status);
    console.error("[api-catalogo-ficha]", err instanceof Error ? err.message : "erro");
    return jsonResponse({ error: "Não foi possível gravar a ficha." }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
