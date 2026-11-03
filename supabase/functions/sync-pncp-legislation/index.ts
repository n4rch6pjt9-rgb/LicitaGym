import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { sha256Hex } from "../_shared/pncp/hash.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  updateSyncHeartbeat,
} from "../_shared/pncp/supabase-admin.ts";

const DEFAULT_INDEX =
  "https://www.gov.br/pncp/pt-br/pncp/legislacao";
const ORCAMENTO_PADRAO_MS = 90_000;

async function fetchComRetry(
  url: string,
  init: RequestInit = {},
  tentativas = 3,
  timeoutMs = 15_000,
): Promise<Response> {
  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 500 || tentativa === tentativas - 1) {
        return res;
      }
      ultimoErro = new Error(`HTTP ${res.status} em ${url}`);
    } catch (err) {
      ultimoErro = err;
      if (tentativa === tentativas - 1) break;
    }
    const baseMs = 600 * Math.pow(2, tentativa);
    const jitterMs = Math.floor(Math.random() * 300);
    await new Promise((r) => setTimeout(r, baseMs + jitterMs));
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro));
}

function extractDocumentLinks(html: string, baseUrl: string): Array<{ titulo: string; url: string }> {
  const links: Array<{ titulo: string; url: string }> = [];
  const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const titulo = match[2].replace(/<[^>]+>/g, "").trim();
    if (!href || !titulo) continue;
    const lower = href.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.includes("legislacao")) continue;
    const url = href.startsWith("http") ? href : new URL(href, baseUrl).toString();
    links.push({ titulo, url });
  }
  return links;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const client = createServiceClient();
  const lockKey = "legislacao-sync";
  const { runId, alreadyRunning } = await acquireSyncLock(client, lockKey, "legislacao", {});

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const stats = { detectados: 0, novos: 0, inalterados: 0, erros: 0 };
  const inicioMs = Date.now();

  try {
    const { data: fonte } = await client.from("legislacao_fontes")
      .select("id, url")
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();

    let indexUrl = fonte?.url ?? DEFAULT_INDEX;
    const headersIndex = { Accept: "text/html", "User-Agent": "licitagym-pncp-sync/1.0" };
    let started = Date.now();
    let response: Response;
    try {
      response = await fetchComRetry(indexUrl, { headers: headersIndex });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ao consultar ${indexUrl}`);
      }
    } catch (errIndex) {
      await logSyncRequest(client, {
        syncRunId: runId,
        endpoint: indexUrl,
        parametros: { fallback: indexUrl !== DEFAULT_INDEX },
        tempoRespostaMs: Date.now() - started,
        erro: errIndex instanceof Error ? errIndex.message : String(errIndex),
      });
      if (indexUrl !== DEFAULT_INDEX) {
        stats.erros++;
        indexUrl = DEFAULT_INDEX;
        started = Date.now();
        response = await fetchComRetry(indexUrl, { headers: headersIndex });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ao consultar ${indexUrl}`);
        }
      } else {
        throw errIndex;
      }
    }
    const html = await response.text();
    const pageHash = await sha256Hex(html);

    await logSyncRequest(client, {
      syncRunId: runId,
      endpoint: indexUrl,
      parametros: {},
      statusHttp: response.status,
      tempoRespostaMs: Date.now() - started,
      respostaHash: pageHash,
    });

    if (fonte?.id && indexUrl === fonte.url) {
      await client.from("legislacao_fontes").update({
        ultima_verificacao: new Date().toISOString(),
        ultimo_hash_pagina: pageHash,
        etag_pagina: response.headers.get("etag"),
        last_modified_pagina: response.headers.get("last-modified"),
      }).eq("id", fonte.id);
    }

    const links = extractDocumentLinks(html, indexUrl);
    stats.detectados = links.length;

    for (const link of links) {
      if (Date.now() - inicioMs >= ORCAMENTO_PADRAO_MS) {
        break;
      }
      await updateSyncHeartbeat(client, runId);
      try {
        const urlCanon = link.url.split("#")[0];
        const { data: doc } = await client.from("legislacao_documentos")
          .select("id, versao_atual_id")
          .eq("url_canonica", urlCanon)
          .maybeSingle();

        let documentoId = doc?.id as string | undefined;
        if (!documentoId) {
          const { data: inserted, error } = await client.from("legislacao_documentos").insert({
            titulo: link.titulo,
            url_oficial: link.url,
            url_canonica: urlCanon,
            fonte_id: fonte?.id ?? null,
            status: "pendente_validacao",
          }).select("id").single();
          if (error) throw error;
          documentoId = inserted.id as string;
          stats.novos++;
        } else {
          stats.inalterados++;
        }

        const head = await fetchComRetry(link.url, { method: "HEAD" });
        const etag = head.headers.get("etag");
        const lastModified = head.headers.get("last-modified");

        const { data: versaoExistente } = await client.from("legislacao_versoes")
          .select("id")
          .eq("documento_id", documentoId)
          .eq("etag", etag ?? "none")
          .maybeSingle();

        if (versaoExistente) continue;

        const fileRes = await fetchComRetry(link.url);
        if (!fileRes.ok) {
          throw new Error(`HTTP ${fileRes.status} ao baixar ${link.url}`);
        }
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        const sha256 = await sha256Hex(bytes);
        const storagePath = `${documentoId}/${sha256.slice(0, 16)}/original.pdf`;

        const { error: uploadError } = await client.storage
          .from("pncp-legislation")
          .upload(storagePath, bytes, {
            contentType: fileRes.headers.get("content-type") ?? "application/pdf",
            upsert: false,
          });
        if (uploadError && !uploadError.message.includes("already exists")) {
          throw uploadError;
        }

        const { data: versao, error: versaoError } = await client.from("legislacao_versoes")
          .insert({
            documento_id: documentoId,
            numero_versao: 1,
            storage_path: storagePath,
            nome_arquivo: link.titulo.slice(0, 200),
            mime_type: fileRes.headers.get("content-type"),
            tamanho_bytes: bytes.byteLength,
            sha256,
            etag,
            last_modified_origem: lastModified,
            status: "baixada",
            is_current: true,
          })
          .select("id")
          .single();
        if (versaoError && !versaoError.message.includes("duplicate")) throw versaoError;

        if (versao?.id) {
          await client.from("legislacao_documentos").update({
            versao_atual_id: versao.id,
            status: "vigente",
          }).eq("id", documentoId);

          await client.from("legislacao_alertas").insert({
            sync_run_id: runId,
            documento_id: documentoId,
            tipo_alerta: "nova_versao",
            severidade: "info",
            titulo: "Nova versão de legislação",
            mensagem: link.titulo,
          });
        }
      } catch {
        stats.erros++;
      }
    }

    await finishSyncRun(client, runId, {
      status: stats.erros > 0 ? "concluida_com_erros" : "concluida",
      totalRecebidos: stats.detectados,
      totalNovos: stats.novos,
      totalInalterados: stats.inalterados,
      totalErros: stats.erros,
    });

    return jsonResponse({ sync_id: runId, status: "concluida", ...stats });
  } catch (error) {
    await finishSyncRun(client, runId, {
      status: "falhou",
      erroPrincipal: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: String(error), sync_id: runId }, 500);
  }
});
