import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ComprasGovMaterialClient } from "../_shared/compras-gov/material-client.ts";
import { upsertCatalogoItemFromCompras } from "../_shared/compras-gov/catalogo-upsert.ts";
import {
  normalizeCaracteristica,
  normalizeCatalogoItemFromMaterial,
  normalizeClasseMaterial,
  normalizeGrupoMaterial,
  normalizeNaturezaDespesa,
  normalizePdmMaterial,
  normalizeUnidadeFornecimento,
} from "../_shared/compras-gov/material-normalize.ts";
import type {
  CaracteristicaMaterial,
  ClasseMaterial,
  GrupoMaterial,
  ItemMaterial,
  NaturezaDespesaMaterial,
  PdmMaterial,
  UnidadeFornecimentoMaterial,
} from "../_shared/compras-gov/material-types.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import { resolveCatmatIngestTargets } from "../_shared/pncp/catmat-scope-resolver.ts";
import {
  bloqueioModoCatalogo,
  CATMAT_SYNC_LOCK_CATALOGO,
  CATMAT_TAMANHO_PAGINA,
  continuationCatalogo,
  decidirInicioCatalogo,
  deveSincronizarCatalogo,
  fatiaPdms,
  linhaCatmatItemPdm,
  normalizarPdmsEfetivos,
  paramsItemDoPdm,
  resolverIncluirInativos,
} from "../_shared/pncp/catmat-catalogo-sync.ts";
import { assertCatmatClasseInScope } from "../_shared/pncp/licitagym-scope-gate.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
  updateSyncHeartbeat,
} from "../_shared/pncp/supabase-admin.ts";
import { BudgetExhaustedError } from "../_shared/pncp/retry.ts";
import { RateLimitPauseError, UnifiedHttpClient } from "../_shared/http-client/index.ts";
import { upsertByNaturalKey } from "../_shared/compras-gov/upsert-natural.ts";
import { upsertByHash, type UpsertResult } from "../_shared/pncp/upsert.ts";

type SyncBody = {
  codigo_grupo?: number;
  codigo_classe?: number;
  /** "catalogo" segue catalogo_catmat_pdms_efetivos(); "classe" força a lista fixa. */
  modo?: "catalogo" | "classe";
  /** Retomada estável: PDMs efetivos ordenados por codigo_pdm. */
  offset_pdm?: number;
  limite_pdm?: number;
  /** Não inicia carga nova; só continua um run incompleto do modo catálogo. */
  somente_retomada?: boolean;
  incluir_inativos?: boolean;
  max_paginas?: number;
  /** Processa características a partir deste offset (codigo_catmat ordenado). */
  offset_caracteristicas?: number;
  /** Máximo de itens para endpoint 7 por execução (evita timeout Edge). */
  limite_caracteristicas?: number;
  /** Pula endpoints 1-6; só características. */
  somente_caracteristicas?: boolean;
  /** Inclui endpoint 7 na mesma execução (padrão: false — use script em lotes). */
  incluir_caracteristicas?: boolean;
  async?: boolean;
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

function tally(into: SyncStats, result: UpsertResult) {
  into.recebidos++;
  if (result === "novo") into.novos++;
  else if (result === "alterado") into.alterados++;
  else if (result === "inalterado") into.inalterados++;
  else into.erros++;
}

async function logAndStore(
  client: ReturnType<typeof createServiceClient>,
  runId: string,
  endpoint: string,
  parametros: Record<string, unknown>,
  payload: unknown,
  statusHttp: number,
  elapsedMs: number,
) {
  const respostaHash = await sha256Hex(JSON.stringify(payload));
  await logSyncRequest(client, {
    syncRunId: runId,
    endpoint,
    parametros,
    statusHttp,
    tempoRespostaMs: elapsedMs,
    respostaHash,
  });
  const requestHash = await hashPayload({ endpoint, ...parametros });
  await storeSourceRecord(client, {
    syncRunId: runId,
    resourceType: "compras_catmat",
    endpoint,
    requestHash,
    contentHash: respostaHash,
    payload,
  });
}

async function ingestCatalogoCatmat(body: SyncBody): Promise<Response> {
  const incluirInativos = resolverIncluirInativos(body);
  const maxPaginas = body.max_paginas ?? 500;
  const client = createServiceClient();
  const httpClient = new UnifiedHttpClient({
    supabaseClient: client,
    telemetryLogger: (t) => logSyncRequest(client, t),
  });
  const material = new ComprasGovMaterialClient(httpClient);
  const { data: rpcRows, error: rpcError } = await client.rpc("catalogo_catmat_pdms_efetivos");
  if (rpcError) {
    console.error("[sync-compras-catmat] catalogo_catmat_pdms_efetivos", rpcError.message);
    return jsonResponse({ status: "falhou", reason: "Falha ao ler os PDMs efetivos do catálogo" }, 500);
  }
  const pdms = normalizarPdmsEfetivos(rpcRows);
  const { runId, alreadyRunning, continuation: inheritedContinuation } = await acquireSyncLock(
    client,
    CATMAT_SYNC_LOCK_CATALOGO,
    "compras_catmat",
    { modo: "catalogo", incluir_inativos: incluirInativos, ...body },
  );
  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId, scope: "catalogo_catmat_pdms_efetivos" });
  }

  const inicio = decidirInicioCatalogo({
    bodyOffset: body.offset_pdm,
    inheritedContinuation,
    somenteRetomada: body.somente_retomada === true,
  });
  if (inicio.pular) {
    await finishSyncRun(client, runId, {
      status: "concluida",
      totalRecebidos: 0,
      totalNovos: 0,
      totalAtualizados: 0,
      totalInalterados: 0,
      totalErros: 0,
    });
    return jsonResponse({
      sync_id: runId,
      status: "ignorado",
      motivo: "sem retomada pendente do catálogo",
      scope: "catalogo_catmat_pdms_efetivos",
    });
  }

  const { fatia, proximo } = fatiaPdms(pdms, inicio.offset, body.limite_pdm);
  const stats = emptyStats();
  let indice = 0;

  try {
    for (const pdm of fatia) {
      await updateSyncHeartbeat(client, runId, {
        paginaAtual: inicio.offset + indice + 1,
        continuation: continuationCatalogo(inicio.offset + indice),
        baseParametros: body,
      });
      const consulta = paramsItemDoPdm(pdm, incluirInativos);
      const { pages: itemPages, items: itens } = await material.fetchItens(consulta, {
        maxPaginas,
        tamanhoPagina: CATMAT_TAMANHO_PAGINA,
      });
      for (const page of itemPages) {
        await logAndStore(
          client,
          runId,
          "/modulo-material/4_consultarItemMaterial",
          { ...consulta, tamanhoPagina: CATMAT_TAMANHO_PAGINA },
          page,
          200,
          0,
        );
      }

      const linhasPdm = [];
      for (const raw of itens) {
        const item = raw as ItemMaterial;
        const row = normalizeCatalogoItemFromMaterial(item, {
          grupo: String(pdm.codigo_grupo),
          classe: String(pdm.codigo_classe),
        });
        const result = await upsertCatalogoItemFromCompras(client, row, { syncRunId: runId });
        tally(stats, result);
        const linha = linhaCatmatItemPdm(item);
        if (!linha) {
          stats.erros++;
          continue;
        }
        linhasPdm.push(linha);
      }
      if (linhasPdm.length > 0) {
        const { error: itemPdmError } = await client.from("catmat_item_pdm").upsert(linhasPdm, {
          onConflict: "codigo_item",
        });
        if (itemPdmError) throw itemPdmError;
      }

      const { items: naturezas } = await material.fetchNaturezasDespesa(pdm.codigo_pdm, {
        maxPaginas: 20,
        tamanhoPagina: CATMAT_TAMANHO_PAGINA,
      });
      for (const raw of naturezas) {
        const row = normalizeNaturezaDespesa(raw as NaturezaDespesaMaterial);
        if (!row) continue;
        const result = await upsertByHash(
          client,
          "catmat_pdm_naturezas_despesa",
          {
            codigo_pdm: row.codigo_pdm,
            codigo_natureza_despesa: row.codigo_natureza_despesa,
          },
          row,
          { syncRunId: runId },
        );
        tally(stats, result);
      }

      const { items: unidades } = await material.fetchUnidadesFornecimento(pdm.codigo_pdm, {
        maxPaginas: 20,
        tamanhoPagina: CATMAT_TAMANHO_PAGINA,
      });
      for (const raw of unidades) {
        const row = normalizeUnidadeFornecimento(raw as UnidadeFornecimentoMaterial);
        if (!row) continue;
        const result = await upsertByHash(
          client,
          "catmat_pdm_unidades",
          {
            codigo_pdm: row.codigo_pdm,
            sigla_unidade_fornecimento: row.sigla_unidade_fornecimento,
            numero_sequencial: row.numero_sequencial,
          },
          row,
          { syncRunId: runId },
        );
        tally(stats, result);
      }
      indice++;
    }

    const incompletaPorLimite = proximo != null && stats.erros === 0;
    const terminalStatus = stats.erros > 0
      ? "concluida_com_erros"
      : (incompletaPorLimite ? "incompleta" : "concluida");
    await finishSyncRun(client, runId, {
      status: terminalStatus,
      totalRecebidos: stats.recebidos,
      totalNovos: stats.novos,
      totalAtualizados: stats.alterados,
      totalInalterados: stats.inalterados,
      totalErros: stats.erros,
      ...(incompletaPorLimite
        ? { parametros: { ...body, continuation: continuationCatalogo(proximo) } }
        : {}),
    });
    return jsonResponse({
      sync_id: runId,
      status: terminalStatus,
      scope: "catalogo_catmat_pdms_efetivos",
      incluir_inativos: incluirInativos,
      tamanho_pagina: CATMAT_TAMANHO_PAGINA,
      pdms_efetivos: pdms.length,
      pdms_processados: indice,
      offset_pdm: inicio.offset,
      proximo_offset_pdm: incompletaPorLimite ? proximo : null,
      ...stats,
    }, stats.erros > 0 ? 500 : 200);
  } catch (error) {
    const detalhe = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : JSON.stringify(error);
    const isResumable = error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError;
    const status = isResumable ? "incompleta" : "falhou";
    await finishSyncRun(client, runId, {
      status,
      erroPrincipal: detalhe,
      parametros: {
        ...body,
        continuation: continuationCatalogo(inicio.offset + indice),
      },
    });
    return jsonResponse({
      error: detalhe,
      sync_id: runId,
      status,
      scope: "catalogo_catmat_pdms_efetivos",
      proximo_offset_pdm: inicio.offset + indice,
    }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const body = (await req.json().catch(() => ({}))) as SyncBody;
  const isAsync = url.searchParams.get("async") === "1" || body.async === true;
  if (deveSincronizarCatalogo(body)) {
    const bloqueio = bloqueioModoCatalogo(body);
    if (bloqueio) return jsonResponse({ status: "blocked", reason: bloqueio }, 400);
    if (isAsync) {
      const edgeRuntime = (globalThis as unknown as {
        EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
      }).EdgeRuntime;
      const runWorker = () => ingestCatalogoCatmat(body);
      if (typeof edgeRuntime?.waitUntil === "function") {
        edgeRuntime.waitUntil(runWorker());
      } else {
        runWorker().catch((err) => console.error("[async compras-catmat catalogo] Error:", err));
      }
      return jsonResponse({ status: "accepted", scope: "catalogo_catmat_pdms_efetivos" }, 202);
    }
    return await ingestCatalogoCatmat(body);
  }
  const resolved = resolveCatmatIngestTargets(body);
  if (!resolved.ok) {
    return jsonResponse({ status: "blocked", reason: resolved.reason }, 423);
  }
  if (isAsync) {
    const runWorker = async () => {
      if (resolved.pairs.length !== 1) {
        for (const pair of resolved.pairs) {
          await ingestOneCatmatClass({
            ...body,
            codigo_grupo: pair.grupo,
            codigo_classe: pair.classe,
          });
        }
      } else {
        await ingestOneCatmatClass({
          ...body,
          codigo_grupo: resolved.pairs[0].grupo,
          codigo_classe: resolved.pairs[0].classe,
        });
      }
    };
    const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === "function") {
      edgeRuntime.waitUntil(runWorker());
    } else {
      runWorker().catch((err) => console.error("[async compras-catmat] Error:", err));
    }
    return jsonResponse({ status: "accepted" }, 202);
  }
  if (resolved.pairs.length !== 1) {
    const runs = [];
    for (const pair of resolved.pairs) {
      const response = await ingestOneCatmatClass({
        ...body,
        codigo_grupo: pair.grupo,
        codigo_classe: pair.classe,
      });
      runs.push({ http_status: response.status, ...(await response.json()) });
    }
    const nonTerminal = runs.some((run) =>
      run.status === "already_running" ||
      run.status === "blocked" ||
      run.status === "executando" ||
      run.status === "pendente" ||
      run.status === "incompleta"
    );
    const failed = runs.some((run) =>
      run.http_status >= 400 || Number(run.erros ?? 0) > 0 ||
      run.status === "falhou" || run.status === "concluida_com_erros"
    );
    const aggregateStatus = (failed || nonTerminal)
      ? "concluida_com_erros"
      : "concluida";
    return jsonResponse({
      status: aggregateStatus,
      scope: "transitional_fitness_scope",
      classes: resolved.pairs.map((pair) => String(pair.classe)),
      runs,
    }, aggregateStatus === "concluida" ? 200 : 500);
  }
  return await ingestOneCatmatClass({
    ...body,
    codigo_grupo: resolved.pairs[0].grupo,
    codigo_classe: resolved.pairs[0].classe,
  });
});

async function ingestOneCatmatClass(body: SyncBody): Promise<Response> {
  const codigoGrupo = body.codigo_grupo;
  const codigoClasse = body.codigo_classe;
  if (codigoGrupo == null || codigoClasse == null) {
    return jsonResponse({ status: "blocked", reason: "par grupo/classe ausente" }, 500);
  }
  const scopeErr = assertCatmatClasseInScope(codigoGrupo, codigoClasse);
  if (scopeErr) {
    return jsonResponse({ status: "blocked", reason: scopeErr }, 423);
  }
  const incluirInativos = resolverIncluirInativos(body);
  const maxPaginas = body.max_paginas ?? 500;
  const offsetCaracteristicas = body.offset_caracteristicas ?? 0;
  const limiteCaracteristicas = body.limite_caracteristicas ?? 80;
  const somenteCaracteristicas = body.somente_caracteristicas ?? false;
  const incluirCaracteristicas = body.incluir_caracteristicas ?? somenteCaracteristicas;

  const client = createServiceClient();
  const httpClient = new UnifiedHttpClient({
    supabaseClient: client,
    telemetryLogger: (t) => logSyncRequest(client, t),
  });
  const material = new ComprasGovMaterialClient(httpClient);
  const lockKey = `compras-catmat:${codigoGrupo}:${codigoClasse}`;
  const { runId, alreadyRunning, continuation: inheritedContinuation } = await acquireSyncLock(
    client,
    lockKey,
    "compras_catmat",
    { codigoGrupo, codigoClasse, ...body },
  );

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const stats = emptyStats();
  const defaults = {
    grupo: String(codigoGrupo),
    classe: String(codigoClasse),
  };

  try {
      if (!inheritedContinuation) {
        await updateSyncHeartbeat(client, runId, {
          paginaAtual: 1,
          continuation: {
            codigoGrupo,
            codigoClasse,
            offset_caracteristicas: offsetCaracteristicas,
          },
          baseParametros: body,
        });
      }
    if (!somenteCaracteristicas) {
      const grupoRes = await material.consultarGrupoMaterial({
        codigoGrupo,
        ...(incluirInativos ? {} : { statusGrupo: true }),
      });
      await logAndStore(
        client,
        runId,
        "/modulo-material/1_consultarGrupoMaterial",
        { codigoGrupo },
        grupoRes.body,
        grupoRes.status,
        grupoRes.elapsedMs,
      );
      for (const raw of grupoRes.body.resultado ?? []) {
        const row = normalizeGrupoMaterial(raw as GrupoMaterial);
        const result = await upsertByNaturalKey(
          client,
          "catmat_grupos",
          { codigo_grupo: row.codigo_grupo },
          row,
          { syncRunId: runId },
        );
        tally(stats, result);
      }

      const classeRes = await material.consultarClasseMaterial({
        codigoGrupo,
        codigoClasse,
        ...(incluirInativos ? {} : { statusClasse: true }),
      });
      await logAndStore(
        client,
        runId,
        "/modulo-material/2_consultarClasseMaterial",
        { codigoGrupo, codigoClasse },
        classeRes.body,
        classeRes.status,
        classeRes.elapsedMs,
      );
      for (const raw of classeRes.body.resultado ?? []) {
        const row = normalizeClasseMaterial(raw as ClasseMaterial);
        const result = await upsertByHash(
          client,
          "catmat_classes",
          { codigo_grupo: row.codigo_grupo, codigo_classe: row.codigo_classe },
          row,
          { syncRunId: runId },
        );
        tally(stats, result);
      }

      const { pages: pdmPages, items: pdms } = await material.fetchPdms({
        codigoGrupo,
        codigoClasse,
        ...(incluirInativos ? {} : { statusPdm: true }),
      }, { maxPaginas, tamanhoPagina: CATMAT_TAMANHO_PAGINA });
      for (const page of pdmPages) {
        await logAndStore(
          client,
          runId,
          "/modulo-material/3_consultarPdmMaterial",
          { codigoGrupo, codigoClasse },
          page,
          200,
          0,
        );
      }

      const pdmIds: number[] = [];
      for (const raw of pdms) {
        const row = normalizePdmMaterial(raw as PdmMaterial);
        pdmIds.push(row.codigo_pdm);
        const result = await upsertByNaturalKey(
          client,
          "catmat_pdms",
          { codigo_pdm: row.codigo_pdm },
          row,
          { syncRunId: runId, lastSeenSyncId: runId },
        );
        tally(stats, result);
      }

      const { pages: itemPages, items: itens } = await material.fetchItens({
        codigoGrupo,
        codigoClasse,
        ...(incluirInativos ? {} : { statusItem: true }),
      }, { maxPaginas, tamanhoPagina: CATMAT_TAMANHO_PAGINA });
      for (const page of itemPages) {
        await logAndStore(
          client,
          runId,
          "/modulo-material/4_consultarItemMaterial",
          { codigoGrupo, codigoClasse },
          page,
          200,
          0,
        );
      }

      for (const raw of itens) {
        const item = raw as ItemMaterial;
        const row = normalizeCatalogoItemFromMaterial(item, defaults);
        const result = await upsertCatalogoItemFromCompras(client, row, {
          syncRunId: runId,
        });
        tally(stats, result);
      }

      for (const codigoPdm of pdmIds) {
        const { items: naturezas } = await material.fetchNaturezasDespesa(codigoPdm, {
          maxPaginas: 20,
        });
        for (const raw of naturezas) {
          const row = normalizeNaturezaDespesa(raw as NaturezaDespesaMaterial);
          if (!row) continue;
          const result = await upsertByHash(
            client,
            "catmat_pdm_naturezas_despesa",
            {
              codigo_pdm: row.codigo_pdm,
              codigo_natureza_despesa: row.codigo_natureza_despesa,
            },
            row,
            { syncRunId: runId },
          );
          tally(stats, result);
        }

        const { items: unidades } = await material.fetchUnidadesFornecimento(codigoPdm, {
          maxPaginas: 20,
        });
        for (const raw of unidades) {
          const row = normalizeUnidadeFornecimento(raw as UnidadeFornecimentoMaterial);
          if (!row) continue;
          const result = await upsertByHash(
            client,
            "catmat_pdm_unidades",
            {
              codigo_pdm: row.codigo_pdm,
              sigla_unidade_fornecimento: row.sigla_unidade_fornecimento,
              numero_sequencial: row.numero_sequencial,
            },
            row,
            { syncRunId: runId },
          );
          tally(stats, result);
        }
      }
    }

    if (!incluirCaracteristicas) {
      const terminalStatus = stats.erros > 0 ? "concluida_com_erros" : "concluida";
      await finishSyncRun(client, runId, {
        status: terminalStatus,
        totalRecebidos: stats.recebidos,
        totalNovos: stats.novos,
        totalAtualizados: stats.alterados,
        totalInalterados: stats.inalterados,
        totalErros: stats.erros,
      });

      return jsonResponse({
        sync_id: runId,
        status: terminalStatus,
        codigo_grupo: codigoGrupo,
        codigo_classe: codigoClasse,
        somente_caracteristicas: somenteCaracteristicas,
        incluir_caracteristicas: false,
        proximo_offset_caracteristicas: 0,
        ...stats,
      }, stats.erros > 0 ? 500 : 200);
    }

    const { data: itensParaCaracteristicas, error: itensError } = await client
      .from("catalogo_itens")
      .select("codigo_catmat, ativo")
      .eq("classe_catmat", defaults.classe)
      .eq("ativo", true)
      .order("codigo_catmat", { ascending: true })
      .range(offsetCaracteristicas, offsetCaracteristicas + limiteCaracteristicas - 1);
    if (itensError) throw itensError;

    let proximoOffset: number | null = null;
    const processados = itensParaCaracteristicas?.length ?? 0;
    if (processados === limiteCaracteristicas) {
      proximoOffset = offsetCaracteristicas + limiteCaracteristicas;
    }

    for (const item of itensParaCaracteristicas ?? []) {
      const codigoItem = Number(item.codigo_catmat);
      if (!Number.isFinite(codigoItem)) continue;

      const { items: caracteristicas } = await material.fetchCaracteristicas(codigoItem, {
        maxPaginas: 10,
      });
      await logAndStore(
        client,
        runId,
        "/modulo-material/7_consultarMaterialCaracteristicas",
        { codigoItem },
        { resultado: caracteristicas },
        200,
        0,
      );

      for (const raw of caracteristicas) {
        const row = normalizeCaracteristica(raw as CaracteristicaMaterial);
        if (!row) continue;
        const result = await upsertByHash(
          client,
          "catmat_item_caracteristicas",
          {
            codigo_item: row.codigo_item,
            codigo_caracteristica: row.codigo_caracteristica,
            codigo_valor_caracteristica: row.codigo_valor_caracteristica,
          },
          row,
          { syncRunId: runId },
        );
        tally(stats, result);
      }
    }

    await finishSyncRun(client, runId, {
      status: stats.erros > 0 ? "concluida_com_erros" : "concluida",
      totalRecebidos: stats.recebidos,
      totalNovos: stats.novos,
      totalAtualizados: stats.alterados,
      totalInalterados: stats.inalterados,
      totalErros: stats.erros,
    });

    const terminalStatus = stats.erros > 0 ? "concluida_com_erros" : "concluida";
    return jsonResponse({
      sync_id: runId,
      status: terminalStatus,
      codigo_grupo: codigoGrupo,
      codigo_classe: codigoClasse,
      somente_caracteristicas: somenteCaracteristicas,
      offset_caracteristicas: offsetCaracteristicas,
      limite_caracteristicas: limiteCaracteristicas,
      caracteristicas_processadas: processados,
      proximo_offset_caracteristicas: proximoOffset,
      ...stats,
    }, stats.erros > 0 ? 500 : 200);
  } catch (error) {
    const detalhe = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : JSON.stringify(error);
    const isResumable = error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError;
    const isManual = lockKey.includes(":manual:");
    const status = isManual ? "falhou" : (isResumable ? "incompleta" : "falhou");
    await finishSyncRun(client, runId, {
      status,
      erroPrincipal: detalhe,
      parametros: {
        ...body,
        continuation: {
          codigoGrupo,
          codigoClasse,
          offset_caracteristicas: offsetCaracteristicas,
        },
      },
    });
    return jsonResponse({
      error: detalhe,
      sync_id: runId,
      status,
    }, 500);
  }
}
