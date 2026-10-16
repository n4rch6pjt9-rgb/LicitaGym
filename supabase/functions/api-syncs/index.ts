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
 *   POST {action:"rodar", sync:"coletor-pncp"} -> workflow_dispatch no GitHub (GITHUB_ACTIONS_TOKEN, GITHUB_ACTIONS_REPO).
 * Acesso: cron (SYNC_CRON_SECRET) ou app_metadata.licitagym_role = 'admin'.
 * Os segredos (cron e token do GitHub) saem só no servidor, nos headers das chamadas. Não voltam na resposta.
 */

export interface ApiSyncsContext {
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  fetchFn?: typeof fetch;
  segredo?: () => string | null;
  baseUrl?: () => string | null;
  /** Token do GitHub com permissão Actions: write no repositório (fine-grained). */
  githubToken?: () => string | null;
  /** "dono/repo" do workflow: GITHUB_ACTIONS_REPO, padrão n4rch6pjt9-rgb/LicitaGym; null = variável inválida. */
  githubRepo?: () => string | null;
}

const REPO_PADRAO = "n4rch6pjt9-rgb/LicitaGym";

function tokenGithub(): string | null {
  const t = Deno.env.get("GITHUB_ACTIONS_TOKEN")?.trim() ?? "";
  return t.length > 0 ? t : null;
}

/** "dono/repo" válido, o padrão quando a variável está ausente, ou null quando ela existe e está errada (não cai no padrão em silêncio). */
function repoGithub(): string | null {
  const r = Deno.env.get("GITHUB_ACTIONS_REPO")?.trim() ?? "";
  if (r.length === 0) return REPO_PADRAO;
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
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

// ---- spec 0025: último cron agendado e refazer as etapas que falharam ----

/** Conclusões do run agendado que liberam o `refazer` (decisão do Marcelo, 16/10: `cancelled` também). */
const CONCLUSOES_REFAZER = new Set(["failure", "cancelled", "timed_out"]);

interface EtapaCron {
  nome: string;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface UltimoCron {
  run_id: number;
  status: string | null;
  conclusion: string | null;
  run_attempt: number | null;
  created_at: string | null;
  html_url: string | null;
  etapas: EtapaCron[];
}

interface EstadoCron {
  ultimo_cron: UltimoCron | null;
  pode_refazer: boolean;
  motivo_refazer: string | null;
  erro_ultimo_cron: string | null;
}

class FalhaGithub extends Error {}

function cabecalhosGithub(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function lerGithub(fetchFn: typeof fetch, token: string, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: cabecalhosGithub(token), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new FalhaGithub(`GitHub não respondeu (${e instanceof Error ? e.name : "erro"}).`);
  }
  if (!res.ok) throw new FalhaGithub(`GitHub respondeu ${res.status} ao ler os runs do workflow.`);
  const corpo = await res.json().catch(() => null);
  if (typeof corpo !== "object" || corpo === null) throw new FalhaGithub("GitHub devolveu um corpo inválido.");
  return corpo as Record<string, unknown>;
}

function texto(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Lê o último run agendado, as etapas dele e se há run do workflow na fila. Falha de leitura vira erro, nunca "cron ok". */
async function estadoCron(
  item: { github_workflow?: string },
  token: string | null,
  repo: string | null,
  fetchFn: typeof fetch,
): Promise<EstadoCron> {
  const erro = (m: string): EstadoCron => ({ ultimo_cron: null, pode_refazer: false, motivo_refazer: null, erro_ultimo_cron: m });
  if (!token) return erro("Leitura do cron não configurada (GITHUB_ACTIONS_TOKEN).");
  if (!repo) return erro("GITHUB_ACTIONS_REPO inválido (use dono/repo).");
  const base = `https://api.github.com/repos/${repo}/actions`;
  try {
    const agendados = await lerGithub(fetchFn, token, `${base}/workflows/${item.github_workflow}/runs?event=schedule&per_page=1`);
    const lista = Array.isArray(agendados.workflow_runs) ? agendados.workflow_runs : [];
    const run = lista[0] as Record<string, unknown> | undefined;
    if (!run || typeof run.id !== "number") {
      return { ultimo_cron: null, pode_refazer: false, motivo_refazer: "Nenhum run agendado encontrado.", erro_ultimo_cron: null };
    }
    const jobs = await lerGithub(fetchFn, token, `${base}/runs/${run.id}/jobs?per_page=100`);
    const etapas: EtapaCron[] = (Array.isArray(jobs.jobs) ? jobs.jobs : []).map((j: Record<string, unknown>) => ({
      nome: texto(j.name) ?? "",
      status: texto(j.status),
      conclusion: texto(j.conclusion),
      started_at: texto(j.started_at),
      completed_at: texto(j.completed_at),
    }));
    const ultimo: UltimoCron = {
      run_id: run.id,
      status: texto(run.status),
      conclusion: texto(run.conclusion),
      run_attempt: typeof run.run_attempt === "number" ? run.run_attempt : null,
      created_at: texto(run.created_at),
      html_url: texto(run.html_url),
      etapas,
    };
    const recentes = await lerGithub(fetchFn, token, `${base}/workflows/${item.github_workflow}/runs?per_page=30`);
    const ativo = (Array.isArray(recentes.workflow_runs) ? recentes.workflow_runs : [])
      .some((r: Record<string, unknown>) => r.status !== "completed");
    let motivo: string | null = null;
    if (ultimo.status !== "completed") motivo = "O cron agendado ainda não terminou.";
    else if (!CONCLUSOES_REFAZER.has(ultimo.conclusion ?? "")) motivo = `O cron agendado terminou em ${ultimo.conclusion ?? "estado desconhecido"}.`;
    else if (ativo) motivo = "Há um run do workflow na fila ou rodando.";
    return { ultimo_cron: ultimo, pode_refazer: motivo === null, motivo_refazer: motivo, erro_ultimo_cron: null };
  } catch (e) {
    if (e instanceof FalhaGithub) return erro(e.message);
    console.error("[api-syncs] estadoCron", e instanceof Error ? e.message : String(e));
    return erro("Falha ao ler o último cron no GitHub.");
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
  const fetchGh = ctx.fetchFn ?? fetch;
  if (action === "listar") {
    const syncs = await Promise.all(SYNCS.map(async (s) => {
      if (!s.refazer_cron) return s;
      const estado = await estadoCron(s, (ctx.githubToken ?? tokenGithub)(), (ctx.githubRepo ?? repoGithub)(), fetchGh);
      return { ...s, ...estado };
    }));
    return jsonResponse({ action: "listar", syncs });
  }
  if (action === "refazer") {
    // Só admin (decisão do Marcelo, 16/10): o cron não refaz.
    if (cron) return jsonResponse({ error: "Sem permissão: só administradores refazem o cron." }, 403);
    const item = typeof body.sync === "string" ? syncPorSlug(body.sync) : undefined;
    if (!item || !item.refazer_cron) return jsonResponse({ error: "Este sync não tem cron para refazer." }, 400);
    const token = (ctx.githubToken ?? tokenGithub)();
    const repo = (ctx.githubRepo ?? repoGithub)();
    if (!token) return jsonResponse({ error: "Disparo do coletor não configurado (GITHUB_ACTIONS_TOKEN)." }, 500);
    if (!repo) return jsonResponse({ error: "GITHUB_ACTIONS_REPO inválido (use dono/repo)." }, 500);
    // O run vem sempre da leitura do servidor; um run_id no corpo é ignorado.
    const estado = await estadoCron(item, token, repo, fetchGh);
    if (estado.erro_ultimo_cron) return jsonResponse({ error: estado.erro_ultimo_cron }, 502);
    if (!estado.pode_refazer || !estado.ultimo_cron) {
      return jsonResponse({ error: estado.motivo_refazer ?? "Nada para refazer.", ultimo_cron: estado.ultimo_cron }, 409);
    }
    const runId = estado.ultimo_cron.run_id;
    try {
      const res = await fetchGh(`https://api.github.com/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {
        method: "POST",
        headers: cabecalhosGithub(token),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 201) {
        return jsonResponse({ error: "O GitHub recusou refazer as etapas.", http: res.status, resposta: await corpoResposta(res) }, 502);
      }
      return jsonResponse({
        action: "refazer",
        sync: item.slug,
        http: res.status,
        resposta: { status: "refeito", run_id: runId, acompanhe: estado.ultimo_cron.html_url },
      });
    } catch (e) {
      console.error("[api-syncs] refazer", e instanceof Error ? e.message : String(e));
      return jsonResponse({ error: "Falha ao pedir ao GitHub que refaça as etapas." }, 502);
    }
  }
  if (action !== "rodar") return jsonResponse({ error: "Ação não suportada. Use 'listar', 'rodar' ou 'refazer'." }, 400);

  const slug = body.sync;
  if (typeof slug !== "string" || !slug) return jsonResponse({ error: "Informe sync." }, 400);
  const item = syncPorSlug(slug);
  if (!item) return jsonResponse({ error: "Sync desconhecido." }, 400);
  if (!item.disparavel || (!item.funcao && !item.github_workflow)) {
    return jsonResponse({ error: item.aviso ?? "Este sync não dispara daqui." }, 400);
  }

  if (item.github_workflow) {
    // Coletor Python: roda no GitHub Actions. O token nunca volta na resposta.
    const token = (ctx.githubToken ?? tokenGithub)();
    const repo = (ctx.githubRepo ?? repoGithub)();
    if (!token) return jsonResponse({ error: "Disparo do coletor não configurado (GITHUB_ACTIONS_TOKEN)." }, 500);
    if (!repo) return jsonResponse({ error: "GITHUB_ACTIONS_REPO inválido (use dono/repo)." }, 500);
    const inputs = Object.fromEntries(Object.entries(item.corpo).map(([k, v]) => [k, String(v)]));
    try {
      const fetchFn = ctx.fetchFn ?? fetch;
      const res = await fetchFn(`https://api.github.com/repos/${repo}/actions/workflows/${item.github_workflow}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs }),
        signal: AbortSignal.timeout(30_000),
      });
      const resposta = res.status === 204
        ? { status: "disparado", inputs, acompanhe: `https://github.com/${repo}/actions/workflows/${item.github_workflow}` }
        : await corpoResposta(res);
      return jsonResponse({ action: "rodar", sync: item.slug, http: res.status, resposta });
    } catch (e) {
      console.error("[api-syncs]", item.slug, e instanceof Error ? e.message : String(e));
      return jsonResponse({ error: "Falha ao disparar o workflow no GitHub." }, 502);
    }
  }

  const segredo = (ctx.segredo ?? segredoCron)();
  const base = (ctx.baseUrl ?? baseDasFuncoes)();
  if (!segredo || !base) return jsonResponse({ error: "Sync manual não configurado." }, 500);

  try {
    const fetchFn = ctx.fetchFn ?? fetch;
    const res = await fetchFn(`${base}/${item.funcao as string}`, {
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
