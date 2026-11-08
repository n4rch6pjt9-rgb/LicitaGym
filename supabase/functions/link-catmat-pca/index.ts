import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  jsonResponse,
  validateCronAuth,
} from "../_shared/http.ts";
import { linkTargetClasses } from "../_shared/pncp/catmat-scope-resolver.ts";
import { createServiceClient } from "../_shared/pncp/supabase-admin.ts";

type LinkBody = {
  classe_catmat?: string;
  limite?: number;
  /** Deslocamento estável (ordenacao por id) para paginar todos os pca_itens da classe. */
  offset?: number;
  /** Similaridade mínima 0-1 para match por descrição (default 0.55). */
  limiar_similaridade?: number;
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((t) => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

type LinkClient = ReturnType<typeof createServiceClient>;

type Vinculo = {
  pcaItemId: string;
  catalogoItemId: string;
  codigoPdm: string | null;
  score: number;
  tipo: "exata" | "provavel" | "incerta";
  evidencia: string;
};

type Stats = {
  vinculos_novos: number;
  vinculos_atualizados: number;
  pdm_vinculos: number;
  erros: number;
};

/** Tamanho dos blocos de leitura/escrita: mantém a URL do filtro `in` e o corpo do upsert pequenos. */
export const BLOCO_GRAVACAO = 100;

/**
 * Grava os vínculos do lote com 3 operações por bloco de BLOCO_GRAVACAO itens (leitura das pontes que já existem,
 * upsert da ponte, upsert do PDM), em vez de 3 por item. Mesmas linhas e mesmas contagens da versão item a item:
 * vínculo existente conta como atualizado; falha no upsert da ponte conta erro por item e não grava o PDM do bloco.
 */
export async function gravarVinculos(
  client: LinkClient,
  vinculos: Vinculo[],
  stats: Stats,
): Promise<void> {
  for (let i = 0; i < vinculos.length; i += BLOCO_GRAVACAO) {
    const bloco = vinculos.slice(i, i + BLOCO_GRAVACAO);
    const { data: existentes, error: lerErro } = await client
      .from("catalogo_ponte")
      .select("catalogo_item_id, entidade_id")
      .eq("entidade_tipo", "pca_item")
      .in("entidade_id", bloco.map((v) => v.pcaItemId));
    if (lerErro) {
      stats.erros += bloco.length;
      continue;
    }
    const jaExiste = new Set(
      (existentes ?? []).map((
        e: { catalogo_item_id: string; entidade_id: string },
      ) => `${e.catalogo_item_id}|${e.entidade_id}`),
    );

    const { error: ponteErro } = await client.from("catalogo_ponte").upsert(
      bloco.map((v) => ({
        catalogo_item_id: v.catalogoItemId,
        entidade_tipo: "pca_item",
        entidade_id: v.pcaItemId,
        tipo_correspondencia: v.tipo,
        evidencia: v.evidencia,
      })),
      { onConflict: "catalogo_item_id,entidade_tipo,entidade_id" },
    );
    if (ponteErro) {
      stats.erros += bloco.length;
      continue;
    }
    for (const v of bloco) {
      if (jaExiste.has(`${v.catalogoItemId}|${v.pcaItemId}`)) {
        stats.vinculos_atualizados++;
      } else stats.vinculos_novos++;
    }

    const agora = new Date().toISOString();
    const pdms = bloco.flatMap((v) => {
      const codigoPdm = v.codigoPdm ? Number(v.codigoPdm) : NaN;
      if (!Number.isFinite(codigoPdm)) return [];
      return [{
        pca_item_id: v.pcaItemId,
        codigo_pdm: codigoPdm,
        tipo_correspondencia: v.tipo,
        score: v.score,
        evidencia: `catalogo_ponte;${v.evidencia}`,
        confirmado: v.tipo === "exata",
        updated_at: agora,
      }];
    });
    if (pdms.length === 0) continue;
    const { error: pdmErro } = await client.from("pca_item_pdm").upsert(pdms, {
      onConflict: "pca_item_id,codigo_pdm",
    });
    if (pdmErro) stats.erros += pdms.length;
    else stats.pdm_vinculos += pdms.length;
  }
}

async function linkOneClass(
  client: LinkClient,
  classeCatmat: string,
  limite: number,
  offset: number,
  limiar: number,
) {
  const rangeEnd = offset + limite - 1;

  const { data: pcaItens, error: pcaError } = await client
    .from("pca_itens")
    .select(
      "id, descricao, classe_material_servico, codigo_classe_catmat, ativo",
    )
    .eq("ativo", true)
    .eq("classe_material_servico", classeCatmat)
    .order("id", { ascending: true })
    .range(offset, rangeEnd);
  if (pcaError) throw new Error(pcaError.message);

  // Pool de texto desta classe. Não é whitelist de pertencimento ao escopo.
  const { data: catalogoItens, error: catError } = await client
    .from("catalogo_itens")
    .select("id, codigo_catmat, codigo_pdm, descricao, classe_catmat, ativo")
    .eq("ativo", true)
    .eq("classe_catmat", classeCatmat);
  if (catError) throw new Error(catError.message);

  const catalogoIndex = (catalogoItens ?? []).map((item) => ({
    ...item,
    tokens: tokenSet(normalizeText(item.descricao)),
  }));

  const stats = {
    analisados: 0,
    vinculos_novos: 0,
    vinculos_atualizados: 0,
    pdm_vinculos: 0,
    ignorados: 0,
    erros: 0,
  };

  const vinculos: Vinculo[] = [];
  for (const pcaItem of pcaItens ?? []) {
    stats.analisados++;
    const pcaTokens = tokenSet(normalizeText(pcaItem.descricao));
    if (pcaTokens.size === 0) {
      stats.ignorados++;
      continue;
    }

    let best: { id: string; codigo_pdm: string | null; score: number } | null =
      null;
    for (const cat of catalogoIndex) {
      const score = jaccard(pcaTokens, cat.tokens);
      if (!best || score > best.score) {
        best = { id: cat.id, codigo_pdm: cat.codigo_pdm, score };
      }
    }

    if (!best || best.score < limiar) {
      stats.ignorados++;
      continue;
    }

    const tipo = best.score >= 0.85
      ? "exata"
      : best.score >= 0.7
      ? "provavel"
      : "incerta";
    vinculos.push({
      pcaItemId: pcaItem.id,
      catalogoItemId: best.id,
      codigoPdm: best.codigo_pdm,
      score: best.score,
      tipo,
      evidencia: `jaccard=${best.score.toFixed(3)};classe=${classeCatmat}`,
    });
  }

  // Gravação em lote (issue #245): antes eram 3 idas ao banco por item (~1.500 por chamada de 500), e as chamadas
  // paralelas do cron estouravam o limite de CPU do worker ("CPU Time exceeded", HTTP 546).
  await gravarVinculos(client, vinculos, stats);

  const batchSize = pcaItens?.length ?? 0;
  const proximoOffset = offset + batchSize;

  return {
    status: "concluida",
    classe_catmat: classeCatmat,
    limiar_similaridade: limiar,
    offset,
    limite,
    proximo_offset: proximoOffset,
    tem_mais: batchSize >= limite,
    ...stats,
  };
}

export function parseLinkCatmatPcaBody(
  parsedBody: unknown,
): { ok: true; body: LinkBody } | { ok: false; response: Response } {
  if (
    !parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)
  ) {
    return {
      ok: false,
      response: jsonResponse({ error: "Corpo JSON inválido" }, 400),
    };
  }

  const rawClasse = (parsedBody as Record<string, unknown>).classe_catmat;
  if (
    rawClasse !== undefined && rawClasse !== null &&
    typeof rawClasse !== "string"
  ) {
    return {
      ok: false,
      response: jsonResponse({ error: "classe_catmat deve ser texto" }, 400),
    };
  }

  return { ok: true, body: parsedBody as LinkBody };
}

export type LinkCatmatPcaDeps = {
  /** Injeta cliente em testes; produção usa createServiceClient. */
  createClient?: () => LinkClient;
};

export async function handleLinkCatmatPcaRequest(
  req: Request,
  deps: LinkCatmatPcaDeps = {},
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const parsed = parseLinkCatmatPcaBody(await req.json().catch(() => null));
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.body;
  const targets = linkTargetClasses(body);
  if (!targets.ok) {
    return jsonResponse({ status: "blocked", reason: targets.reason }, 423);
  }
  const limite = Math.min(Math.max(body.limite ?? 500, 1), 1000);
  const offset = Math.max(body.offset ?? 0, 0);
  const limiar = body.limiar_similaridade ?? 0.55;
  const client = (deps.createClient ?? createServiceClient)();

  const resultados = [];
  try {
    for (const classe of targets.classes) {
      resultados.push(
        await linkOneClass(client, classe, limite, offset, limiar),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
  if (resultados.length === 1) {
    return jsonResponse(resultados[0]);
  }
  return jsonResponse({
    status: "concluida",
    scope: "transitional_fitness_scope",
    classes: targets.classes,
    resultados,
  });
}

if (import.meta.main) {
  Deno.serve((req) => handleLinkCatmatPcaRequest(req));
}
