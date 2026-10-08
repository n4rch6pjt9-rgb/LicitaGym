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
 * 2. Compras.gov.br (`comprasnet` / `comprasgov` / `compras_gov` / `compras` / `comprasgov_pesquisa_preco`):
 *    - `idCompra` (17 dígitos, `UUUUUUMMNNNNNYYYY`) vindo de `codigo_externo` com prefixo `COMPRASGOV-PP-`
 *      ou de `raw.idCompra` / `raw.id_compra` como string: monta URL de acompanhamento
 *      (`https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra={idCompra}`, rota a confirmar).
 *    - `id_externo` não é usado: é `int` e guarda o `nCdProcesso` do SEST SENAT.
 *    - Fallback: se houver `linkSistemaOrigem` ou `url`: valida protocolo https.
 * 3. SEST SENAT (`sestsenat` / `sest_senat`):
 *    - Portal Paradigma em `https://compras.sestsenat.org.br/portal/`.
 *    - Se houver `linkSistemaOrigem` https válido, usa-o; sem ele retorna null (não há rota pública por `id_externo`).
 * 4. Genérica / outras fontes:
 *    - Se houver `linkSistemaOrigem` (ou `url_edital`, `url` em colunas/raw): aceita se for https e host em `ALLOWED_ORIGEM_HOSTS`.
 *
 * Regras de Segurança:
 * - Apenas protocolo `https://`.
 * - Hosts conhecidos autorizados para URLs construídas: `pncp.gov.br`, `compras.gov.br`, `cnetmobile.estaleiro.serpro.gov.br`.
 * - Para o domínio vindo de `linkSistemaOrigem` (dado coletado de terceiros), aceita somente https
 *   e host em `ALLOWED_ORIGEM_HOSTS`: qualquer `*.gov.br` e os portais Paradigma do Sistema S.
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
 * Portais Paradigma do Sistema S: um host por entidade de `FONTES` em
 * services/coletor-externo/coletor/paradigma.py (teste garante que a lista acompanha o coletor).
 * Os hosts SaaS `*.paradigmabs.com.br` são compartilhados entre clientes do Paradigma: o cliente é o primeiro
 * segmento do caminho. Neles só vale o host exato + um tenant de `PARADIGMA_SAAS_TENANTS`.
 */
export const PARADIGMA_HOSTS = [
  "compras.sestsenat.org.br",
  "portaldecompras.fiesc.com.br",
  "portaldecompras.firjan.com.br",
  "compras.sistemafiergs.org.br",
  "portaldecompras.findes.org.br",
  "compras.fieb.org.br",
  "compras.fiems.com.br",
  "compras.sfiemt.ind.br",
  "portaldecompras.sfiec.org.br",
  "compras.fiemg.com.br",
] as const;

/** Host SaaS -> tenant (1º segmento do caminho, minúsculo) -> `fonte` do coletor Paradigma. */
export const PARADIGMA_SAAS_TENANTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "scr360.paradigmabs.com.br": { sescsp: "sescsp" },
  "egov.paradigmabs.com.br": { sesc_senac_rs: "sesc_senac_rs", sescrj: "sescrj", sescba: "sescba" },
  "egov-br.paradigmabs.com.br": { sescdn: "sescdn" },
};

export const ALLOWED_ORIGEM_HOSTS = new Set([
  ...ALLOWED_STATIC_HOSTS,
  "gov.br",
  ...PARADIGMA_HOSTS,
  ...Object.keys(PARADIGMA_SAAS_TENANTS),
]);

/** Domínio dos hosts SaaS compartilhados do Paradigma. */
const PARADIGMA_SAAS_DOMINIO = "paradigmabs.com.br";

/**
 * Fonte Paradigma dona de uma URL em host SaaS compartilhado, ou null se não for host SaaS.
 * Host SaaS desconhecido, subdomínio de host SaaS ou tenant fora da lista -> "" (recusar).
 */
function tenantParadigmaSaas(parsed: URL): string | null {
  const host = parsed.hostname.toLowerCase();
  if (host !== PARADIGMA_SAAS_DOMINIO && !host.endsWith(`.${PARADIGMA_SAAS_DOMINIO}`)) return null;
  const tenants = PARADIGMA_SAAS_TENANTS[host];
  if (!tenants) return "";
  const tenant = parsed.pathname.split("/")[1]?.toLowerCase() ?? "";
  return tenants[tenant] ?? "";
}

/** Compra/edital estendido PNCP: `{CNPJ14}-{tipo}-{seqPad}/{ano}` */
const PNCP_CONTROLE_EXTENDED_RE = /^(\d{14})-(\d+)-(\d+)\/(\d{4})$/;

/** Compra/edital legado PNCP: `{CNPJ14}-{seqPad}/{ano}` */
const PNCP_CONTROLE_SIMPLE_RE = /^(\d{14})-(\d+)\/(\d{4})$/;

const COMPRASGOV_FONTES = new Set([
  "comprasnet",
  "comprasgov",
  "compras_gov",
  "compras",
  "comprasgov_pesquisa_preco",
]);

/** idCompra do Compras.gov: UASG(6) + modalidade(2) + número(5) + ano(4) */
const COMPRASGOV_ID_COMPRA_RE = /^\d{17}$/;

/** Prefixo de `codigo_externo` gravado pela carga da pesquisa de preços. */
const COMPRASGOV_CODIGO_EXTERNO_PREFIX = "COMPRASGOV-PP-";

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
 * Em host SaaS compartilhado do Paradigma, o modo restrito exige host exato + tenant de `PARADIGMA_SAAS_TENANTS`.
 */
export function isValidHttpsUrl(
  rawUrl: unknown,
  allowedHostsOnly = false,
  allowedHosts: ReadonlySet<string> = ALLOWED_STATIC_HOSTS,
): string | null {
  const parsed = parseHttpsUrl(rawUrl, allowedHostsOnly, allowedHosts);
  return parsed ? parsed.toString() : null;
}

function parseHttpsUrl(
  rawUrl: unknown,
  allowedHostsOnly: boolean,
  allowedHosts: ReadonlySet<string>,
): URL | null {
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
      if (tenantParadigmaSaas(parsed) === "") return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Link vindo da origem (dado de terceiros): https, host de `ALLOWED_ORIGEM_HOSTS` e, em host SaaS do
 * Paradigma, tenant da própria `fonte` da linha (link do Sesc RJ não vale numa linha de outra fonte).
 */
function validarLinkOrigem(rawUrl: unknown, fonte: string): string | null {
  const parsed = parseHttpsUrl(rawUrl, true, ALLOWED_ORIGEM_HOSTS);
  if (!parsed) return null;
  const donoSaas = tenantParadigmaSaas(parsed);
  if (donoSaas !== null && donoSaas !== fonte) return null;
  return parsed.toString();
}

/** Host do Compras.gov.br (Comprasnet) usado no acompanhamento público da compra. */
const COMPRASNET_HOST = "cnetmobile.estaleiro.serpro.gov.br";

/**
 * Constrói a url_acompanhamento para o Comprasnet a partir de linkSistemaOrigem.
 * Revalida: protocolo https, host exato cnetmobile.estaleiro.serpro.gov.br e
 * parâmetro compra com exatamente 17 dígitos (UASG 6 + Mod 2 + Num 5 + Ano 4).
 */
export function buildAcompanhamentoUrl(linkSistemaOrigem: unknown): string | null {
  if (typeof linkSistemaOrigem !== "string") return null;
  const trimmed = linkSistemaOrigem.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== COMPRASNET_HOST) return null;

    const idCompra = parsed.searchParams.get("compra");
    if (!idCompra || !/^\d{17}$/.test(idCompra.trim())) return null;

    return `https://${COMPRASNET_HOST}/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=${idCompra.trim()}`;
  } catch {
    return null;
  }
}

/** Link do portal onde a disputa acontece, já validado, e o host para rotular o botão. */
export interface OrigemUrl {
  url: string;
  host: string;
}

/**
 * Link do portal de origem da disputa (`licitacoes_externas.link_sistema_origem`, o linkSistemaOrigem que o
 * órgão informou ao PNCP). O PNCP não monta esse link: só repassa. Aqui ele é dado de terceiros, então:
 * - Comprasnet: reescrito para a página pública de acompanhamento (`buildAcompanhamentoUrl`);
 * - demais: aceito como veio, só se https e host em `ALLOWED_ORIGEM_HOSTS` (mesma regra de `buildEditalUrl`).
 * Retorna null para link ausente, http sem TLS, sem esquema ou host fora da lista: a tela mostra só o PNCP.
 */
export function buildOrigemUrl(linkSistemaOrigem: unknown, fonte: unknown = "pncp"): OrigemUrl | null {
  const url = buildAcompanhamentoUrl(linkSistemaOrigem) ??
    validarLinkOrigem(linkSistemaOrigem, String(fonte ?? "").trim().toLowerCase());
  if (!url) return null;
  return { url, host: new URL(url).hostname.toLowerCase() };
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
 * Extrai o idCompra (17 dígitos) de uma linha do Compras.gov.
 * `codigo_externo` vem primeiro por ser coluna projetada pelas Edge Functions (`raw` não é).
 * Só aceita string: 17 dígitos passam de Number.MAX_SAFE_INTEGER e perderiam precisão como number.
 */
function extractComprasGovIdCompra(row: LicitacaoRowForEdital, raw: Record<string, unknown>): string | null {
  const candidates: unknown[] = [];
  if (typeof row.codigo_externo === "string" && row.codigo_externo.startsWith(COMPRASGOV_CODIGO_EXTERNO_PREFIX)) {
    candidates.push(row.codigo_externo.slice(COMPRASGOV_CODIGO_EXTERNO_PREFIX.length));
  }
  candidates.push(raw.idCompra, raw.id_compra, raw.compra);

  for (const cand of candidates) {
    if (typeof cand !== "string") continue;
    const val = cand.trim();
    if (COMPRASGOV_ID_COMPRA_RE.test(val)) return val;
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
  const validOrigemUrl = validarLinkOrigem(rawLinkSistemaOrigem, fonte);

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

  if (COMPRASGOV_FONTES.has(fonte)) {
    const idCompra = extractComprasGovIdCompra(row, raw);
    if (idCompra) {
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
