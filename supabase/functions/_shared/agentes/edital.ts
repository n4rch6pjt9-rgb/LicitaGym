import { normalizarComMapa } from "./achados.ts";
import { REGRA_VERSAO, type Achado, type Fonte, type ResultadoAgente, type Severidade } from "./tipos.ts";

export interface ChunkEdital {
  id: number;
  documento_id: number;
  pagina: number | null;
  texto: string;
}

const PADROES: { codigo: string; re: RegExp; severidade: Severidade }[] = [
  { codigo: "exigencia.amostra", re: /\bamostras?\b/, severidade: "atencao" },
  { codigo: "exigencia.visita_tecnica", re: /\b(visita|vistoria) tecnica\b/, severidade: "atencao" },
  { codigo: "exigencia.atestado_capacidade", re: /\batestados? de capacidade tecnica\b/, severidade: "atencao" },
  { codigo: "exigencia.garantia_proposta", re: /\bgarantia d[ae] proposta\b/, severidade: "atencao" },
  { codigo: "exigencia.garantia_contratual", re: /\bgarantia (contratual|de execucao)\b/, severidade: "info" },
  { codigo: "exigencia.laudo_certificacao", re: /\b(laudo|certificado|certificacao)\b[^.]{0,120}\b(inmetro|abnt|nbr)\b/, severidade: "atencao" },
  { codigo: "exigencia.marca_modelo", re: /\bmarca\b[^.]{0,40}\b(modelo|referencia)\b/, severidade: "atencao" },
  { codigo: "exigencia.prazo_entrega", re: /\bprazo (maximo )?(de|para) entrega\b/, severidade: "info" },
];

function dataLocal(iso: string): { y: number; m: number; d: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const ler = (tipo: Intl.DateTimeFormatPartTypes) => Number(partes.find((p) => p.type === tipo)?.value);
  return { y: ler("year"), m: ler("month"), d: ler("day") };
}

function isoData(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function limiteImpugnacao(dataAberturaIso: string): string {
  const { y, m, d } = dataLocal(dataAberturaIso);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  let restantes = 3;
  while (restantes > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dia = cursor.getUTCDay();
    if (dia !== 0 && dia !== 6) restantes--;
  }
  return isoData(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
}

function trechoNoOriginal(original: string, normInicio: number, normFim: number, origem: number[]): string {
  const i0 = origem[normInicio];
  const i1 = origem[normFim - 1];
  if (i0 === undefined || i1 === undefined) return original.slice(0, 240);
  const a = Math.max(0, i0 - 120);
  const b = Math.min(original.length, i1 + 1 + 120);
  return original.slice(a, b);
}

export function detectarExigencias(chunks: ChunkEdital[]): Achado[] {
  const fontes = new Map<string, { severidade: Severidade; fontes: Fonte[] }>();
  for (const chunk of chunks) {
    const { norm, origem } = normalizarComMapa(chunk.texto);
    for (const padrao of PADROES) {
      const casa = padrao.re.exec(norm);
      if (!casa || casa.index === undefined) continue;
      const grupo = fontes.get(padrao.codigo) ?? { severidade: padrao.severidade, fontes: [] };
      if (grupo.fontes.length < 3) {
        grupo.fontes.push({
          tipo: "chunk",
          chunk_id: chunk.id,
          documento_id: chunk.documento_id,
          pagina: chunk.pagina,
          trecho: trechoNoOriginal(chunk.texto, casa.index, casa.index + casa[0].length, origem),
        });
      }
      fontes.set(padrao.codigo, grupo);
    }
  }
  return [...fontes.entries()].map(([codigo, grupo]) => ({
    codigo,
    natureza: "fato" as const,
    metodo: "regra" as const,
    severidade: grupo.severidade,
    titulo: codigo,
    detalhe: "Exigência localizada no edital.",
    dados: {},
    fontes: grupo.fontes,
  }));
}

export function agenteEdital(entrada: { chunks: ChunkEdital[]; data_abertura: string | null }): ResultadoAgente {
  const achados = entrada.chunks.length === 0 ? [] : detectarExigencias(entrada.chunks);
  if (entrada.data_abertura) {
    const local = dataLocal(entrada.data_abertura);
    achados.push({
      codigo: "prazo.impugnacao",
      natureza: "analise",
      metodo: "regra",
      severidade: "atencao",
      titulo: "prazo.impugnacao",
      detalhe: "Limite de impugnação: 3 dias úteis antes da abertura, sem calendário de feriados.",
      dados: {
        data_limite: limiteImpugnacao(entrada.data_abertura),
        data_abertura: isoData(local.y, local.m, local.d),
        feriados_considerados: false,
      },
      fontes: [{ tipo: "calculo", regra: "lei_14133_art_164_3_dias_uteis", versao: REGRA_VERSAO }],
    });
  }
  return {
    agente: "edital",
    situacao: entrada.chunks.length === 0 ? "sem_documento" : "ok",
    achados,
    regra_versao: REGRA_VERSAO,
  };
}
