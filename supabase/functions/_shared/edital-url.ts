/**
 * Função pura e segura para derivação de url_edital a partir dos dados de licitacoes_externas.
 *
 * Fontes suportadas:
 * 1. PNCP (`pncp`):
 *    - Se `codigo_externo` ou `raw.numero_controle_pncp` estiver no padrão `{cnpj}-{tipo}-{sequencial}/{ano}`:
 *      monta `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}` (sequencial como número inteiro).
 *    - Se possuir `orgao_cnpj` e `ano` + `numero_sequencial` (em raw ou derivados):
 *      monta `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}`.
 *    - Fallback: se `linkSistemaOrigem` ou `raw.linkSistemaOrigem` estiver presente e for https válido.
 * 2. Compras.gov.br (`comprasnet` / `comprasgov` / `compras_gov` / `compras`):
 *    - Se houver `idCompra` / `id_compra` ou `codigoUasg` + `numeroCompra`:
 *      monta URL canônica do Compras.gov (`https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra={idCompra}`).
 *    - Fallback: se houver `linkSistemaOrigem` ou `url`: valida protocolo https.
 * 3. SEST SENAT (`sestsenat` / `sest_senat`):
 *    - Portal Paradigma em `https://compras.sestsenat.org.br/portal/`.
 *    - Se houver `linkSistemaOrigem` https válido, usa-o.
 *    - Se houver `id_externo` (nCdProcesso), direciona para o portal público do SEST SENAT.
 * 4. Genérica / outras fontes:
 *    - Se houver `linkSistemaOrigem` (ou `url_edital`, `url` em colunas/raw): aceita se for https e host em `ALLOWED_ORIGEM_HOSTS`.
 *
 * Regras de Segurança:
 * - Apenas protocolo `https://`.
 * - Hosts conhecidos autorizados para URLs construídas: `pncp.gov.br`, `compras.gov.br`, `cnetmobile.estaleiro.serpro.gov.br`.
 * - Para o domínio vindo de `linkSistemaOrigem` (dado coletado de terceiros), aceita somente https
 *   e host em `ALLOWED_ORIGEM_HOSTS`: qualquer `*.gov.br` e o portal do SEST SENAT.
 * - Retorna null quando não for possível construir URL válida ou segura.
 */

export const ALLOWED_STATIC_HOSTS = new Set([
  "pncp.gov.br",
  "www.pncp.gov.br",
  "compras.gov.br",
  "www.compras.gov.br",
  "cnetmobile.estaleiro.serpro.gov.br",
]);

/**
 * Hosts aceitos para links vindos da origem (`linkSistemaOrigem`, `url_edital`, `url`).
 * `gov.br` cobre portais federais, estaduais e municipais (registro restrito a órgãos públicos).
 */
export const ALLOWED_ORIGEM_HOSTS = new Set([
  ...ALLOWED_STATIC_HOSTS,
  "gov.br",
  "compras.sestsenat.org.br",
]);

/** Compra/edital estendido PNCP: `{CNPJ14}-{tipo}-{seqPad}/{ano}` */
const PNCP_CONTROLE_EXTENDED_RE = /^(\d{14})-(\d+)-(\d+)\/(\d{4})$/;

/** Compra/edital legado PNCP: `{CNPJ14}-{seqPad}/{ano}` */
const PNCP_CONTROLE_SIMPLE_RE = /^(\d{14})-(\d+)\/(\d{4})$/;

export interface LicitacaoRowForEdital {
  fonte?: string | null;
  modulo?: number | string | null;
  id_externo?: number | string | null;
  codigo_externo?: string | null;
  numero_processo?: string | null;
  numero_edital?: string | null;
  orgao_cnpj?: string | null;
  linkSistemaOrigem?: string | null;
  url_edital?: string | null;
  raw?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Valida se uma string é uma URL https válida.
 * Se allowedHostsOnly=true, restringe aos hosts de `allowedHosts` (e seus subdomínios).
 * Se allowedHostsOnly=false, aceita qualquer domínio válido desde que seja protocolo HTTPS.
 */
export function isValidHttpsUrl(
  rawUrl: unknown,
  allowedHostsOnly = false,
  allowedHosts: ReadonlySet<string> = ALLOWED_STATIC_HOSTS,
): string | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname || hostname.includes(" ")) return null;

    if (allowedHostsOnly) {
      const isAllowed = allowedHosts.has(hostname) ||
        Array.from(allowedHosts).some((h) => hostname.endsWith(`.${h}`));
      if (!isAllowed) return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Normaliza CNPJ removendo caracteres não numéricos.
 */
function cleanDigits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Monta URL canônica do PNCP para edital a partir de CNPJ, ano e sequencial.
 */
export function buildPncpEditalUrl(cnpj: string, ano: number | string, sequencial: number | string): string | null {
  const cnpjClean = cleanDigits(cnpj);
  const anoNum = Number(ano);
  const seqNum = Number(sequencial);

  if (cnpjClean.length !== 14 || !Number.isInteger(anoNum) || anoNum <= 1900 || !Number.isInteger(seqNum) || seqNum <= 0) {
    return null;
  }

  return `https://pncp.gov.br/app/editais/${cnpjClean}/${anoNum}/${seqNum}`;
}

/**
 * Tenta parsear numero_controle_pncp e construir a URL oficial do PNCP.
 */
export function parsePncpControleToUrl(controle: unknown): string | null {
  if (typeof controle !== "string") return null;
  const val = controle.trim();

  const mExt = val.match(PNCP_CONTROLE_EXTENDED_RE);
  if (mExt) {
    const cnpj = mExt[1];
    const seq = parseInt(mExt[3], 10);
    const ano = parseInt(mExt[4], 10);
    return buildPncpEditalUrl(cnpj, ano, seq);
  }

  const mSim = val.match(PNCP_CONTROLE_SIMPLE_RE);
  if (mSim) {
    const cnpj = mSim[1];
    const seq = parseInt(mSim[2], 10);
    const ano = parseInt(mSim[3], 10);
    return buildPncpEditalUrl(cnpj, ano, seq);
  }

  return null;
}

/**
 * Constrói a URL do edital para uma linha de licitação.
 * Retorna null se nenhuma URL segura/válida puder ser derivada.
 */
export function buildEditalUrl(row: LicitacaoRowForEdital | null | undefined): string | null {
  if (!row || typeof row !== "object") return null;

  const raw = (row.raw && typeof row.raw === "object") ? row.raw : {};
  const fonte = String(row.fonte ?? raw.fonte ?? "").trim().toLowerCase();

  // 1. Verifica se já existe um linkSistemaOrigem explícito na linha ou no raw
  const rawLinkSistemaOrigem = row.linkSistemaOrigem ??
    raw.linkSistemaOrigem ??
    raw.link_sistema_origem ??
    raw.url_edital ??
    row.url_edital;

  // Link vindo da origem é dado de terceiros: só https e host da allowlist de origem
  const validOrigemUrl = isValidHttpsUrl(rawLinkSistemaOrigem, true, ALLOWED_ORIGEM_HOSTS);

  // 2. Tratamento específico por fonte
  if (fonte === "pncp") {
    // 2.1 Pelo codigo_externo ou campos raw do PNCP
    const controleCandidates = [
      row.codigo_externo,
      raw.numero_controle_pncp,
      raw.numeroControlePNCP,
      raw.numeroControlePncp,
      raw.numeroControlePNCPCompra,
      raw.numeroControlePncpCompra,
    ];

    for (const cand of controleCandidates) {
      const urlFromControle = parsePncpControleToUrl(cand);
      if (urlFromControle) return urlFromControle;
    }

    // 2.2 Por CNPJ + ano + sequencial
    const cnpj = row.orgao_cnpj ?? raw.orgao_cnpj ?? raw.cnpjOrgao ?? (raw.orgaoEntidade as Record<string, unknown>)?.cnpj;
    const ano = raw.ano ?? raw.anoCompra;
    const seq = raw.numero_sequencial ?? raw.sequencial ?? raw.sequencialCompra;

    if (cnpj && ano && seq) {
      const url = buildPncpEditalUrl(String(cnpj), Number(ano), Number(seq));
      if (url) return url;
    }

    // 2.3 Fallback para linkSistemaOrigem se presente e https
    if (validOrigemUrl) {
      return validOrigemUrl;
    }

    return null;
  }

  if (fonte === "comprasnet" || fonte === "comprasgov" || fonte === "compras_gov" || fonte === "compras") {
    // Compras.gov.br
    // Se houver idCompra / compra
    const idCompra = raw.idCompra ?? raw.id_compra ?? raw.compra ?? row.id_externo;
    if (idCompra && (typeof idCompra === "number" || /^\d+$/.test(String(idCompra)))) {
      return `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${idCompra}`;
    }

    // Se houver linkSistemaOrigem https
    if (validOrigemUrl) {
      return validOrigemUrl;
    }

    return null;
  }

  if (fonte === "sestsenat" || fonte === "sest_senat") {
    // SEST SENAT (Portal Paradigma)
    // Se houver linkSistemaOrigem https
    if (validOrigemUrl) {
      return validOrigemUrl;
    }

    return null;
  }

  // Outras fontes ou fonte não informada
  // 1. Tenta parsear como PNCP se tiver formato PNCP no codigo_externo
  if (row.codigo_externo) {
    const pncpUrl = parsePncpControleToUrl(row.codigo_externo);
    if (pncpUrl) return pncpUrl;
  }

  // 2. Se tiver linkSistemaOrigem https válido
  if (validOrigemUrl) {
    return validOrigemUrl;
  }

  return null;
}
