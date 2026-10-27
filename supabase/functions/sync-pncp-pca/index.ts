import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, errorDetail, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import { clampConsultaPageSize, createRequestBudget, PncpConsultaClient } from "../_shared/pncp/consulta-client.ts";
import { BudgetExhaustedError } from "../_shared/pncp/retry.ts";
import { RateLimitPauseError, UnifiedHttpClient } from "../_shared/http-client/index.ts";
import { resolvePcaClassificacoes } from "../_shared/pncp/licitagym-catmat.ts";
import { assertPcaClassificacoesInScope } from "../_shared/pncp/licitagym-scope-gate.ts";
import {
  buildTotalRegistrosClasseMap,
  getPeriodAnchor,
  markPeriodLoadComplete,
  type PcaScopedProbe,
  shouldSkipAnnualLoad,
  upsertPeriodProbe,
} from "../_shared/pncp/period-anchor.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { type PcaSearchPeriodSummary, PncpSearchClient } from "../_shared/pncp/search-client.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
  updateSyncHeartbeat,
} from "../_shared/pncp/supabase-admin.ts";
import { gravarPaginaPcaEmLote } from "../_shared/pncp/pca-lote.ts";
import { PncpIntegracaoClient } from "../_shared/pncp/integracao-client.ts";
import { handleRotinaFila, type RotinaBody } from "./rotina-fila.ts";

type SyncBody = {
  ano?: number;
  /** Um código CATMAT/CATSER (legado). */
  codigo_classificacao_superior?: string;
  /** Subconjunto explícito. Vazio: default PCA = só 7830 (7220 só se passar no body/env). */
  codigos_classificacao?: string[];
  pagina_inicial?: number;
  /** Limita páginas por código (útil em cron parcial ou smoke test). */
  max_paginas?: number;
  tamanho_pagina?: number;
  modo?: "incremental" | "completo";
  /** Só consulta Search API (pcaorgao) e persiste lastro de período — sem GET /v1/pca/. */
  somente_verificacao?: boolean;
  /** Compara data_atualizacao_pncp do índice com última carga; pula sync pesado se inalterado. */
  verificar_periodo?: boolean;
  /** Ignora verificação de período (carga anual forçada). */
  forcar?: boolean;
  async?: boolean;
};

type ConsultaLegada = Pick<
  PncpConsultaClient,
  "fetchPcaPage" | "extractList" | "extractPagination" | "probePncpHealth" | "probePcaClassificacao"
>;
type DependenciasSyncPca = {
  createServiceClient?: typeof createServiceClient;
  consulta?: ConsultaLegada;
  search?: Pick<PncpSearchClient, "summarizePcaPeriod">;
};

type SyncStats = {
  novos: number;
  alterados: number;
  inalterados: number;
  erros: number;
  recebidos: number;
};

function emptyStats(): SyncStats {
  return { novos: 0, alterados: 0, inalterados: 0, erros: 0, recebidos: 0 };
}

function mergeStats(into: SyncStats, from: SyncStats) {
  into.novos += from.novos;
  into.alterados += from.alterados;
  into.inalterados += from.inalterados;
  into.erros += from.erros;
  into.recebidos += from.recebidos;
}

type ContinuacaoLegada = {
  formato: "pca-legado-v1";
  pending: string[];
  pending_codigos_classificacao: string[];
  classes: string[];
  pagina_por_codigo_pendente: Record<string, number>;
  pagina_inicial: number;
  tamanho_pagina: number;
  chain_id: string;
  inicio_completo: boolean;
  periodo: PcaSearchPeriodSummary | null;
  probe_metadata: Record<string, unknown>;
};

function restaurarLegado(value: unknown, classes: string[]): Partial<ContinuacaoLegada> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("continuação PCA inválida");
  const c = value as Record<string, unknown>;
  if (
    c.formato === "pca-legado-v1" && (!Array.isArray(c.classes) ||
      typeof c.inicio_completo !== "boolean" || typeof c.chain_id !== "string" || !("periodo" in c) ||
      !c.probe_metadata || typeof c.probe_metadata !== "object" || Array.isArray(c.probe_metadata))
  ) {
    throw new Error("continuação PCA sem contexto da cadeia");
  }
  if (c.formato !== undefined && c.formato !== "pca-legado-v1") {
    throw new Error("formato de continuação PCA incompatível");
  }
  const pending = c.pending_codigos_classificacao ?? c.pending;
  if (
    !Array.isArray(pending) || pending.some((x) => typeof x !== "string" || !classes.includes(x)) ||
    new Set(pending).size !== pending.length
  ) throw new Error("classes pendentes da continuação PCA inválidas");
  if (
    c.classes !== undefined && (!Array.isArray(c.classes) ||
      [...c.classes].sort().join(",") !== [...classes].sort().join(","))
  ) throw new Error("escopo da continuação PCA incompatível");
  const fallback = c.pagina_inicial ?? 1;
  if (!Number.isSafeInteger(fallback) || Number(fallback) < 1) throw new Error("página da continuação PCA inválida");
  const map = c.pagina_por_codigo_pendente;
  if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map))) {
    throw new Error("mapa da continuação PCA inválido");
  }
  const paginas: Record<string, number> = {};
  for (const codigo of pending as string[]) {
    const pagina = (map as Record<string, unknown> | undefined)?.[codigo] ?? fallback;
    if (!Number.isSafeInteger(pagina) || Number(pagina) < 1) throw new Error("página da continuação PCA inválida");
    paginas[codigo] = Number(pagina);
  }
  if (
    c.tamanho_pagina !== undefined &&
    (!Number.isSafeInteger(c.tamanho_pagina) || Number(c.tamanho_pagina) < 1 || Number(c.tamanho_pagina) > 500)
  ) {
    throw new Error("tamanho de página da continuação PCA inválido");
  }
  return {
    pending: pending as string[],
    pagina_por_codigo_pendente: paginas,
    tamanho_pagina: c.tamanho_pagina as number | undefined,
    inicio_completo: c.formato === "pca-legado-v1" && c.inicio_completo === true,
    chain_id: typeof c.chain_id === "string" ? c.chain_id : undefined,
    periodo: c.formato === "pca-legado-v1" ? c.periodo as PcaSearchPeriodSummary | null : null,
    probe_metadata: c.probe_metadata && typeof c.probe_metadata === "object" && !Array.isArray(c.probe_metadata)
      ? c.probe_metadata as Record<string, unknown>
      : undefined,
  };
}

async function syncClassificacao(params: {
  client: ReturnType<typeof createServiceClient>;
  consulta: ConsultaLegada;
  runId: string;
  ano: number;
  codigoClassificacao: string;
  paginaInicial: number;
  maxPaginas: number;
  tamanhoPagina: number;
  onCheckpoint: (nextPage: number | null) => Promise<void>;
  onStats: (stats: SyncStats) => void;
}): Promise<{ stats: SyncStats; ultimaPagina: number; paginasRestantes: number }> {
  const { client, consulta, runId, ano, codigoClassificacao, paginaInicial, maxPaginas, tamanhoPagina } = params;
  const stats = emptyStats();
  let pagina = paginaInicial;
  let ultimaPagina = paginaInicial - 1;
  let paginasRestantes = 1;
  for (let lidas = 0; lidas < maxPaginas; lidas++, pagina++) {
    const endpoint = `/pca/?anoPca=${ano}&codigoClassificacaoSuperior=${codigoClassificacao}&pagina=${pagina}`;
    const { status, body, elapsedMs } = await consulta.fetchPcaPage(ano, pagina, codigoClassificacao, tamanhoPagina);
    const respostaHash = await sha256Hex(JSON.stringify(body));
    await logSyncRequest(client, {
      syncRunId: runId,
      endpoint,
      parametros: { ano, codigoClassificacao, pagina, tamanhoPagina },
      pagina,
      statusHttp: status,
      tempoRespostaMs: elapsedMs,
      respostaHash,
    });
    await storeSourceRecord(client, {
      syncRunId: runId,
      resourceType: "pca",
      endpoint,
      requestHash: await hashPayload({ ano, codigoClassificacao, pagina, tamanhoPagina }),
      contentHash: respostaHash,
      payload: body,
    });
    ultimaPagina = pagina;
    if (status === 204) {
      await params.onCheckpoint(null);
      return { stats, ultimaPagina, paginasRestantes: 0 };
    }
    const obj = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (
      status !== 200 || !obj || !Array.isArray(obj.data) ||
      (obj.numeroPagina ?? obj.pagina) !== pagina ||
      !Number.isSafeInteger(obj.paginasRestantes) || Number(obj.paginasRestantes) < 0 ||
      !Number.isSafeInteger(obj.totalRegistros) || Number(obj.totalRegistros) < 0 ||
      (obj.data.length === 0 && Number(obj.totalRegistros) > 0)
    ) {
      throw new Error(`consulta PCA classe ${codigoClassificacao} página ${pagina}: resposta ou paginação inválida`);
    }
    paginasRestantes = Number(obj.paginasRestantes);
    const pageStats = await gravarPaginaPcaEmLote(client, obj.data as Record<string, unknown>[], { ano, runId });
    mergeStats(stats, pageStats);
    params.onStats(pageStats);
    if (pageStats.erros > 0) {
      // Repetir a página é idempotente. Não pular itens que falharam na gravação.
      await params.onCheckpoint(pagina);
      return { stats, ultimaPagina, paginasRestantes: Math.max(1, paginasRestantes) };
    }
    await params.onCheckpoint(paginasRestantes === 0 ? null : pagina + 1);
    if (paginasRestantes === 0) break;
  }
  return { stats, ultimaPagina, paginasRestantes };
}

export async function handleRequest(req: Request, deps: DependenciasSyncPca = {}): Promise<Response> {
  const criarClient = deps.createServiceClient ?? createServiceClient;
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const raw: unknown = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return jsonResponse({ error: "JSON deve ser um objeto" }, 400);
  }
  const body = raw as SyncBody;
  const isAsync = url.searchParams.get("async") === "1" || body.async === true;
  const ano = body.ano ?? new Date().getUTCFullYear();
  const codigosClassificacao = resolvePcaClassificacoes(body);
  const scopeErr = assertPcaClassificacoesInScope(codigosClassificacao);
  if (scopeErr) {
    return jsonResponse({ status: "blocked", reason: scopeErr }, 423);
  }
  if ((body as RotinaBody).rotina === undefined && body.modo === "completo" && !body.somente_verificacao) {
    return jsonResponse({
      error: "modo completo legado desativado; use rotina: reconciliacao para inativação por plano",
    }, 400);
  }
  const paginaInicial = body.pagina_inicial ?? 1;
  const maxPaginas = body.max_paginas ?? 100;
  if (
    (body as RotinaBody).rotina === undefined &&
    (!Number.isSafeInteger(paginaInicial) || paginaInicial < 1 || !Number.isSafeInteger(maxPaginas) || maxPaginas < 1)
  ) {
    return jsonResponse({ error: "pagina_inicial e max_paginas devem ser inteiros positivos" }, 400);
  }
  const tamanhoPagina = clampConsultaPageSize("pca", body.tamanho_pagina);
  const verificarPeriodo = body.verificar_periodo ?? !body.forcar;
  // Disparos forçados também retomam; a chave não mistura o formato legado com a fila.
  const lockKey = body.somente_verificacao
    ? `pca-probe:${ano}`
    : `pca-sync:${ano}:${codigosClassificacao.slice().sort().join(",")}`;

  let client: ReturnType<typeof createServiceClient>;
  try {
    client = criarClient();
  } catch (error) {
    return jsonResponse(
      {
        error: "Supabase service client indisponivel",
        detalhe: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  const httpClient = new UnifiedHttpClient({
    supabaseClient: client,
    telemetryLogger: (t) => logSyncRequest(client, t),
  });
  const requestBudget = createRequestBudget();
  const consulta = deps.consulta ?? new PncpConsultaClient(undefined, {}, httpClient).withBudget(requestBudget);
  const search = deps.search ?? new PncpSearchClient(undefined, httpClient).withBudget(requestBudget);

  // Spec 0012, PR 2: sync por fila de planos (descoberta pela consulta, itens pela integração por plano).
  // Sem `rotina`, segue o fluxo antigo abaixo; os crons novos nascem desligados.
  if ((body as RotinaBody).rotina !== undefined) {
    return await handleRotinaFila({
      client,
      clientDaReserva: (token, runId) => criarClient({ "x-pca-reserva": token, "x-pca-run-id": runId }),
      consulta,
      integracao: new PncpIntegracaoClient(undefined, httpClient),
      body: body as RotinaBody,
      ano,
      classes: codigosClassificacao,
      tamanhoPagina,
      isAsync,
    });
  }

  // Smoke / period check: probes sequenciais para consumo previsível do budget compartilhado.
  if (body.somente_verificacao) {
    const probesPendentes: string[] = [];
    const scopedProbes: PcaScopedProbe[] = [];
    let searchProbeError: string | null = null;
    let periodSummary = null;

    for (let i = 0; i < codigosClassificacao.length; i++) {
      const codigo = codigosClassificacao[i];
      try {
        const probe = await consulta.probePcaClassificacao(ano, codigo);
        if (probe.status >= 400) throw new Error(`HTTP ${probe.status}`);
        scopedProbes.push({
          codigo_classificacao: codigo,
          total_registros: probe.total_registros,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        probesPendentes.push(codigo);
        if (
          reason.includes("BUDGET_EXHAUSTED") ||
          error instanceof BudgetExhaustedError
        ) {
          // leave remaining codes as pending too
          for (let j = i + 1; j < codigosClassificacao.length; j++) {
            if (!probesPendentes.includes(codigosClassificacao[j])) {
              probesPendentes.push(codigosClassificacao[j]);
            }
          }
          break;
        }
      }
    }

    try {
      periodSummary = await search.summarizePcaPeriod(ano);
    } catch (error) {
      // Any Search failure → incomplete verification (never upsert null lastro).
      searchProbeError = error instanceof Error ? error.message : String(error);
      if (!probesPendentes.includes("search:pcaorgao")) {
        probesPendentes.push("search:pcaorgao");
      }
    }

    if (probesPendentes.length > 0) {
      return jsonResponse({
        status: "verificacao_incompleta",
        ano,
        probes_ok: scopedProbes,
        probes_pendentes: probesPendentes,
        search_indisponivel: searchProbeError,
        periodo: periodSummary,
      }, 200);
    }

    const probeMetadata = {
      origem: "sync-pncp-pca",
      total_registros_classe: buildTotalRegistrosClasseMap(scopedProbes),
      ...(searchProbeError ? { search_indisponivel: searchProbeError } : {}),
    };

    let periodAnchor;
    try {
      periodAnchor = await getPeriodAnchor(client, ano);
      await upsertPeriodProbe(client, periodSummary, probeMetadata, ano);
    } catch (error) {
      return jsonResponse(
        {
          error: "Falha ao ler/gravar lastro em private.pncp_period_anchor",
          detalhe: errorDetail(error),
        },
        500,
      );
    }

    const decisao = shouldSkipAnnualLoad(
      periodAnchor,
      periodSummary,
      scopedProbes,
    );
    return jsonResponse({
      status: "verificacao",
      ano,
      periodo: periodSummary,
      probe_segmentado: scopedProbes,
      search_indisponivel: searchProbeError,
      anchor: periodAnchor,
      carga_necessaria: !decisao.skip,
      motivo: decisao.reason,
    });
  }

  // Heavy load path: health-check first.
  let health;
  try {
    health = await consulta.probePncpHealth();
  } catch (error) {
    if (
      error instanceof BudgetExhaustedError ||
      (error instanceof Error && error.message.includes("BUDGET_EXHAUSTED"))
    ) {
      return jsonResponse({
        status: "BUDGET_EXHAUSTED",
        error: "BUDGET_EXHAUSTED",
      }, 503);
    }
    throw error;
  }
  if (health.status === "PNCP_DEGRADADO") {
    return jsonResponse({
      status: "PNCP_DEGRADADO",
      detalhe: health.detalhe,
      elapsed_ms: health.elapsedMs,
      mensagem: "PNCP lento ou falhando no probe /v1/atas — carga não iniciada.",
    }, 503);
  }

  const scopedProbes: PcaScopedProbe[] = [];
  let scopedProbeError: string | null = null;

  for (const codigo of codigosClassificacao) {
    try {
      const probe = await consulta.probePcaClassificacao(ano, codigo);
      if (probe.status >= 400) {
        throw new Error(`HTTP ${probe.status}`);
      }
      scopedProbes.push({
        codigo_classificacao: codigo,
        total_registros: probe.total_registros,
      });
    } catch (error) {
      if (
        error instanceof BudgetExhaustedError ||
        (error instanceof Error && error.message.includes("BUDGET_EXHAUSTED"))
      ) {
        return jsonResponse({
          status: "BUDGET_EXHAUSTED",
          error: "BUDGET_EXHAUSTED",
          codigos_classificacao: codigosClassificacao,
        }, 503);
      }
      scopedProbeError = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  if (scopedProbeError) {
    return jsonResponse(
      {
        error: "Falha no probe segmentado (Consulta /v1/pca/)",
        detalhe: scopedProbeError,
        codigos_classificacao: codigosClassificacao,
      },
      503,
    );
  }

  let periodSummary = null;
  let searchProbeError: string | null = null;
  try {
    periodSummary = await search.summarizePcaPeriod(ano);
  } catch (error) {
    if (
      error instanceof BudgetExhaustedError ||
      (error instanceof Error && error.message.includes("BUDGET_EXHAUSTED"))
    ) {
      return jsonResponse({
        status: "BUDGET_EXHAUSTED",
        error: "BUDGET_EXHAUSTED",
      }, 503);
    }
    searchProbeError = error instanceof Error ? error.message : String(error);
  }

  const probeMetadata = {
    origem: "sync-pncp-pca",
    total_registros_classe: buildTotalRegistrosClasseMap(scopedProbes),
    ...(searchProbeError ? { search_indisponivel: searchProbeError } : {}),
  };

  let periodAnchor;
  try {
    periodAnchor = await getPeriodAnchor(client, ano);
    await upsertPeriodProbe(client, periodSummary, probeMetadata, ano);
  } catch (error) {
    return jsonResponse(
      {
        error: "Falha ao ler/gravar lastro em private.pncp_period_anchor",
        detalhe: errorDetail(error),
        dica:
          "Dashboard → API → Exposed schemas → private; depois NOTIFY pgrst reload schema. Confira se a tabela existe (migration 013).",
      },
      500,
    );
  }

  if (verificarPeriodo && !body.forcar) {
    const decisao = shouldSkipAnnualLoad(
      periodAnchor,
      periodSummary,
      scopedProbes,
    );
    const { data: pendente, error: ePendente } = await client.schema("private").from("pncp_sync_run")
      .select("id").eq("lock_key", lockKey).in("status", ["incompleta", "executando"]).limit(1).maybeSingle();
    if (ePendente) return jsonResponse({ error: "Falha ao conferir retomada PCA" }, 500);
    if (decisao.skip && !pendente) {
      return jsonResponse({
        status: "ignorado",
        ano,
        motivo: decisao.reason,
        periodo: periodSummary,
        probe_segmentado: scopedProbes,
        search_indisponivel: searchProbeError,
        anchor: periodAnchor,
        mensagem: "Probe segmentado e Search inalterados desde a última carga. Use forcar:true para carga anual.",
      });
    }
  }

  const { runId, alreadyRunning, continuation: inheritedContinuation } = await acquireSyncLock(
    client,
    lockKey,
    "pca",
    body,
  );

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  client = criarClient({ "x-pca-run-id": runId });

  const executeSync = async (): Promise<Response> => {
    const stats = emptyStats();
    const porCodigo: Record<string, SyncStats & { ultima_pagina: number; paginas_restantes: number }> = {};
    let paginas: Record<string, number> = Object.fromEntries(codigosClassificacao.map((c) => [c, paginaInicial]));
    let inicioCompleto = paginaInicial === 1;
    let chainId = runId;
    let tamanhoEfetivo = tamanhoPagina;
    let periodoDaCadeia = periodSummary;
    let probeDaCadeia: Record<string, unknown> = probeMetadata;
    const salvar = (): ContinuacaoLegada => {
      const pending = codigosClassificacao.filter((c) => paginas[c] !== undefined);
      return {
        formato: "pca-legado-v1",
        pending,
        pending_codigos_classificacao: pending,
        classes: codigosClassificacao,
        pagina_por_codigo_pendente: { ...paginas },
        pagina_inicial: pending.length ? paginas[pending[0]] : 1,
        tamanho_pagina: tamanhoEfetivo,
        chain_id: chainId,
        inicio_completo: inicioCompleto,
        periodo: periodoDaCadeia,
        probe_metadata: probeDaCadeia,
      };
    };
    const checkpoint = async () => {
      const c = salvar();
      const error = await updateSyncHeartbeat(client, runId, {
        paginaAtual: c.pagina_inicial,
        continuation: c,
        baseParametros: { ...body, ano, codigos_classificacao: codigosClassificacao },
      });
      if (error) throw new Error(`checkpoint PCA não persistido: ${error.message}`);
    };

    try {
      const herdada = restaurarLegado(inheritedContinuation, codigosClassificacao);
      if (herdada?.pending?.length) {
        paginas = herdada.pagina_por_codigo_pendente ?? {};
        inicioCompleto = herdada.inicio_completo === true;
        chainId = herdada.chain_id ?? runId;
        tamanhoEfetivo = herdada.tamanho_pagina ?? tamanhoPagina;
        periodoDaCadeia = herdada.periodo ?? null;
        probeDaCadeia = herdada.probe_metadata ?? {};
      }
      if (body.forcar || body.pagina_inicial || (body.ano && body.ano !== new Date().getUTCFullYear())) {
        const { error } = await client.schema("private").from("pncp_sync_run")
          .update({ modo: "manual" }).eq("id", runId).eq("status", "executando");
        if (error) throw error;
      }
      // Persistir antes do primeiro HTTP torna uma morte precoce recuperável pela RPC de lock.
      await checkpoint();
      for (const codigoClassificacao of codigosClassificacao) {
        if (paginas[codigoClassificacao] === undefined) continue;
        const result = await syncClassificacao({
          client,
          consulta,
          runId,
          ano,
          codigoClassificacao,
          paginaInicial: paginas[codigoClassificacao],
          maxPaginas,
          tamanhoPagina: tamanhoEfetivo,
          onStats: (parcial) => mergeStats(stats, parcial),
          onCheckpoint: async (nextPage) => {
            if (nextPage === null) delete paginas[codigoClassificacao];
            else paginas[codigoClassificacao] = nextPage;
            await checkpoint();
          },
        });
        porCodigo[codigoClassificacao] = {
          ...result.stats,
          ultima_pagina: result.ultimaPagina,
          paginas_restantes: result.paginasRestantes,
        };
      }
      const continuation = salvar();
      const status = continuation.pending.length > 0
        ? "incompleta"
        : stats.erros > 0
        ? "concluida_com_erros"
        : "concluida";
      const cargaAnualCompleta = status === "concluida" && inicioCompleto;
      if (cargaAnualCompleta) {
        await markPeriodLoadComplete(client, periodoDaCadeia, { ...probeDaCadeia, chain_id: chainId }, ano);
      }
      await finishSyncRun(client, runId, {
        status,
        totalRecebidos: stats.recebidos,
        totalNovos: stats.novos,
        totalAtualizados: stats.alterados,
        totalInalterados: stats.inalterados,
        totalErros: stats.erros,
        paginaAtual: Math.max(...Object.values(porCodigo).map((c) => c.ultima_pagina), 0),
        parametros: {
          ...body,
          ano,
          codigos_classificacao: codigosClassificacao,
          carga_anual_completa: cargaAnualCompleta,
          continuation,
        },
      });
      return jsonResponse({
        sync_id: runId,
        status,
        ano,
        codigos_classificacao: codigosClassificacao,
        periodo: periodoDaCadeia,
        por_codigo: porCodigo,
        carga_anual_completa: cargaAnualCompleta,
        continuation,
        ...stats,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isBudget = error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError ||
        message.includes("BUDGET_EXHAUSTED");
      const continuation = salvar();
      const runStatus = isBudget && continuation.pending.length > 0 ? "incompleta" : "falhou";
      await finishSyncRun(client, runId, {
        status: runStatus,
        erroPrincipal: message,
        totalRecebidos: stats.recebidos,
        totalNovos: stats.novos,
        totalAtualizados: stats.alterados,
        totalInalterados: stats.inalterados,
        totalErros: stats.erros,
        paginaAtual: continuation.pagina_inicial,
        parametros: { ...body, ano, codigos_classificacao: codigosClassificacao, continuation },
      });
      return jsonResponse({
        error: message,
        sync_id: runId,
        status: isBudget ? "BUDGET_EXHAUSTED" : "falhou",
        run_status: runStatus,
        continuation,
      }, isBudget ? 503 : 500);
    }
  };

  if (isAsync) {
    const edgeRuntime =
      (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === "function") {
      edgeRuntime.waitUntil(executeSync());
    } else {
      return await executeSync();
    }
    return jsonResponse({ status: "accepted", sync_id: runId }, 202);
  }

  return await executeSync();
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
