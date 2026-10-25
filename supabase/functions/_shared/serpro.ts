/**
 * Cliente oficial do Integra Compras (Serpro)
 * Autenticação OAuth2 Client Credentials e consulta aos canais de Chat e Diligências do Compras.gov.br
 * Base: Spec 0039 / Parecer de 23/10/2026
 */

export interface MensagemSerpro {
  id: number;
  item?: number | null;
  categoria: "CHAT" | "DILIGENCIA" | "AVISO" | "SISTEMA";
  remetente: string;
  texto: string;
  dataHora: number; // timestamp em ms (ex: 1792900000000)
}

export interface RespostaChatSerpro {
  chaveCompra: string;
  mensagens: MensagemSerpro[];
}

interface TokenCache {
  accessToken: string;
  expiraEmMs: number;
}

const GATEWAY_URL = "https://gateway.apiserpro.serpro.gov.br";
let cacheToken: TokenCache | null = null;

/**
 * Obtém ou reutiliza o Bearer token OAuth2 do Gateway Serpro.
 * O token tem validade de 3600 segundos; renovamos com margem de segurança aos 55 minutos (3300s).
 */
export async function obterTokenSerpro(
  consumerKey?: string,
  consumerSecret?: string
): Promise<string> {
  const agora = Date.now();
  if (cacheToken && agora < cacheToken.expiraEmMs) {
    return cacheToken.accessToken;
  }

  const key = consumerKey ?? Deno.env.get("SERPRO_CONSUMER_KEY");
  const secret = consumerSecret ?? Deno.env.get("SERPRO_CONSUMER_SECRET");

  if (!key || !secret) {
    throw new Error("Credenciais do Integra Compras Serpro não configuradas (SERPRO_CONSUMER_KEY / SERPRO_CONSUMER_SECRET).");
  }

  const credentialsBase64 = btoa(`${key}:${secret}`);

  const res = await fetch(`${GATEWAY_URL}/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentialsBase64}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const textoErro = await res.text();
    throw new Error(`Falha na autenticação Serpro (HTTP ${res.status}): ${textoErro}`);
  }

  const data = await res.json();
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

  // Define expiração com 5 minutos de folga
  cacheToken = {
    accessToken: data.access_token,
    expiraEmMs: agora + (expiresIn - 300) * 1000,
  };

  return cacheToken.accessToken;
}

/**
 * Invalida manualmente o token em cache (em caso de 401 inesperado).
 */
export function invalidarTokenCache(): void {
  cacheToken = null;
}

/**
 * Consulta o chat de mensagens oficiais de uma compra no Compras.gov.br.
 * Cobrança por chamada pelo Serpro (200, 206, 404).
 */
export async function consultarChatSerpro(
  chaveCompra: string,
  token?: string
): Promise<MensagemSerpro[]> {
  return await chamarEndpointSerpro(`/integra-compras/v1/chat/${encodeURIComponent(chaveCompra)}`, token);
}

/**
 * Consulta o chat de diligências oficiais de uma compra no Compras.gov.br.
 */
export async function consultarDiligenciasSerpro(
  chaveCompra: string,
  token?: string
): Promise<MensagemSerpro[]> {
  return await chamarEndpointSerpro(`/integra-compras/v1/diligencias/${encodeURIComponent(chaveCompra)}`, token);
}

async function chamarEndpointSerpro(
  caminho: string,
  tokenFornecido?: string
): Promise<MensagemSerpro[]> {
  const token = tokenFornecido ?? (await obterTokenSerpro());

  let res = await fetch(`${GATEWAY_URL}${caminho}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });

  // Se receber 401 (token expirado no gateway antes do prazo), invalida cache e tenta uma segunda vez
  if (res.status === 401 && !tokenFornecido) {
    invalidarTokenCache();
    const novoToken = await obterTokenSerpro();
    res = await fetch(`${GATEWAY_URL}${caminho}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${novoToken}`,
        "Accept": "application/json",
      },
    });
  }

  if (res.status === 404) {
    // 404 no Integra Compras indica ausência de mensagens para a compra informada
    return [];
  }

  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`Erro ao consultar Integra Compras Serpro (${caminho}) [HTTP ${res.status}]: ${texto}`);
  }

  const dados: RespostaChatSerpro = await res.json();
  return Array.isArray(dados.mensagens) ? dados.mensagens : [];
}
