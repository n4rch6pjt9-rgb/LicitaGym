/**
 * Cliente do Integra Compras (Serpro): chat de mensagens e chat de diligências de uma compra do Compras.gov.br.
 * Spec 0039, etapa 1 (K-3). Formato da resposta: docs/compras-gov/integra-compras.md (exemplo oficial da documentação).
 *
 * Regras:
 * - autenticação OAuth2 client_credentials no gateway; token de 1 h, renovado com folga de 5 min;
 * - 401 pede token novo uma única vez e repete a chamada;
 * - 404 = "sem mensagens" (é cobrado, não é erro);
 * - 429 e 503 tentam de novo com backoff e respeitam Retry-After; 403, 502 e o resto viram ErroIntegraCompras;
 * - nada é traduzido nem completado: categoria e tipoRemetente ficam com o código da fonte;
 *   item fora do formato documentado é erro, nunca linha inventada.
 */

/** Mensagem como a fonte entrega, já validada. */
export interface MensagemIntegra {
  tipo: "mensagem" | "diligencia";
  chaveMensagem: string;
  /** null = mensagem da compra (sem item). */
  identificadorItem: string | null;
  texto: string;
  /** Código da fonte (ex.: "2", "11"), sem tradução; null = a fonte não informou. */
  categoria: string | null;
  /** Código da fonte (ex.: "0"), sem tradução; null = a fonte não informou. */
  tipoRemetente: string | null;
  /** Instante em ISO 8601 (UTC). */
  dataHora: string;
  /** dataHora exatamente como veio da fonte. */
  dataHoraFonte: string;
  chaveCompra: ChaveCompraIntegra | null;
}

export interface ChaveCompraIntegra {
  idUasgIdentificacao: number | null;
  idModalidade: number | null;
  numero: number | null;
  ano: number | null;
  numeroUasg: number | null;
}

/** Resultado de uma chamada. `status` vai para o registro de execução (200, 206 e 404 são cobrados). */
export interface ResultadoConsultaIntegra {
  status: number;
  mensagens: MensagemIntegra[];
}

export class ErroIntegraCompras extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ErroIntegraCompras";
  }
}

interface TokenCache {
  accessToken: string;
  expiraEmMs: number;
}

const GATEWAY_URL = "https://gateway.apiserpro.serpro.gov.br";
const TIMEOUT_MS = 20_000;
const MAX_TENTATIVAS_RETRY = 3;
const RETRY_AFTER_MAX_S = 30;
const CHAVE_COMPRA_RE = /^\d{17}$/;

let cacheToken: TokenCache | null = null;

/** Pausa entre tentativas; substituível nos testes. */
let dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function definirDormirParaTeste(fn: (ms: number) => Promise<void>): void {
  dormir = fn;
}

/**
 * Obtém ou reutiliza o Bearer token do gateway.
 * Credenciais: secrets SERPRO_CONSUMER_KEY e SERPRO_CONSUMER_SECRET (cadastrados pelo Marcelo no Supabase).
 */
export async function obterTokenSerpro(
  consumerKey?: string,
  consumerSecret?: string,
): Promise<string> {
  const agora = Date.now();
  if (cacheToken && agora < cacheToken.expiraEmMs) {
    return cacheToken.accessToken;
  }

  const key = consumerKey ?? Deno.env.get("SERPRO_CONSUMER_KEY");
  const secret = consumerSecret ?? Deno.env.get("SERPRO_CONSUMER_SECRET");

  if (!key || !secret) {
    throw new Error(
      "Credenciais do Integra Compras Serpro não configuradas (SERPRO_CONSUMER_KEY / SERPRO_CONSUMER_SECRET).",
    );
  }

  const res = await fetch(`${GATEWAY_URL}/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${key}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    await res.body?.cancel();
    // O corpo da resposta de token não vai para a mensagem: pode ecoar dado de credencial.
    throw new ErroIntegraCompras(`Falha na autenticação Serpro (HTTP ${res.status}).`, res.status);
  }

  const data = await res.json();
  if (typeof data?.access_token !== "string" || !data.access_token) {
    throw new ErroIntegraCompras("Resposta de token do Serpro sem access_token.", res.status);
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

  cacheToken = {
    accessToken: data.access_token,
    expiraEmMs: agora + Math.max(expiresIn - 300, 60) * 1000,
  };
  return cacheToken.accessToken;
}

/** Invalida o token em cache (401 inesperado). */
export function invalidarTokenCache(): void {
  cacheToken = null;
}

/** GET /integra-compras/v1/chat/{chaveCompra} */
export function consultarChatSerpro(chaveCompra: string): Promise<ResultadoConsultaIntegra> {
  return consultar(chaveCompra, "mensagem");
}

/** GET /integra-compras/v1/chat/{chaveCompra}/diligencias */
export function consultarDiligenciasSerpro(chaveCompra: string): Promise<ResultadoConsultaIntegra> {
  return consultar(chaveCompra, "diligencia");
}

async function consultar(
  chaveCompra: string,
  tipo: MensagemIntegra["tipo"],
): Promise<ResultadoConsultaIntegra> {
  try {
    return await consultarSemEmbrulho(chaveCompra, tipo);
  } catch (e) {
    if (e instanceof ErroIntegraCompras) throw e;
    // Timeout, rede, JSON inválido ou credencial ausente: o chamador sempre recebe ErroIntegraCompras,
    // para fechar o registro da execução com erro (nunca deixar a consulta como se tivesse dado certo).
    const nome = e instanceof Error ? e.name : "Erro";
    throw new ErroIntegraCompras(`Falha ao consultar o Integra Compras (${nome}).`, null);
  }
}

async function consultarSemEmbrulho(
  chaveCompra: string,
  tipo: MensagemIntegra["tipo"],
): Promise<ResultadoConsultaIntegra> {
  if (!CHAVE_COMPRA_RE.test(chaveCompra)) {
    throw new ErroIntegraCompras("chaveCompra deve ter 17 dígitos.", null);
  }
  const caminho = `/integra-compras/v1/chat/${chaveCompra}${tipo === "diligencia" ? "/diligencias" : ""}`;

  let token = await obterTokenSerpro();
  let renovouToken = false;
  let res: Response | null = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_RETRY; tentativa++) {
    res = await fetch(`${GATEWAY_URL}${caminho}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 401 && !renovouToken) {
      await res.body?.cancel();
      renovouToken = true;
      invalidarTokenCache();
      token = await obterTokenSerpro();
      tentativa--; // a renovação de token não conta como tentativa de retry
      continue;
    }

    if ((res.status === 429 || res.status === 503) && tentativa < MAX_TENTATIVAS_RETRY) {
      await res.body?.cancel();
      await dormir(esperaMs(res.headers.get("Retry-After"), tentativa));
      continue;
    }
    break;
  }

  if (!res) throw new ErroIntegraCompras("Sem resposta do Integra Compras.", null);

  if (res.status === 404) {
    await res.body?.cancel();
    return { status: 404, mensagens: [] };
  }

  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new ErroIntegraCompras(`Integra Compras respondeu HTTP ${res.status}.`, res.status);
  }

  const corpo: unknown = await res.json();
  if (!Array.isArray(corpo)) {
    throw new ErroIntegraCompras(`Resposta do Integra Compras fora do formato documentado (esperada uma lista).`, res.status);
  }
  return { status: res.status, mensagens: corpo.map((m, i) => normalizarMensagem(m, tipo, i)) };
}

function esperaMs(retryAfter: string | null, tentativa: number): number {
  const s = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(s, RETRY_AFTER_MAX_S) * 1000;
  return Math.min(2 ** tentativa, RETRY_AFTER_MAX_S) * 1000;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_HORA_FONTE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * Converte o dataHora da fonte para ISO (UTC).
 * A documentação mostra "2026-02-05 16:15:00.144", sem fuso. Tratamos como horário de Brasília (UTC-3, sem horário
 * de verão desde 2019), que é o horário do Compras.gov.br. O texto original fica em dataHoraFonte.
 * Também aceita número em milissegundos (época Unix).
 */
export function converterDataHoraFonte(valor: unknown): string | null {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    return new Date(valor).toISOString();
  }
  if (typeof valor !== "string") return null;
  const m = DATA_HORA_FONTE_RE.exec(valor.trim());
  if (!m) return null;
  const [, a, mes, d, h, min, s, ms] = m;
  const iso = `${a}-${mes}-${d}T${h}:${min}:${s}.${(ms ?? "0").padEnd(3, "0")}-03:00`;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  // Rejeita datas que o Date "corrige" (ex.: 31/02).
  const local = new Date(data.getTime() - 3 * 3600_000);
  if (local.getUTCFullYear() !== Number(a) || local.getUTCMonth() + 1 !== Number(mes) || local.getUTCDate() !== Number(d)) {
    return null;
  }
  return data.toISOString();
}

function textoOuNull(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function numeroOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizarMensagem(bruto: unknown, tipo: MensagemIntegra["tipo"], indice: number): MensagemIntegra {
  if (!bruto || typeof bruto !== "object") {
    throw new ErroIntegraCompras(`Mensagem ${indice} do Integra Compras não é um objeto.`, null);
  }
  const m = bruto as Record<string, unknown>;
  const chaveMensagem = textoOuNull(m.chaveMensagem);
  const dataHora = converterDataHoraFonte(m.dataHora);
  if (!chaveMensagem || !UUID_RE.test(chaveMensagem) || !dataHora || typeof m.texto !== "string") {
    throw new ErroIntegraCompras(
      `Mensagem ${indice} do Integra Compras fora do formato documentado (chaveMensagem uuid, texto e dataHora são obrigatórios).`,
      null,
    );
  }
  const ck = m.chaveCompra && typeof m.chaveCompra === "object" ? m.chaveCompra as Record<string, unknown> : null;
  return {
    tipo,
    chaveMensagem,
    identificadorItem: textoOuNull(m.identificadorItem),
    texto: m.texto,
    categoria: textoOuNull(m.categoria),
    tipoRemetente: textoOuNull(m.tipoRemetente),
    dataHora,
    dataHoraFonte: String(m.dataHora),
    chaveCompra: ck
      ? {
        idUasgIdentificacao: numeroOuNull(ck.idUasgIdentificacao),
        idModalidade: numeroOuNull(ck.idModalidade),
        numero: numeroOuNull(ck.numero),
        ano: numeroOuNull(ck.ano),
        numeroUasg: numeroOuNull(ck.numeroUasg),
      }
      : null,
  };
}
