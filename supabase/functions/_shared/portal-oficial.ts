import { ALLOWED_ORIGEM_HOSTS, buildOrigemUrl, isValidHttpsUrl, parsePncpControleToUrl } from "./edital-url.ts";

/**
 * Portal oficial da disputa (onde ficam sessão, chat, recursos e documentos de origem).
 *
 * Decisão de produto (15/10/2026): o PNCP é o meio, não o fim. O portal oficial informado no edital é a fonte
 * primária; o PNCP é fallback e costuma atrasar em relação ao portal. Por isso todo edital lido pelo agente
 * precisa dizer qual é o portal oficial, mesmo quando não há link público seguro para ele.
 *
 * Ordem:
 * 1. `link_sistema_origem` (o linkSistemaOrigem que o órgão informou ao PNCP), validado por `buildOrigemUrl`;
 * 2. link derivado de identificador oficial, só para portais mapeados (hoje: SISLOG/GO, página pública
 *    DetalhesLicitacao, que traz chat, documentos e situação sem login);
 * 3. sem link: devolve só o nome do sistema (`raw.usuario_nome` do PNCP), para a tela e o agente dizerem
 *    "acompanhe no portal X" em vez de omitir.
 * Nada é inventado: sem nome e sem link, os dois campos ficam null.
 */

export type MetodoPortal = "link_origem" | "derivado" | "sem_link";

export interface PortalOficial {
  /** Nome do sistema que o órgão informou ao PNCP (`usuario_nome`). null = não informado. */
  nome: string | null;
  /** Página pública do processo no portal oficial, já validada (https + host permitido). */
  url: string | null;
  host: string | null;
  metodo: MetodoPortal;
  /** Página do edital no PNCP, quando o número de controle permite montar. */
  url_pncp: string | null;
}

export interface LicitacaoParaPortal {
  fonte?: unknown;
  codigo_externo?: unknown;
  numero_edital?: unknown;
  link_sistema_origem?: unknown;
  /** `raw->>usuario_nome` já extraído (o repo não precisa ler o raw inteiro). */
  usuario_nome?: unknown;
  raw?: Record<string, unknown> | null;
}

const SISLOG_NOME_RE = /\bsislog\b/i;
/** "Pregão - Eletrônico nº 114655/2025", "Dispensa nº 116918/2025": idLicitacao é o número antes do ano. */
const SISLOG_ID_RE = /n\s*[ºo°.]?\s*(\d{5,7})\s*\/\s*\d{4}\b/i;
export const SISLOG_DETALHE = "https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=";

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/** idLicitacao do SISLOG a partir do número do edital publicado no PNCP. null se o formato não bater. */
export function idSislog(numeroEdital: unknown): string | null {
  const t = texto(numeroEdital);
  if (!t) return null;
  const m = t.match(SISLOG_ID_RE);
  return m ? m[1] : null;
}

function derivarLink(nome: string | null, row: LicitacaoParaPortal): string | null {
  if (nome && SISLOG_NOME_RE.test(nome)) {
    const id = idSislog(row.numero_edital);
    if (id) return isValidHttpsUrl(`${SISLOG_DETALHE}${id}`, true, ALLOWED_ORIGEM_HOSTS);
  }
  return null;
}

export function resolverPortalOficial(row: LicitacaoParaPortal | null | undefined): PortalOficial {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const nome = texto(row?.usuario_nome) ?? texto(raw.usuario_nome) ?? texto(raw.usuarioNome);
  const fonte = texto(row?.fonte)?.toLowerCase() ?? "pncp";
  const url_pncp = parsePncpControleToUrl(texto(row?.codigo_externo));

  const origem = buildOrigemUrl(row?.link_sistema_origem ?? raw.link_sistema_origem ?? raw.linkSistemaOrigem, fonte);
  if (origem) return { nome, url: origem.url, host: origem.host, metodo: "link_origem", url_pncp };

  const derivado = row ? derivarLink(nome, row) : null;
  if (derivado) return { nome, url: derivado, host: new URL(derivado).hostname, metodo: "derivado", url_pncp };

  return { nome, url: null, host: null, metodo: "sem_link", url_pncp };
}
