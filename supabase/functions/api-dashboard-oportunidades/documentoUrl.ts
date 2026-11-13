/**
 * Spec 0061, K-2: action=documento_url. Link assinado do Supabase Storage para abrir um documento do processo
 * (licitacao_documentos), gerado a cada clique e válido por 10 minutos.
 *
 * - Exige empresa ativa de quem chama (403 sem vínculo, vínculo desligado ou empresa desativada) antes de ler o
 *   documento. licitacao_documentos é dado público coletado do portal, sem tenant_id: não há filtro por empresa.
 * - 404 para documento inexistente, removido do portal, ainda não baixado, sem arquivo ou fora do bucket do LicitaGym
 *   (arquivo antigo no GCS, `gs://`, não abre por aqui).
 * - Nunca devolve o storage_uri nem o caminho no Storage, e nunca repassa mensagem do PostgREST ou do Storage.
 * - PDF abre na aba; outro formato vai como download com o nome original.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import type { DocumentoUrlActionParams } from "./types.ts";

export const DOCUMENTO_URL_SEGUNDOS = 600;
/** Bucket privado dos documentos coletados (coletor: SUPABASE_STORAGE_BUCKET). */
export const BUCKET_DOCUMENTOS = "licitacao-documentos";
const COLUNAS = "id,nome_original,mime_type,storage_uri,status_processamento,removido_do_portal_em";

type TenantDoUsuario = () => Promise<number | null>;

interface Ctx {
  getClient?: () => SupabaseClient;
  tenantDoUsuario?: TenantDoUsuario;
}

/** `supabase://<bucket>/<caminho>` -> caminho, só no bucket dos documentos e sem segmento `..` ou vazio. */
export function caminhoNoBucket(storageUri: unknown): string | null {
  if (typeof storageUri !== "string") return null;
  const prefixo = `supabase://${BUCKET_DOCUMENTOS}/`;
  if (!storageUri.startsWith(prefixo)) return null;
  const caminho = storageUri.slice(prefixo.length);
  const partes = caminho.split("/");
  if (!caminho || partes.some((p) => p === "" || p === "." || p === "..")) return null;
  return caminho;
}

const naoEncontrado = () => jsonResponse({ error: "Documento não encontrado ou sem arquivo para abrir." }, 404);

export async function handleDocumentoUrl(
  params: DocumentoUrlActionParams,
  ctx: Ctx,
  getDefaultClient: () => SupabaseClient,
): Promise<Response> {
  try {
    const tenant = await (ctx.tenantDoUsuario ?? (() => Promise.resolve(null)))();
    if (tenant === null) {
      return jsonResponse({ error: "Usuário sem empresa ativa." }, 403);
    }
    const client = ctx.getClient ? ctx.getClient() : getDefaultClient();
    const { data, error } = await client.from("licitacao_documentos").select(COLUNAS).eq("id", params.documento_id)
      .maybeSingle();
    if (error) {
      console.error("[api-dashboard-oportunidades] Erro ao ler documento em documento_url:", error);
      return jsonResponse({ error: "Falha ao consultar o documento" }, 500);
    }
    const doc = data as Record<string, unknown> | null;
    if (!doc || doc.removido_do_portal_em || doc.status_processamento !== "baixado") return naoEncontrado();
    const caminho = caminhoNoBucket(doc.storage_uri);
    if (!caminho) return naoEncontrado();

    const mime = typeof doc.mime_type === "string" ? doc.mime_type : null;
    const nome = typeof doc.nome_original === "string" ? doc.nome_original : null;
    const pdf = mime === "application/pdf";
    const opcoes = pdf ? undefined : { download: nome || true };
    const assinada = await client.storage.from(BUCKET_DOCUMENTOS).createSignedUrl(
      caminho,
      DOCUMENTO_URL_SEGUNDOS,
      opcoes,
    );
    const url = assinada.data?.signedUrl;
    if (assinada.error || !url) {
      console.error("[api-dashboard-oportunidades] Falha ao assinar documento", params.documento_id, assinada.error);
      return jsonResponse({ error: "Não foi possível gerar o link do documento" }, 502);
    }
    return jsonResponse({
      action: "documento_url",
      documento_id: params.documento_id,
      url,
      expira_em_segundos: DOCUMENTO_URL_SEGUNDOS,
      nome_original: nome,
      mime_type: mime,
      abrir: pdf ? "aba" : "download",
    });
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em documento_url:", err);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}
