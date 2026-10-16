import {
  ALLOWED_ORIGEM_HOSTS,
  buildOrigemUrl,
  isValidHttpsUrl,
  parsePncpControleToUrl,
} from "./edital-url.ts";

/**
 * Portal oficial da disputa (onde ficam sessão, chat, recursos e documentos de origem).
 *
 * Decisão de produto (15/10/2026): o PNCP é o meio, não o fim. O portal oficial informado no edital é a fonte
 * primária; o PNCP é fallback e costuma atrasar em relação ao portal. Por isso todo edital lido pelo agente
 * precisa dizer qual é o portal oficial, mesmo quando não há link público seguro para ele.
 *
 * Rota (spec do acompanhamento pelo portal, 15/10/2026):
 * 1. `link_sistema_origem` (o linkSistemaOrigem que o órgão informou ao PNCP): link validado por `buildOrigemUrl`;
 *    fora da allowlist, o host identifica o portal, sem link;
 * 2. portal mapeado derivado de identificador oficial (hoje: SISLOG/GO, página pública DetalhesLicitacao) ou o
 *    endereço do portal indicado no edital/aviso, com o trecho como evidência;
 * 3. correção manual na tela (fora deste módulo).
 * `usuario_nome` do PNCP é quem enviou a compra ao PNCP (ERP do órgão, integrador): vai em `sistema_pncp` e nunca é
 * apresentado como portal; só serve de chave do mapeamento explícito do SISLOG. Nada é inventado: sem evidência,
 * `nome` e `url` ficam null.
 */

export type MetodoPortal =
  | "link_origem"
  | "derivado"
  | "edital"
  | "nao_identificado";

export interface EvidenciaPortal {
  chunk_id: number;
  documento_id: number;
  pagina: number | null;
  trecho: string;
}

export interface PortalOficial {
  /** Portal estabelecido: host do link de origem ou do edital, ou nome do portal mapeado. null = não identificado. */
  nome: string | null;
  /** Página pública do processo no portal oficial, já validada (https + host permitido). */
  url: string | null;
  host: string | null;
  metodo: MetodoPortal;
  /** Página do edital no PNCP, quando o número de controle permite montar. */
  url_pncp: string | null;
  /** `usuario_nome` do PNCP: sistema que publicou a compra no PNCP. Não é necessariamente o portal da disputa. */
  sistema_pncp: string | null;
  /** Trecho do edital/aviso que indica o portal (só no método `edital`). */
  evidencia: EvidenciaPortal | null;
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

/** Trecho de documento do processo (mesmo formato de `licitacao_chunks`). */
export interface TrechoEdital {
  id: number;
  documento_id: number;
  pagina: number | null;
  texto: string;
}

const SISLOG_NOME = "SISLOG";
const SISLOG_NOME_RE = /\bsislog\b/i;
/** "Pregão - Eletrônico nº 114655/2025", "Dispensa nº 116918/2025": idLicitacao é o número antes do ano. */
const SISLOG_ID_RE = /n\s*[ºo°.]?\s*(\d{5,7})\s*\/\s*\d{4}\b/i;
/** Aviso/edital: "Contratação SISLOG nº 114655" (só com o tipo do número, não "Requisição nº"). */
const SISLOG_NO_TEXTO_RE =
  /\b(?:contrata[cç][aã]o|licita[cç][aã]o)\s+sislog\s+n\s*[ºo°.]?\s*(\d{5,7})\b/i;
export const SISLOG_DETALHE =
  "https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=";

/**
 * Endereço no texto, com ou sem esquema. Não casa a parte de domínio de um e-mail (lookbehind), nem um domínio
 * cortado no meio da palavra ("compras.gov.brasileiro"); caminho limitado para o trecho não crescer sem fim.
 */
const URL_NO_TEXTO_RE =
  /(?<![@\w.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:br|com|net|org)(?![a-z0-9-])(?:\/[^\s<>"'()]{0,200})?/gi;
/** A frase antes do endereço diz que a disputa acontece ali: objeto da disputa + verbo de realização. */
const OBJETO_DISPUTA_RE =
  /(sess[aã]o p[uú]blica|disputa|lances|preg[aã]o eletr[oô]nico|certame)/i;
const REALIZACAO_RE =
  /(realizad[ao]s?|ocorrer[aá]|acontecer[aá]|ser[aã]o? (efetuad|ofertad)|por meio|atrav[eé]s|mediante)/i;
/** Frase que fala de outra coisa: publicação, transparência, cadastro, consulta (o endereço não é o da disputa). */
const CONTEXTO_NAO_DISPUTA_RE =
  /(publicad|divulgad|dispon[ií]ve|transpar[eê]ncia|cadastr|sicaf|di[aá]rio oficial|consult|decreto|\blei\b|impugna|esclarec)/i;
/** Host citado que não é portal de disputa (lei, diário oficial, o próprio PNCP, judiciário, tribunal de contas). */
const HOST_NAO_PORTAL_RE =
  /(^|\.)(pncp\.gov\.br|planalto\.gov\.br|in\.gov\.br|jus\.br|receita\.fazenda\.gov\.br|tce\.[a-z]{2}\.gov\.br|tcu\.gov\.br)$/i;
/** Domínio plausível: rótulos com letra/dígito/hífen e TLD alfabético (recusa "N/A", "-", "0", IP). */
const DOMINIO_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const JANELA_CONTEXTO = 160;

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

function linkSislog(id: string): string | null {
  return isValidHttpsUrl(`${SISLOG_DETALHE}${id}`, true, ALLOWED_ORIGEM_HOSTS);
}

/**
 * Host de um link ou domínio escrito (inclusive fora da allowlist): identifica o portal sem virar link clicável.
 * Recusa lixo ("N/A", "-", "0"), e-mail/credencial, IP e outro esquema.
 */
function hostDe(valor: unknown): string | null {
  const t = texto(valor);
  if (!t) return null;
  const comEsquema = /^https?:\/\//i.test(t);
  if (!comEsquema && !DOMINIO_RE.test(t.split("/")[0])) return null;
  try {
    const u = new URL(comEsquema ? t : `https://${t}`);
    if (u.username || u.password || !DOMINIO_RE.test(u.hostname)) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function trechoEm(t: string, inicio: number, fim: number): string {
  return t.slice(Math.max(0, inicio - 120), Math.min(t.length, fim + 120));
}

/** Frase (até a pontuação anterior) que antecede o endereço fala da disputa acontecendo ali. */
function fraseDeDisputa(t: string, inicio: number): boolean {
  const antes = t.slice(Math.max(0, inicio - JANELA_CONTEXTO), inicio);
  const frase = antes.split(/[.;:](?=\s)/).pop() ?? antes;
  return OBJETO_DISPUTA_RE.test(frase) && REALIZACAO_RE.test(frase) &&
    !CONTEXTO_NAO_DISPUTA_RE.test(frase);
}

/**
 * Passo 2b da rota: portal indicado no próprio edital/aviso, com o trecho. O primeiro trecho (na ordem dos
 * documentos) com frase de disputa ganha; dentro dele, o endereço escrito com https vence o domínio solto.
 * Só vira `url` o endereço escrito com https que passa na mesma regra do linkSistemaOrigem (`buildOrigemUrl`).
 */
function portalDoEdital(chunks: readonly TrechoEdital[], fonte: string):
  | {
    nome: string;
    url: string | null;
    host: string | null;
    evidencia: EvidenciaPortal;
  }
  | null {
  for (const c of chunks) {
    const t = typeof c.texto === "string" ? c.texto : "";
    if (!t) continue;
    const evidencia = (i0: number, i1: number): EvidenciaPortal => ({
      chunk_id: c.id,
      documento_id: c.documento_id,
      pagina: c.pagina,
      trecho: trechoEm(t, i0, i1),
    });

    const sislog = SISLOG_NO_TEXTO_RE.exec(t);
    if (sislog) {
      const url = linkSislog(sislog[1]);
      if (url) {
        const fimSislog = sislog.index + sislog[0].length;
        return {
          nome: SISLOG_NOME,
          url,
          host: new URL(url).hostname,
          evidencia: evidencia(sislog.index, fimSislog),
        };
      }
    }

    let solto: { nome: string; inicio: number; fim: number } | null = null;
    for (const m of t.matchAll(URL_NO_TEXTO_RE)) {
      const bruto = m[0].replace(/[.,;:]+$/, "");
      const host = hostDe(bruto);
      if (
        !host || HOST_NAO_PORTAL_RE.test(host) || !fraseDeDisputa(t, m.index!)
      ) continue;
      const fim = m.index! + bruto.length;
      if (/^https:\/\//i.test(bruto)) {
        const origem = buildOrigemUrl(bruto, fonte);
        return {
          nome: host,
          url: origem?.url ?? null,
          host: origem?.host ?? null,
          evidencia: evidencia(m.index!, fim),
        };
      }
      solto ??= { nome: host, inicio: m.index!, fim };
    }
    if (solto) {
      return {
        nome: solto.nome,
        url: null,
        host: null,
        evidencia: evidencia(solto.inicio, solto.fim),
      };
    }
  }
  return null;
}

export function resolverPortalOficial(
  row: LicitacaoParaPortal | null | undefined,
  chunks: readonly TrechoEdital[] = [],
): PortalOficial {
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const sistema_pncp = texto(row?.usuario_nome) ?? texto(raw.usuario_nome) ??
    texto(raw.usuarioNome);
  const fonte = texto(row?.fonte)?.toLowerCase() ?? "pncp";
  const url_pncp = parsePncpControleToUrl(texto(row?.codigo_externo));
  const base = { url_pncp, sistema_pncp, evidencia: null };

  // 1. linkSistemaOrigem: link seguro, ou só o host quando fora da allowlist.
  const linkOrigem = row?.link_sistema_origem ?? raw.link_sistema_origem ??
    raw.linkSistemaOrigem;
  const origem = buildOrigemUrl(linkOrigem, fonte);
  if (origem && !HOST_NAO_PORTAL_RE.test(origem.host)) {
    return {
      ...base,
      nome: origem.host,
      url: origem.url,
      host: origem.host,
      metodo: "link_origem",
    };
  }
  const hostOrigem = hostDe(linkOrigem);
  if (hostOrigem && !HOST_NAO_PORTAL_RE.test(hostOrigem)) {
    return {
      ...base,
      nome: hostOrigem,
      url: null,
      host: null,
      metodo: "link_origem",
    };
  }

  // 2a. Portal mapeado (SISLOG): o publicador é o próprio portal e o número do edital é o idLicitacao.
  if (sistema_pncp && SISLOG_NOME_RE.test(sistema_pncp)) {
    const id = idSislog(row?.numero_edital);
    const url = id ? linkSislog(id) : null;
    if (url) {
      return {
        ...base,
        nome: SISLOG_NOME,
        url,
        host: new URL(url).hostname,
        metodo: "derivado",
      };
    }
  }

  // 2b. Endereço ou identificador do portal no edital/aviso.
  const doEdital = portalDoEdital(chunks, fonte);
  if (doEdital) return { ...base, ...doEdital, metodo: "edital" };

  return {
    ...base,
    nome: null,
    url: null,
    host: null,
    metodo: "nao_identificado",
  };
}
