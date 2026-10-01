import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type AuthenticatedUser,
  authenticateCron,
  authenticateUser,
  corsHeaders,
  isLicitagymAdmin,
  jsonResponse,
} from "../_shared/http.ts";

/**
 * api-saude: saúde operacional da ingestão (private.saude_operacional_resumo, migration 20261001100000).
 *   POST {action: "resumo"} -> {status_geral, contagem, verificacoes[]}
 * Acesso: cron secret (workflow .github/workflows/saude.yml) ou usuário com app_metadata.licitagym_role = 'admin'.
 * Usuário comum: 403 (o detalhe traz mensagens de erro internas). Sem credencial: 401.
 */

export type StatusSaude = "ok" | "atencao" | "critico";

export interface Verificacao {
  verificacao: string;
  status: StatusSaude;
  valor: number | null;
  unidade: string;
  atencao: number;
  critico: number | null;
  mensagem: string;
  detalhe: unknown;
}

export interface ApiSaudeContext {
  getResumo?: () => Promise<Verificacao[]>;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  agora?: () => Date;
}

const ORDEM: Record<StatusSaude, number> = { ok: 0, atencao: 1, critico: 2 };

async function resumoDoBanco(): Promise<Verificacao[]> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.schema("private").rpc("saude_operacional_resumo");
  if (error) throw new Error(`saude_operacional_resumo: ${error.message}`);
  return (data ?? []) as Verificacao[];
}

export function consolidar(verificacoes: Verificacao[]) {
  const contagem = { ok: 0, atencao: 0, critico: 0 };
  let geral: StatusSaude = "ok";
  for (const v of verificacoes) {
    const s = (v.status in ORDEM ? v.status : "atencao") as StatusSaude; // status desconhecido nunca vira "ok"
    contagem[s]++;
    if (ORDEM[s] > ORDEM[geral]) geral = s;
  }
  return { status_geral: geral, contagem };
}

export async function handleRequest(req: Request, ctx: ApiSaudeContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const cron = (ctx.isCron ?? ((r: Request) => authenticateCron(r) === "CRON_AUTHENTICATED"))(req);
  if (!cron) {
    const user = await (ctx.getUser ?? authenticateUser)(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
    if (!isLicitagymAdmin(user)) return jsonResponse({ error: "Sem permissão: só administradores veem a saúde operacional." }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }
  const action = body.action ?? "resumo";
  if (action !== "resumo") return jsonResponse({ error: "Ação não suportada. Use 'resumo'." }, 400);

  try {
    const verificacoes = await (ctx.getResumo ?? resumoDoBanco)();
    const { status_geral, contagem } = consolidar(verificacoes);
    console.info("[api-saude] resumo", { origem: cron ? "cron" : "admin", status_geral, ...contagem });
    return jsonResponse({
      action: "resumo",
      gerado_em: (ctx.agora?.() ?? new Date()).toISOString(),
      status_geral,
      contagem,
      verificacoes,
    });
  } catch (e) {
    console.error("[api-saude] erro", e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: "Falha ao calcular a saúde operacional." }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));
