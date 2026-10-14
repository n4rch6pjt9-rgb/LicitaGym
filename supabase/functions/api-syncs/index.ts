import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  type AuthenticatedUser,
  authenticateCron,
  authenticateUser,
  corsHeaders,
  isLicitagymAdmin,
  jsonResponse,
} from "../_shared/http.ts";
import { SYNCS, syncPorSlug } from "./catalogo.ts";

/**
 * api-syncs: catálogo dos syncs e disparo manual.
 *   POST {action:"listar"} -> { syncs: [...] }
 *   POST {action:"rodar", sync:"sync-portal-compras"} -> encaminha o corpo do catálogo para a função.
 * Acesso: cron (SYNC_CRON_SECRET) ou app_metadata.licitagym_role = 'admin'.
 * O segredo de cron sai só no servidor, no Authorization da função chamada. Não volta na resposta.
 */

export interface ApiSyncsContext {
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  fetchFn?: typeof fetch;
  segredo?: () => string | null;
  baseUrl?: () => string | null;
}

function segredoCron(): string | null {
  const bruto = Deno.env.get("SYNC_CRON_SECRET")?.trim() ?? "";
  const um = bruto.split(",").map((s) => s.trim()).find((s) => s.length > 0);
  return um ?? null;
}

function baseDasFuncoes(): string | null {
  const url = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/+$/, "");
  return url ? `${url}/functions/v1` : null;
}

async function corpoResposta(res: Response): Promise<unknown> {
  const texto = await res.text();
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return { texto: texto.slice(0, 500) };
  }
}

export async function handleRequest(req: Request, ctx: ApiSyncsContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const cron = (ctx.isCron ?? ((r: Request) => authenticateCron(r) === "CRON_AUTHENTICATED"))(req);
  if (!cron) {
    const user = await (ctx.getUser ?? authenticateUser)(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
    if (!isLicitagymAdmin(user)) return jsonResponse({ error: "Sem permissão: só administradores disparam sync." }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }

  const action = body.action ?? "listar";
  if (action === "listar") {
    return jsonResponse({ action: "listar", syncs: SYNCS });
  }
  if (action !== "rodar") return jsonResponse({ error: "Ação não suportada. Use 'listar' ou 'rodar'." }, 400);

  const slug = body.sync;
  if (typeof slug !== "string" || !slug) return jsonResponse({ error: "Informe sync." }, 400);
  const item = syncPorSlug(slug);
  if (!item) return jsonResponse({ error: "Sync desconhecido." }, 400);
  if (!item.disparavel || !item.funcao) {
    return jsonResponse({ error: item.aviso ?? "Este sync não dispara daqui." }, 400);
  }

  const segredo = (ctx.segredo ?? segredoCron)();
  const base = (ctx.baseUrl ?? baseDasFuncoes)();
  if (!segredo || !base) return jsonResponse({ error: "Sync manual não configurado." }, 500);

  try {
    const fetchFn = ctx.fetchFn ?? fetch;
    const res = await fetchFn(`${base}/${item.funcao}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${segredo}`,
        "Content-Type": "application/json",
      },
      // origem manual: quem disparou foi a tela (spec 0023); o pg_cron manda origem cron no corpo do job.
      body: JSON.stringify({ ...item.corpo, origem: "manual" }),
      signal: AbortSignal.timeout(140_000),
    });
    const resposta = await corpoResposta(res);
    // 200 daqui significa que a função foi chamada. O status dela vai em `http`,
    // para a tela mostrar o corpo mesmo quando o sync recusa.
    return jsonResponse({
      action: "rodar",
      sync: item.slug,
      http: res.status,
      resposta,
    });
  } catch (e) {
    console.error("[api-syncs]", item.slug, e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "Falha ao chamar o sync." }, 502);
  }
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));
