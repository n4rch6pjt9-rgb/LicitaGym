import {
  fetchWithTimeout,
  parseRetryAfterMs,
  PermanentHttpError,
  RetryableHttpError,
  withRetry,
} from "../_shared/pncp/retry.ts";

/**
 * Consulta de CNPJ na BrasilAPI (spec 0017, decisão 1): GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}.
 * Formato conferido em 10/10/2026 (GET público): `situacao_cadastral` numérico (2 = ATIVA),
 * `descricao_situacao_cadastral`, `cnae_fiscal` + `cnae_fiscal_descricao`, `cnaes_secundarios[{codigo, descricao}]`.
 * Timeout de 10 s por tentativa, até 2 novas tentativas em 429/5xx/timeout/erro de conexão (Retry-After respeitado,
 * até 10 s), sem nova tentativa em 404 ou outro 4xx. Nada é gravado aqui: a resposta leva fonte e data da consulta.
 */

export const BRASILAPI_CNPJ_URL = "https://brasilapi.com.br/api/cnpj/v1/";
export const CNPJ_TIMEOUT_MS = 10_000;
export const CNPJ_TENTATIVAS = 3;
const MAX_RETRY_AFTER_CNPJ_MS = 10_000;

/** 404 da fonte: permanente (withRetry não repete), vira ErroCnpj 404 na saída. */
class CnpjNaoEncontrado extends PermanentHttpError {}

/** Erro com status HTTP para a resposta da api-tenant. */
export class ErroCnpj extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 14 dígitos com os dois dígitos verificadores (mod-11) corretos; senão null. Aceita máscara. */
export function cnpjValido(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return null;
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = [...base].reduce((s, c, i) => s + Number(c) * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(d.slice(0, 12));
  const d2 = dv(d.slice(0, 12) + d1);
  return d.endsWith(`${d1}${d2}`) ? d : null;
}

export interface ConsultaCnpj {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  situacao_cadastral: string;
  ativa: boolean;
  data_situacao_cadastral: string | null;
  cnae_principal: { codigo: number; descricao: string | null } | null;
  cnaes_secundarios: Array<{ codigo: number; descricao: string | null }>;
  endereco: {
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    municipio: string | null;
    uf: string | null;
    cep: string | null;
  };
  fonte: "BrasilAPI";
  url: string;
  consultado_em: string;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Valida o envelope da BrasilAPI; 200 não garante payload válido. */
export function lerRespostaBrasilApi(json: unknown, cnpj: string, url: string, agora: Date): ConsultaCnpj {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ErroCnpj("Resposta inválida da BrasilAPI.", 502);
  }
  const r = json as Record<string, unknown>;
  const razao = texto(r.razao_social);
  const situacao = texto(r.descricao_situacao_cadastral);
  if (String(r.cnpj ?? "").replace(/\D/g, "") !== cnpj || !razao || !situacao) {
    throw new ErroCnpj("Resposta inválida da BrasilAPI.", 502);
  }
  const cnae = typeof r.cnae_fiscal === "number" ? { codigo: r.cnae_fiscal, descricao: texto(r.cnae_fiscal_descricao) } : null;
  const secundarios = Array.isArray(r.cnaes_secundarios)
    ? (r.cnaes_secundarios as Array<Record<string, unknown>>)
      .filter((c) => typeof c?.codigo === "number" && c.codigo > 0)
      .map((c) => ({ codigo: c.codigo as number, descricao: texto(c.descricao) }))
    : [];
  return {
    cnpj,
    razao_social: razao,
    nome_fantasia: texto(r.nome_fantasia),
    situacao_cadastral: situacao.toUpperCase(),
    ativa: r.situacao_cadastral === 2 || situacao.toUpperCase() === "ATIVA",
    data_situacao_cadastral: texto(r.data_situacao_cadastral),
    cnae_principal: cnae,
    cnaes_secundarios: secundarios,
    endereco: {
      logradouro: texto(r.logradouro),
      numero: texto(r.numero),
      complemento: texto(r.complemento),
      bairro: texto(r.bairro),
      municipio: texto(r.municipio),
      uf: texto(r.uf),
      cep: texto(r.cep),
    },
    fonte: "BrasilAPI",
    url,
    consultado_em: agora.toISOString(),
  };
}

export interface OpcoesConsulta {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** `cnpj` já validado por cnpjValido. Lança ErroCnpj com o status a devolver. */
export async function consultarCnpjBrasilApi(cnpj: string, opcoes: OpcoesConsulta = {}): Promise<ConsultaCnpj> {
  const url = `${BRASILAPI_CNPJ_URL}${cnpj}`;
  let resposta: Response;
  try {
    resposta = await withRetry(async () => {
      const r = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, CNPJ_TIMEOUT_MS);
      if (r.status === 429 || r.status >= 500) {
        const espera = parseRetryAfterMs(r.headers.get("retry-after"));
        throw new RetryableHttpError(`BrasilAPI HTTP ${r.status}`, espera === null ? null : Math.min(espera, MAX_RETRY_AFTER_CNPJ_MS));
      }
      if (r.status === 404) throw new CnpjNaoEncontrado("BrasilAPI HTTP 404");
      if (!r.ok) throw new PermanentHttpError(`BrasilAPI HTTP ${r.status}`);
      return r;
    }, { maxAttempts: CNPJ_TENTATIVAS, baseDelayMs: 500, maxTimeoutRetries: CNPJ_TENTATIVAS - 1, sleep: opcoes.sleep });
  } catch (e) {
    if (e instanceof CnpjNaoEncontrado) throw new ErroCnpj("CNPJ não encontrado na fonte (BrasilAPI).", 404);
    if (e instanceof PermanentHttpError) throw new ErroCnpj("A BrasilAPI recusou a consulta.", 502);
    throw new ErroCnpj("BrasilAPI indisponível; tente de novo em alguns minutos.", 503);
  }
  let json: unknown;
  try {
    json = await resposta.json();
  } catch {
    throw new ErroCnpj("Resposta inválida da BrasilAPI.", 502);
  }
  return lerRespostaBrasilApi(json, cnpj, url, (opcoes.now ?? (() => new Date()))());
}
