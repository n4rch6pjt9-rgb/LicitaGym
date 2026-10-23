import { itemNaPosicao, trechoLimpo } from "../_shared/agentes/citacao.ts";
import type { ChunkEdital } from "../_shared/agentes/edital.ts";
import { ErroAgentes } from "./repo.ts";

/**
 * Pergunta livre ao agente de edital (spec 0038, K-1): contrato com o serviço agente-perguntas (Cloud Run), conferência
 * das citações (defesa em profundidade: o serviço já confere, a api-agentes confere de novo) e a cota do dia.
 * O serviço só recebe licitação, pergunta e k; empresa, pipeline e cota ficam aqui.
 */

/** Spec 0038 (decisão de 22/10): 50 perguntas por empresa por dia, somando os três agentes. */
export const LIMITE_PERGUNTAS_DIA = 50;
/** Chunks que o serviço busca (agente_chunks_licitacao aceita até 20). */
export const K_CHUNKS = 8;
const MAX_CITACOES = 20;
const MAX_RESPOSTA = 8000;
const TIMEOUT_MS = 60_000;

export type MotivoSemResposta = "sem_documentos" | "nao_encontrado";

/** Citação como o serviço devolve: o chunk entregue ao modelo, numerado como no texto da resposta. */
export interface CitacaoServico {
  n: number;
  chunk_id: number;
  documento_id: number;
  pagina: number | null;
  texto: string;
  /** Recorte do texto do chunk que apoia a afirmação (o Dashboard destaca). */
  apoio: string;
  /**
   * Posição do apoio no texto do chunk, em pontos de código (code points, como o índice de str do Python), não em
   * unidades UTF-16. A api-agentes converte (inicioUtf16) e confere contra o texto do banco.
   */
  apoio_inicio: number;
}

export interface RespostaServicoEdital {
  resposta: string | null;
  motivo_sem_resposta: null | "nao_encontrado";
  citacoes: CitacaoServico[];
  modelo: string;
  versao_prompt: string;
  uso: Record<string, unknown>;
}

/** Citação gravada e devolvida ao Dashboard (K-1 + K-4). Dados do chunk lidos do banco, não do serviço. */
export interface CitacaoPergunta {
  n: number;
  chunk_id: number;
  documento_id: number;
  documento_nome: string | null;
  pagina: number | null;
  /** Item/cláusula vigente na posição do apoio ("8.4.2"); null sem cabeçalho de item antes dele. */
  item: string | null;
  /** Frases inteiras em volta do apoio, até ~300 caracteres. */
  trecho_limpo: string;
  /** Recorte exato do texto do chunk que apoia a afirmação (conferido contra o banco). */
  apoio: string;
}

export interface EntradaServicoEdital {
  licitacao_id: number;
  pergunta: string;
  k: number;
}

/** Cliente do serviço agente-perguntas. Injetável (ApiAgentesContext) para os testes. */
export interface ServicoPerguntas {
  /** Devolve o corpo JSON cru (validado por validarRespostaEdital). ErroAgentes 502 em falha de rede, timeout ou não-2xx. */
  perguntarEdital(entrada: EntradaServicoEdital): Promise<unknown>;
}

const ERRO_SERVICO = "falha ao consultar o agente";

/**
 * Cliente real: POST `${AGENTE_PERGUNTAS_URL}/edital/perguntar` com `X-Agente-Segredo`. Sem as duas variáveis (ou URL
 * que não é https), 503: o serviço não está configurado. O segredo nunca vai para log nem resposta.
 */
export function criarServicoPerguntas(
  env: (nome: string) => string | undefined = (nome) => Deno.env.get(nome),
  fetchFn: typeof fetch = fetch,
): ServicoPerguntas {
  const base = env("AGENTE_PERGUNTAS_URL")?.trim().replace(/\/+$/, "");
  const segredo = env("AGENTE_PERGUNTAS_SEGREDO")?.trim();
  let url: URL | null = null;
  try {
    url = base ? new URL(`${base}/edital/perguntar`) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || !segredo) {
    throw new ErroAgentes("serviço de perguntas não configurado", 503);
  }
  const destino = url;
  return {
    async perguntarEdital(entrada) {
      let res: Response;
      try {
        res = await fetchFn(destino, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Agente-Segredo": segredo },
          body: JSON.stringify(entrada),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        console.error("[api-agentes] agente-perguntas indisponível", { erro: e instanceof Error ? e.name : "desconhecido" });
        throw new ErroAgentes(ERRO_SERVICO, 502);
      }
      if (!res.ok) {
        await res.body?.cancel();
        console.error("[api-agentes] agente-perguntas respondeu", { status: res.status });
        throw new ErroAgentes(ERRO_SERVICO, 502);
      }
      try {
        return await res.json();
      } catch {
        throw new ErroAgentes(ERRO_SERVICO, 502);
      }
    },
  };
}

const inteiroPositivo = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const objetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Formato do contrato do serviço. Fora dele (campo faltando, tipo errado, resposta e motivo juntos ou nenhum, `n`
 * repetido): null, que vira 502 sem gravar nada. HTTP 200 não basta.
 */
export function validarRespostaEdital(bruto: unknown): RespostaServicoEdital | null {
  if (!objetoSimples(bruto)) return null;
  const { resposta, motivo_sem_resposta, citacoes, modelo, versao_prompt, uso } = bruto;
  if (resposta !== null && (typeof resposta !== "string" || resposta.trim() === "" || resposta.length > MAX_RESPOSTA)) return null;
  if (motivo_sem_resposta !== null && motivo_sem_resposta !== "nao_encontrado") return null;
  if ((resposta === null) === (motivo_sem_resposta === null)) return null;
  if (!Array.isArray(citacoes) || citacoes.length > MAX_CITACOES) return null;
  if (typeof modelo !== "string" || modelo.trim() === "" || typeof versao_prompt !== "string" || versao_prompt.trim() === "") return null;
  if (!objetoSimples(uso)) return null;
  const vistos = new Set<number>();
  const lista: CitacaoServico[] = [];
  for (const c of citacoes) {
    if (!objetoSimples(c)) return null;
    if (!inteiroPositivo(c.n) || !inteiroPositivo(c.chunk_id) || !inteiroPositivo(c.documento_id)) return null;
    if (c.pagina !== null && !inteiroPositivo(c.pagina)) return null;
    if (typeof c.texto !== "string") return null;
    if (typeof c.apoio !== "string" || c.apoio.trim() === "") return null;
    if (typeof c.apoio_inicio !== "number" || !Number.isInteger(c.apoio_inicio) || c.apoio_inicio < 0) return null;
    if (vistos.has(c.n)) return null;
    vistos.add(c.n);
    lista.push({
      n: c.n, chunk_id: c.chunk_id, documento_id: c.documento_id, pagina: c.pagina, texto: c.texto, apoio: c.apoio,
      apoio_inicio: c.apoio_inicio,
    });
  }
  return {
    resposta: resposta as string | null,
    motivo_sem_resposta: motivo_sem_resposta as null | "nao_encontrado",
    citacoes: lista,
    modelo,
    versao_prompt,
    uso,
  };
}

/**
 * Converte uma posição em pontos de código (contrato do serviço Python) para o índice UTF-16 do JavaScript.
 * null se a posição passa do número de pontos de código do texto. Ex.: em "📌 8.2 A…", o "A" é 6 em pontos de código
 * e 7 em UTF-16 (o emoji ocupa duas unidades).
 */
export function inicioUtf16(texto: string, inicioCodePoints: number): number | null {
  const pontos = Array.from(texto);
  if (inicioCodePoints > pontos.length) return null;
  return pontos.slice(0, inicioCodePoints).join("").length;
}

/** Marcador de citação, igual ao do serviço Python: "[1]", "[2, 5]". */
const RE_MARCADOR = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/**
 * Números citados nos marcadores do texto ("[1] e [2, 5]" → 1, 2, 5). null quando sobra no texto um "[" seguido de
 * dígito fora do formato ("[1-3]", "[12a]", "[1"): marcador que não se confere não passa.
 */
export function marcadores(resposta: string): Set<number> | null {
  const numeros = new Set<number>();
  for (const m of resposta.matchAll(RE_MARCADOR)) {
    for (const n of m[1].split(",")) numeros.add(Number(n.trim()));
  }
  if (/\[\s*\d/.test(resposta.replace(RE_MARCADOR, ""))) return null;
  return numeros;
}

/**
 * Defesa em profundidade (K-1): a resposta só vale se tem ao menos um [n], todo [n] existe nas citações, toda citação
 * aponta para um chunk desta licitação (`chunks`, lidos do banco) e o apoio de cada uma está no texto do banco na
 * posição informada (`apoio_inicio` em pontos de código, convertido para UTF-16 antes de conferir). Senão, "não encontrei no edital": a resposta não é exibida. As citações saem só as marcadas no
 * texto, em ordem de n, com documento, página e texto do banco; item e trecho limpo saem da posição do apoio.
 */
export function conferirCitacoes(
  r: RespostaServicoEdital,
  chunks: Map<number, ChunkEdital>,
  nomes: Map<number, string>,
): { resposta: string; citacoes: CitacaoPergunta[] } | null {
  if (r.resposta === null) return null;
  const usados = marcadores(r.resposta);
  if (usados === null || usados.size === 0) return null;
  const porN = new Map(r.citacoes.map((c) => [c.n, c]));
  for (const n of usados) if (!porN.has(n)) return null;
  const inicios = new Map<number, number>();
  for (const c of r.citacoes) {
    const chunk = chunks.get(c.chunk_id);
    if (!chunk) return null;
    const inicio = inicioUtf16(chunk.texto, c.apoio_inicio);
    if (inicio === null || chunk.texto.slice(inicio, inicio + c.apoio.length) !== c.apoio) return null;
    inicios.set(c.n, inicio);
  }
  const citacoes = [...usados].sort((a, b) => a - b).map((n): CitacaoPergunta => {
    const c = porN.get(n)!;
    const chunk = chunks.get(c.chunk_id)!;
    return {
      n,
      chunk_id: chunk.id,
      documento_id: chunk.documento_id,
      documento_nome: nomes.get(chunk.documento_id) ?? null,
      pagina: chunk.pagina,
      item: itemNaPosicao(chunk.texto, inicios.get(n)!),
      trecho_limpo: trechoLimpo(chunk.texto, 300, { inicio: inicios.get(n)!, texto: c.apoio }),
      apoio: c.apoio,
    };
  });
  return { resposta: r.resposta, citacoes };
}

/** Dia de hoje em America/Sao_Paulo ("2026-10-22"), chave da cota do dia (agente_cota_dia, CA-12). */
export function diaSaoPaulo(agora: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const ler = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${ler("year")}-${ler("month")}-${ler("day")}`;
}
