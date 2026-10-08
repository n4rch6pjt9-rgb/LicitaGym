/**
 * Portal de Compras Públicas (issue #266).
 * Só o host da página e o caminho /processos/{UF}/{comprador}/{processo}.
 * O host da API não é link de edital. BLL, BNC e os demais portais ficam de fora
 * até a medição. Não traduz fase do portal para etapa do pipeline.
 */

const PAGINA_HOSTS = new Set([
  "portaldecompraspublicas.com.br",
  "www.portaldecompraspublicas.com.br",
]);

const API_BASE = "https://compras.api.portaldecompraspublicas.com.br";

export const PORTAL_DEBOUNCE_MS = 30_000;

export interface PortalProcesso {
  uf: string;
  comprador: string;
  processo: string;
  codigoLicitacao: string;
  pagina: string;
  api: string;
}

export type AtualizacaoPortal = "cache" | "consultado" | "debounce" | "fora_do_pipeline" | "erro";

export interface PortalAlerta {
  url: string;
  codigo_licitacao: string;
  consultado_em: string | null;
  desatualizado: boolean;
  no_pipeline: boolean;
  situacao: string | null;
}

export interface PortalSecao extends PortalAlerta {
  familia: "portaldecompraspublicas";
  atualizacao: AtualizacaoPortal;
  erro: string | null;
}

export interface CandidatoPortal {
  id: number;
  link: string;
  dataFim: string | null;
  emPipeline: boolean;
  consultadoEm: string | null;
}

export function parsePortalProcessoUrl(raw: unknown): PortalProcesso | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!PAGINA_HOSTS.has(host)) return null;

  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 4 || parts[0].toLowerCase() !== "processos") return null;
  const uf = parts[1];
  const comprador = parts[2];
  const processo = parts[3];
  if (!/^[A-Za-z]{2}$/.test(uf) || comprador.includes("..") || processo.includes("..")) return null;
  const digitos = processo.match(/\d+/g);
  if (!digitos || digitos.length === 0) return null;

  const pagina = `https://${host}/processos/${uf}/${comprador}/${processo}`;
  const api = `${API_BASE}/v2/licitacao/${encodeURIComponent(uf)}/${encodeURIComponent(comprador)}/${encodeURIComponent(processo)}`;
  return {
    uf,
    comprador,
    processo,
    codigoLicitacao: digitos[digitos.length - 1],
    pagina,
    api,
  };
}

export function diaBrasilia(quando: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(quando);
}

/** Verdadeiro quando não há consulta, ou a consulta é de um dia anterior em Brasília. */
export function portalDesatualizado(consultadoEm: string | null, agora: Date): boolean {
  if (!consultadoEm) return true;
  const quando = new Date(consultadoEm);
  if (Number.isNaN(quando.getTime())) return true;
  return diaBrasilia(quando) < diaBrasilia(agora);
}

export function portalEmDebounce(consultadoEm: string | null, agora: Date): boolean {
  if (!consultadoEm) return false;
  const quando = new Date(consultadoEm).getTime();
  if (Number.isNaN(quando)) return false;
  const idade = agora.getTime() - quando;
  return idade >= 0 && idade < PORTAL_DEBOUNCE_MS;
}

export function decidirAtualizacaoPortal(
  atualizar: boolean,
  noPipeline: boolean,
  consultadoEm: string | null,
  agora: Date,
): AtualizacaoPortal {
  if (portalEmDebounce(consultadoEm, agora)) return "debounce";
  // Sem leitura hoje, a abertura do acompanhamento consulta o portal.
  if (portalDesatualizado(consultadoEm, agora)) return "consultado";
  if (!atualizar) return "cache";
  if (noPipeline) return "fora_do_pipeline";
  return "consultado";
}

export function situacaoPortal(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const status = (body as Record<string, unknown>).statusProcesso;
  if (typeof status === "number" && Number.isFinite(status)) return String(status);
  if (typeof status === "string" && status.trim() !== "") return status.trim();
  return null;
}

export function codigoRespostaPortal(body: unknown, codigoDoCaminho: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const codigo = (body as Record<string, unknown>).codigoLicitacao;
    if (typeof codigo === "number" && Number.isFinite(codigo)) return String(codigo);
    if (typeof codigo === "string" && codigo.trim() !== "") return codigo.trim();
  }
  return codigoDoCaminho;
}

export function alertaPortal(
  processo: PortalProcesso,
  consultadoEm: string | null,
  situacao: string | null,
  noPipeline: boolean,
  agora: Date,
): PortalAlerta {
  return {
    url: processo.pagina,
    codigo_licitacao: processo.codigoLicitacao,
    consultado_em: consultadoEm,
    desatualizado: portalDesatualizado(consultadoEm, agora),
    no_pipeline: noPipeline,
    situacao,
  };
}

/**
 * Quem ainda não foi lido hoje em Brasília, com prazo futuro ou já no pipeline.
 * Os mais antigos (e os nunca lidos) vêm primeiro.
 */
export function escolherLotePortal(linhas: CandidatoPortal[], agora: Date, limite: number): PortalProcesso[] {
  const teto = Math.max(0, limite);
  const elegiveis = linhas
    .map((linha) => ({ linha, processo: parsePortalProcessoUrl(linha.link) }))
    .filter((item): item is { linha: CandidatoPortal; processo: PortalProcesso } => item.processo !== null)
    .filter((item) => item.linha.emPipeline || prazoFuturo(item.linha.dataFim, agora))
    .filter((item) => portalDesatualizado(item.linha.consultadoEm, agora));

  elegiveis.sort((a, b) => {
    if (a.linha.consultadoEm === null && b.linha.consultadoEm !== null) return -1;
    if (a.linha.consultadoEm !== null && b.linha.consultadoEm === null) return 1;
    if (a.linha.consultadoEm === b.linha.consultadoEm) return a.linha.id - b.linha.id;
    return String(a.linha.consultadoEm).localeCompare(String(b.linha.consultadoEm));
  });

  return elegiveis.slice(0, teto).map((item) => item.processo);
}

function prazoFuturo(dataFim: string | null, agora: Date): boolean {
  if (!dataFim) return false;
  const fim = new Date(dataFim).getTime();
  return !Number.isNaN(fim) && fim > agora.getTime();
}

export async function consultarPortal(
  apiUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ httpStatus: number; body: Record<string, unknown> | null; erro: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetchImpl(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 429) return { httpStatus: 429, body: null, erro: "limite do portal" };
    if (res.status < 200 || res.status >= 300) {
      return { httpStatus: res.status, body: null, erro: "resposta não ok" };
    }
    const text = await res.text();
    if (!text.trim()) return { httpStatus: res.status, body: null, erro: "corpo vazio" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { httpStatus: res.status, body: null, erro: "corpo não é JSON" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { httpStatus: res.status, body: null, erro: "envelope inválido" };
    }
    return { httpStatus: res.status, body: body as Record<string, unknown>, erro: null };
  } catch (err: unknown) {
    const abortou = err instanceof Error && err.name === "AbortError";
    return { httpStatus: 0, body: null, erro: abortou ? "timeout" : "falha de rede" };
  } finally {
    clearTimeout(timer);
  }
}
