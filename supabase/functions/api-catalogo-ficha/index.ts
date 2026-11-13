import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { ErroTenantAcesso, lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import { ErroFicha, planejar, validarFicha } from "./ficha.ts";
import { createSupabaseRepo, type FichaRepo } from "./repo.ts";

/**
 * api-catalogo-ficha: catálogo de produtos da empresa.
 * - action "gravar": grava a ficha lida de uma página de produto. O navegador manda os campos já extraídos
 *   (não o HTML). A marca sai do host da URL.
 * - action "listar": os produtos da empresa de quem chama, com os atributos da ficha (catalogo_produto_atributos).
 *   A RLS de catalogo_produtos libera authenticated sem filtro de empresa: a tela lê só por aqui.
 * service_role só depois do JWT e da empresa de quem chama (_shared/tenant.ts).
 */

/** Até quantos produtos a listagem devolve; `truncado` avisa quando havia mais. */
export const LIMITE_CATALOGO = 500;

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

  const corpo = body as Record<string, unknown>;
  const action = corpo.action;
  if (action !== "gravar" && action !== "listar") return jsonResponse({ error: "Ação desconhecida." }, 400);

  try {
    // Validar antes de abrir o banco: pedido inválido não gasta conexão.
    const entrada = action === "gravar" ? validarFicha(corpo) : null;
    const client = ctx.getRepo ? null : getDefaultServiceClient();
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(client!)))();
    const tenantDe = ctx.tenantDe ?? ((u: AuthenticatedUser) =>
      lerTenantDoUsuario(client!, u.id, isLicitagymAdmin(u)));
    const { tenant } = await tenantDe(user);
    if (!entrada) {
      const { itens, truncado } = await repo.listar(tenant, LIMITE_CATALOGO);
      return jsonResponse({ itens, truncado });
    }
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
    await repo.gravarAtributos(id, plano.atributosFicha);
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
    return jsonResponse({ error: action === "listar" ? "Não foi possível ler o catálogo." : "Não foi possível gravar a ficha." }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
