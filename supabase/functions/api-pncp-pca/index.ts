import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  corsHeaders,
  errorDetail,
  jsonResponse,
  parseQueryInt,
  requireCronAuth,
  requireUserAuth,
} from "../_shared/http.ts";
import { beginIdempotency, finishIdempotency } from "../_shared/pncp/idempotency.ts";
import {
  agregarLeadingPca,
  cnpjDigitos,
  numeroOuAusente,
  parseDataIso,
  parseUnidade,
  type PcaItemLeading,
} from "../../../Dashboard/src/data/pcaLeading.ts";

function getUserClient(req: Request) {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) throw new Error("Supabase env missing");
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
}

const PAGE = 1000;
const MAX_PAGES = 20;

function hojeUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function planoDe(raw: unknown): {
  id: string;
  orgao_cnpj: string | null;
  last_synced_at: string | null;
  ativo: boolean;
} | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return {
    id: o.id,
    orgao_cnpj: typeof o.orgao_cnpj === "string" ? o.orgao_cnpj : null,
    last_synced_at: typeof o.last_synced_at === "string" ? o.last_synced_at : null,
    ativo: o.ativo !== false,
  };
}

function itemDe(raw: Record<string, unknown>): PcaItemLeading {
  const plano = planoDe(raw.pca_planos);
  if (!plano) {
    throw new Error("Não verificado — plano do item PCA ausente na leitura.");
  }
  if (!plano.ativo) {
    throw new Error("Não verificado — item ativo ligado a plano inativo.");
  }
  const pdmRows = Array.isArray(raw.pca_item_pdm) ? raw.pca_item_pdm : [];
  const confirmado = pdmRows.some((row) =>
    !!row && typeof row === "object" && (row as { confirmado?: unknown }).confirmado === true
  );
  const syncs = [raw.last_synced_at, plano.last_synced_at].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return {
    planoId: plano.id,
    orgaoCnpj: cnpjDigitos(plano.orgao_cnpj),
    valorTotalEstimado: numeroOuAusente(raw.valor_total_estimado),
    dataPrevista: typeof raw.data_prevista_contratacao === "string"
      ? raw.data_prevista_contratacao
      : null,
    prioridade: typeof raw.prioridade === "string" ? raw.prioridade : null,
    pdmCodigoOrigem: typeof raw.pdm_codigo_origem === "string" ? raw.pdm_codigo_origem : null,
    pdmInferido: pdmRows.length > 0,
    pdmConfirmado: confirmado,
    lastSyncedAt: syncs.sort().at(-1) ?? null,
  };
}

async function carregarItens(
  client: ReturnType<typeof getUserClient>,
): Promise<PcaItemLeading[]> {
  const itens: PcaItemLeading[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await client
      .from("pca_itens")
      .select(`
        id,
        valor_total_estimado,
        data_prevista_contratacao,
        prioridade,
        pdm_codigo_origem,
        last_synced_at,
        ativo,
        pca_planos ( id, orgao_cnpj, last_synced_at, ativo ),
        pca_item_pdm ( confirmado )
      `)
      .eq("ativo", true)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) {
      throw new Error(error.message || "Falha ao ler pca_itens");
    }
    const batch = data ?? [];
    for (const raw of batch) {
      itens.push(itemDe(raw as Record<string, unknown>));
    }
    if (batch.length < PAGE) return itens;
  }
  throw new Error(
    "Leitura de PCA interrompida: limite de páginas atingido. O resultado não é a base inteira.",
  );
}

async function responderLeading(
  req: Request,
  unidadeRaw: unknown,
  hojeRaw: unknown,
): Promise<Response> {
  const denied = await requireUserAuth(req);
  if (denied) return denied;
  const unidade = parseUnidade(unidadeRaw);
  if (!unidade) return jsonResponse({ error: "unidade inválida" }, 400);
  if (hojeRaw != null && hojeRaw !== "" && !parseDataIso(hojeRaw)) {
    return jsonResponse({ error: "data_referencia inválida" }, 400);
  }
  const hoje = parseDataIso(hojeRaw) ?? hojeUtc();
  try {
    const itens = await carregarItens(getUserClient(req));
    return jsonResponse(agregarLeadingPca(itens, { hoje, unidade }));
  } catch (error) {
    return jsonResponse({ error: errorDetail(error) }, 502);
  }
}

async function triggerSync(body: Record<string, unknown>) {
  const base = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const secret = Deno.env.get("SYNC_CRON_SECRET");
  if (!base || !secret) throw new Error("Sync não configurado");
  const res = await fetch(`${base}/functions/v1/sync-pncp-pca`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("visao") === "leading") {
      return await responderLeading(
        req,
        url.searchParams.get("unidade"),
        url.searchParams.get("data_referencia"),
      );
    }
    const client = getUserClient(req);
    const ano = parseQueryInt(url, "ano", new Date().getUTCFullYear());
    const page = parseQueryInt(url, "page", 1);
    const limit = Math.min(parseQueryInt(url, "limit", 20), 100);
    const offset = (page - 1) * limit;

    const { data, error, count } = await client
      .from("pca_planos")
      .select("*", { count: "exact" })
      .eq("ativo", true)
      .eq("ano_exercicio", ano)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ data, page, limit, total: count ?? 0 });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const registro = body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    if (registro.action === "leading") {
      return await responderLeading(req, registro.unidade, registro.data_referencia);
    }

    // AUTH → AUTHORIZE before any privileged state (idempotency / sync)
    const denied = requireCronAuth(req);
    if (denied) return denied;

    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return jsonResponse({ error: "Header Idempotency-Key obrigatório" }, 400);
    }

    const serviceUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceUrl || !serviceKey) {
      return jsonResponse({ error: "Service role não configurado" }, 500);
    }

    const admin = createClient(serviceUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const rota = "POST /api/pca/sync";
    const begin = await beginIdempotency(admin, idempotencyKey, rota, registro);
    if (begin.skip) return jsonResponse(begin.resposta);

    const result = await triggerSync(registro);
    await finishIdempotency(admin, idempotencyKey, rota, result.body, result.status);
    return jsonResponse(result.body, result.status);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
});
