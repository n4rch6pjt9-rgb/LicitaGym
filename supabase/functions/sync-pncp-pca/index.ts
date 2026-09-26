import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  corsHeaders,
  errorDetail,
  jsonResponse,
  validateCronAuth,
} from "../_shared/http.ts";
import {
  clampConsultaPageSize,
  createRequestBudget,
  PncpConsultaClient,
} from "../_shared/pncp/consulta-client.ts";
import { BudgetExhaustedError } from "../_shared/pncp/retry.ts";
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
import { PncpSearchClient } from "../_shared/pncp/search-client.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
} from "../_shared/pncp/supabase-admin.ts";
import {
  normalizePcaItem,
  normalizePcaPlano,
} from "../_shared/pncp/normalize.ts";
import { linkPcaItemOrigemCodes } from "../_shared/pncp/pca-origem-link.ts";
import { inactivateNotSeen, upsertByHash } from "../_shared/pncp/upsert.ts";

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

async function syncClassificacao(params: {
  client: ReturnType<typeof createServiceClient>;
  consulta: PncpConsultaClient;
  runId: string;
  ano: number;
  codigoClassificacao: string;
  paginaInicial: number;
  maxPaginas: number;
  tamanhoPagina: number;
  onCheckpoint?: (nextPage: number) => void;
}): Promise<
  { stats: SyncStats; ultimaPagina: number; paginasRestantes: number }
> {
  const {
    client,
    consulta,
    runId,
    ano,
    codigoClassificacao,
    paginaInicial,
    maxPaginas,
    tamanhoPagina,
  } = params;

  const stats = emptyStats();
  let pagina = paginaInicial;
  let paginasRestantes = 1;

  while (paginasRestantes >= 0 && pagina < paginaInicial + maxPaginas) {
    const endpoint =
      `/pca/?anoPca=${ano}&codigoClassificacaoSuperior=${codigoClassificacao}&pagina=${pagina}`;
    const { status, body: responseBody, elapsedMs } = await consulta
      .fetchPcaPage(
        ano,
        pagina,
        codigoClassificacao,
        tamanhoPagina,
      );
    const respostaHash = await sha256Hex(JSON.stringify(responseBody));
    await logSyncRequest(client, {
      syncRunId: runId,
      endpoint,
      parametros: { ano, codigoClassificacao, pagina, tamanhoPagina },
      pagina,
      statusHttp: status,
      tempoRespostaMs: elapsedMs,
      respostaHash,
    });

    const requestHash = await hashPayload({
      ano,
      codigoClassificacao,
      pagina,
      tamanhoPagina,
    });
    await storeSourceRecord(client, {
      syncRunId: runId,
      resourceType: "pca",
      endpoint,
      requestHash,
      contentHash: respostaHash,
      payload: responseBody,
    });

    const list = consulta.extractList(responseBody);
    const pagination = consulta.extractPagination(responseBody, pagina);
    paginasRestantes = pagination.paginasRestantes;

    for (const raw of list) {
      const plan = raw as Record<string, unknown>;
      const planoRow = normalizePcaPlano(plan, ano);
      if (!planoRow.id_pca_pncp) continue;

      stats.recebidos++;
      const planoResult = await upsertByHash(
        client,
        "pca_planos",
        { id_pca_pncp: planoRow.id_pca_pncp },
        planoRow,
        {
          historyTable: "pca_alteracoes",
          historyFields: ({ rowId }) => ({ pca_plano_id: rowId }),
          syncRunId: runId,
          lastSeenSyncId: runId,
          reactivateOnUnchanged: true,
        },
      );
      if (planoResult === "novo") stats.novos++;
      else if (planoResult === "alterado") stats.alterados++;
      else if (planoResult === "inalterado") stats.inalterados++;
      else stats.erros++;

      const { data: planoRecord, error: planoLookupError } = await client
        .from("pca_planos")
        .select("id")
        .eq("id_pca_pncp", planoRow.id_pca_pncp)
        .maybeSingle();
      if (planoLookupError || !planoRecord) {
        if (planoLookupError) stats.erros++;
        continue;
      }

      const itens = Array.isArray(plan.itens) ? plan.itens : [];
      for (const rawItem of itens) {
        const itemRow = normalizePcaItem(
          rawItem as Record<string, unknown>,
          plan,
        );
        if (!itemRow.numero_item) continue;

        stats.recebidos++;
        const itemResult = await upsertByHash(
          client,
          "pca_itens",
          { pca_plano_id: planoRecord.id, numero_item: itemRow.numero_item },
          { ...itemRow, pca_plano_id: planoRecord.id },
          {
            historyTable: "pca_alteracoes",
            historyFields: ({ rowId }) => ({
              pca_plano_id: planoRecord.id,
              pca_item_id: rowId,
            }),
            syncRunId: runId,
            lastSeenSyncId: runId,
            reactivateOnUnchanged: true,
          },
        );
        if (itemResult === "novo") stats.novos++;
        else if (itemResult === "alterado") stats.alterados++;
        else if (itemResult === "inalterado") stats.inalterados++;
        else stats.erros++;

        if (itemRow.pdm_codigo_origem || itemRow.codigo_item_origem) {
          const { data: itemRecord, error: itemLookupError } = await client
            .from("pca_itens")
            .select("id")
            .eq("pca_plano_id", planoRecord.id)
            .eq("numero_item", itemRow.numero_item)
            .maybeSingle();
          if (itemLookupError) {
            stats.erros++;
          } else if (itemRecord) {
            await linkPcaItemOrigemCodes(client, itemRecord.id, itemRow);
          }
        }
      }
    }

    if (pagination.paginasRestantes <= 0) {
      params.onCheckpoint?.(pagina + 1);
      break;
    }
    pagina++;
    params.onCheckpoint?.(pagina);
  }

  return { stats, ultimaPagina: pagina, paginasRestantes };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as SyncBody;
  const ano = body.ano ?? new Date().getUTCFullYear();
  const codigosClassificacao = resolvePcaClassificacoes(body);
  const scopeErr = assertPcaClassificacoesInScope(codigosClassificacao);
  if (scopeErr) {
    return jsonResponse({ status: "blocked", reason: scopeErr }, 423);
  }
  const paginaInicial = body.pagina_inicial ?? 1;
  const maxPaginas = body.max_paginas ?? 100;
  const tamanhoPagina = clampConsultaPageSize("pca", body.tamanho_pagina);
  const verificarPeriodo = body.verificar_periodo ?? !body.forcar;
  const lockKey = body.somente_verificacao
    ? `pca-probe:${ano}`
    : `pca-sync:${ano}:${codigosClassificacao.slice().sort().join(",")}`;

  let client;
  try {
    client = createServiceClient();
  } catch (error) {
    return jsonResponse(
      {
        error: "Supabase service client indisponivel",
        detalhe: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  const requestBudget = createRequestBudget();
  const consulta = new PncpConsultaClient().withBudget(requestBudget);
  const search = new PncpSearchClient().withBudget(requestBudget);

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
      mensagem:
        "PNCP lento ou falhando no probe /v1/atas — carga não iniciada.",
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
    if (decisao.skip) {
      return jsonResponse({
        status: "ignorado",
        ano,
        motivo: decisao.reason,
        periodo: periodSummary,
        probe_segmentado: scopedProbes,
        search_indisponivel: searchProbeError,
        anchor: periodAnchor,
        mensagem:
          "Probe segmentado e Search inalterados desde a última carga. Use forcar:true para carga anual.",
      });
    }
  }

  const { runId, alreadyRunning } = await acquireSyncLock(
    client,
    lockKey,
    "pca",
    body,
  );

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const stats = emptyStats();
  const porCodigo: Record<
    string,
    SyncStats & { ultima_pagina: number; paginas_restantes: number }
  > = {};
  const paginaPendentePorCodigo: Record<string, number> = {};
  let currentCodigoIndex = 0;

  try {
    for (
      currentCodigoIndex = 0;
      currentCodigoIndex < codigosClassificacao.length;
      currentCodigoIndex++
    ) {
      const codigoClassificacao = codigosClassificacao[currentCodigoIndex];
      const result = await syncClassificacao({
        client,
        consulta,
        runId,
        ano,
        codigoClassificacao,
        paginaInicial,
        maxPaginas,
        tamanhoPagina,
        onCheckpoint: (nextPage) => {
          paginaPendentePorCodigo[codigoClassificacao] = nextPage;
        },
      });
      porCodigo[codigoClassificacao] = {
        ...result.stats,
        ultima_pagina: result.ultimaPagina,
        paginas_restantes: result.paginasRestantes,
      };
      mergeStats(stats, result.stats);
    }
    currentCodigoIndex = codigosClassificacao.length;

    if (
      body.modo === "completo" &&
      stats.erros === 0 &&
      Object.values(porCodigo).every((codigo) => codigo.paginas_restantes <= 0)
    ) {
      await inactivateNotSeen(client, "pca_planos", runId, {
        ano_exercicio: ano,
      });
      const { data: planosVistos } = await client
        .from("pca_planos")
        .select("id")
        .eq("last_seen_sync_id", runId);
      if (planosVistos?.length) {
        for (const plano of planosVistos) {
          await inactivateNotSeen(client, "pca_itens", runId, {
            pca_plano_id: plano.id,
          });
        }
      }
    }

    if (stats.erros === 0) {
      await markPeriodLoadComplete(client, periodSummary, probeMetadata, ano);
    }

    await finishSyncRun(client, runId, {
      status: stats.erros > 0 ? "concluida_com_erros" : "concluida",
      totalRecebidos: stats.recebidos,
      totalNovos: stats.novos,
      totalAtualizados: stats.alterados,
      totalInalterados: stats.inalterados,
      totalErros: stats.erros,
      paginaAtual: Math.max(
        ...Object.values(porCodigo).map((c) => c.ultima_pagina),
        0,
      ),
    });

    return jsonResponse({
      sync_id: runId,
      status: "concluida",
      ano,
      codigos_classificacao: codigosClassificacao,
      periodo: periodSummary,
      por_codigo: porCodigo,
      ...stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isBudget = error instanceof BudgetExhaustedError ||
      message.includes("BUDGET_EXHAUSTED");
    const pendingCodigos =
      isBudget && currentCodigoIndex < codigosClassificacao.length
        ? codigosClassificacao.slice(currentCodigoIndex)
        : [];
    const paginaPorCodigoPendente = Object.fromEntries(
      pendingCodigos.map((codigo, index) => [
        codigo,
        index === 0
          ? (paginaPendentePorCodigo[codigo] ?? paginaInicial)
          : paginaInicial,
      ]),
    );
    const continuation = pendingCodigos.length > 0
      ? {
        pending_codigos_classificacao: pendingCodigos,
        pagina_inicial: paginaPorCodigoPendente[pendingCodigos[0]] ??
          paginaInicial,
        pagina_por_codigo_pendente: paginaPorCodigoPendente,
        max_paginas: maxPaginas,
        tamanho_pagina: tamanhoPagina,
      }
      : undefined;
    const runStatus = isBudget ? "incompleta" : "falhou";
    await finishSyncRun(client, runId, {
      status: runStatus,
      erroPrincipal: message,
      totalRecebidos: stats.recebidos,
      totalNovos: stats.novos,
      totalAtualizados: stats.alterados,
      totalInalterados: stats.inalterados,
      totalErros: stats.erros,
      paginaAtual: Math.max(
        ...Object.values(porCodigo).map((c) => c.ultima_pagina),
        0,
      ),
      parametros: continuation
        ? {
          ...body,
          codigos_classificacao: pendingCodigos,
          pagina_inicial: paginaPorCodigoPendente[pendingCodigos[0]] ??
            paginaInicial,
          continuation,
        }
        : undefined,
    });
    return jsonResponse({
      error: message,
      sync_id: runId,
      status: isBudget ? "BUDGET_EXHAUSTED" : "falhou",
      run_status: runStatus,
      continuation,
    }, isBudget ? 503 : 500);
  }
});
