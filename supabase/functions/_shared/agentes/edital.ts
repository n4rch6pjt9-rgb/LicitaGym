import { normalizarComMapa } from "./achados.ts";
import type { PortalOficial } from "../portal-oficial.ts";
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

// --- Potência do motor no termo de referência (spec 0032, fase 3, CA-4) -------------------------------------------
// O CATMAT 373980 diz "potência motor 3/5 HP" e muitos termos copiam ("entre 3 a 5 HP"): não diz se é contínua ou de
// pico. Regra de mercado informada pelo Marcelo (19/10): pico ≈ 2 × contínuo. Estudo de 7 editais do mesmo CATMAT: o
// termo que fecha contínuo + pico homologou R$ 18–58 mil; o que copia "3/5 HP", R$ 7–8 mil (residencial).

const RE_HP = /(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?)\s*)?(hpm|hpp|hp|cv)\b/g;
const RE_FAIXA_ANTES = /(entre|de)\s+(\d+(?:[.,]\d+)?)\s+(a|ate|e)\s+$/;
const RE_CONTINUO = /\b(continu[ao]|nominal|real|rms)\b/;

function numero(s: string): number {
  return Number(s.replace(",", "."));
}

type TipoPotencia = "continua" | "pico" | "faixa" | "sem_tipo";

/** Classifica cada menção "N HP" pelo que está colado a ela. "corrente contínua" (motor DC) não é potência contínua. */
function mencoesPotencia(norm: string): { tipo: TipoPotencia; hp: number; inicio: number; fim: number }[] {
  const saida: { tipo: TipoPotencia; hp: number; inicio: number; fim: number }[] = [];
  for (const m of norm.matchAll(RE_HP)) {
    const inicio = m.index ?? 0;
    const fim = inicio + m[0].length;
    const antes = norm.slice(Math.max(0, inicio - 40), inicio).replaceAll("corrente continua", "");
    const depois = norm.slice(fim, fim + 25).replaceAll("corrente continua", "");
    const hp = numero(m[1]);
    // "4.0 hp (8.0 hp de pico)": o primeiro é o contínuo.
    if (/^\s*\(\s*\d+(?:[.,]\d+)?\s*hp\s*(de )?pico/.test(norm.slice(fim, fim + 30))) {
      saida.push({ tipo: "continua", hp, inicio, fim });
      continue;
    }
    // O qualificador colado antes do número vale mais que o que vem depois ("nominal de 4,0 hp, com pico de 8 hp").
    if (/(nominal|continua|real)\s*(de\s*)?$/.test(antes) || /potencia (nominal|continua|real)( minima)?( de)?\s*$/.test(antes)) {
      saida.push({ tipo: "continua", hp, inicio, fim });
      continue;
    }
    if (m[3] === "hpm" || m[3] === "hpp" || /(pico|peak)\s*(de\s*)?$/.test(antes) ||
      /^\s*\(?\s*(de\s+)?(pico|peak|potencia maxima)\b/.test(depois)) {
      saida.push({ tipo: "pico", hp, inicio, fim });
      continue;
    }
    if (RE_CONTINUO.test(depois.slice(0, 15))) {
      saida.push({ tipo: "continua", hp, inicio, fim });
      continue;
    }
    if (m[2] !== undefined || RE_FAIXA_ANTES.test(antes)) {
      saida.push({ tipo: "faixa", hp, inicio, fim });
      continue;
    }
    saida.push({ tipo: "sem_tipo", hp, inicio, fim });
  }
  return saida;
}

/** Sinais de uso profissional no mesmo trecho: palavra, motor AC ou usuário acima de 150 kg. */
function perfilProfissional(norm: string): string[] {
  const perfil: string[] = [];
  if (/\bprofissiona(l|is)\b|\buso (continuo|intenso|comercial)\b|\bacademias?\b/.test(norm)) perfil.push("profissional");
  if (/corrente alternada|\bmotor (c\.?a\.?|ac)\b|\(ac\)/.test(norm)) perfil.push("motor_ac");
  const pesos = [...norm.matchAll(/(\d{3})\s*kg/g)].map((x) => Number(x[1])).filter((n) => n > 150 && n <= 300);
  if (pesos.length) perfil.push(`peso_usuario_${Math.min(...pesos)}kg`);
  return perfil;
}

export function detectarPotencia(chunks: ChunkEdital[]): Achado[] {
  const grupos = new Map<string, Achado>();
  const juntar = (a: Achado) => {
    const g = grupos.get(a.codigo);
    if (!g) grupos.set(a.codigo, a);
    else if (g.fontes.length < 3) g.fontes.push(...a.fontes);
  };
  for (const chunk of chunks) {
    const { norm, origem } = normalizarComMapa(chunk.texto);
    const mencoes = mencoesPotencia(norm);
    if (mencoes.length === 0) continue;
    // Contínuo informado em qualquer ponto do trecho fecha a questão para o trecho.
    if (mencoes.some((m) => m.tipo === "continua")) continue;
    // "Potência do motor 2 a 3 HP ... potência de pico 4 a 6 HP": o número menor sem tipo, ao lado de um pico maior,
    // é o contínuo.
    const picos = mencoes.filter((m) => m.tipo === "pico");
    if (picos.length && mencoes.some((m) => m.tipo !== "pico" && picos.some((p) => p.hp > m.hp))) continue;
    const fonte = (m: { inicio: number; fim: number }) => ({
      tipo: "chunk" as const,
      chunk_id: chunk.id,
      documento_id: chunk.documento_id,
      pagina: chunk.pagina,
      trecho: trechoNoOriginal(chunk.texto, m.inicio, m.fim, origem),
    });
    const pico = mencoes.find((m) => m.tipo === "pico");
    const faixa = mencoes.find((m) => m.tipo === "faixa");
    if (pico) {
      juntar({
        codigo: "especificacao.potencia_so_pico",
        natureza: "fato",
        metodo: "regra",
        severidade: "info",
        titulo: "especificacao.potencia_so_pico",
        detalhe: "O termo informa só a potência de pico do motor, não a contínua.",
        dados: { pico_hp: pico.hp },
        fontes: [fonte(pico)],
      });
    }
    if (faixa && !pico) {
      juntar({
        codigo: "especificacao.potencia_faixa_ambigua",
        natureza: "fato",
        metodo: "regra",
        severidade: "atencao",
        titulo: "especificacao.potencia_faixa_ambigua",
        detalhe: "Potência em faixa (ex.: \"3/5 HP\", \"entre 3 a 5 HP\") sem dizer se é contínua ou de pico.",
        dados: { hp: faixa.hp },
        fontes: [fonte(faixa)],
      });
    }
    // Perfil só ao redor da menção: o trecho indexado pode ter vários itens (esteira residencial ao lado de um aparelho
    // "profissional").
    const ref = pico ?? faixa;
    const perfil = ref ? perfilProfissional(norm.slice(Math.max(0, ref.inicio - 400), ref.fim + 400)) : [];
    const fraca = pico ?? faixa;
    if (fraca && perfil.length > 0) {
      const picoHp = pico ? pico.hp : null;
      juntar({
        codigo: "especificacao.inconsistente",
        natureza: "inferencia",
        metodo: "regra",
        severidade: "atencao",
        titulo: "especificacao.inconsistente",
        detalhe: "Perfil de uso profissional com potência só de pico ou em faixa: um motor residencial atende o texto. " +
          "Contínuo estimado pela regra de mercado (pico ≈ 2 × contínuo), não pelo edital.",
        dados: {
          pico_hp: picoHp,
          continuo_estimado_hp: picoHp === null ? null : Math.round((picoHp / 2) * 100) / 100,
          regra_estimativa: "pico_aprox_2x_continuo",
          perfil,
        },
        fontes: [fonte(fraca)],
      });
    }
  }
  return [...grupos.values()];
}

/**
 * Portal oficial da disputa: o PNCP é o meio, não o fim (decisão de 15/10/2026). Todo edital lido diz onde a
 * sessão, o chat e os documentos de origem ficam. Sem link seguro, o achado diz isso em vez de omitir.
 * `sistema_pncp` (quem publicou no PNCP) vai nos dados, nunca como portal: pode ser o ERP do órgão.
 */
export function achadoPortalOficial(licitacaoId: number, portal: PortalOficial): Achado {
  const fontes: Fonte[] = [{ tipo: "registro", tabela: "licitacoes_externas", id: String(licitacaoId) }];
  if (portal.evidencia) fontes.push({ tipo: "chunk", ...portal.evidencia });
  const dados = {
    nome: portal.nome,
    url: portal.url,
    host: portal.host,
    metodo: portal.metodo,
    url_pncp: portal.url_pncp,
    sistema_pncp: portal.sistema_pncp,
  };
  // Lido do texto do edital por regra: é indicação, não dado da fonte (AGENTS.md). Conferir antes da sessão.
  if (portal.metodo === "edital") {
    return {
      codigo: "portal.indicado_edital",
      natureza: "inferencia",
      metodo: "regra",
      severidade: "atencao",
      titulo: "portal.indicado_edital",
      detalhe: "O edital indica este endereço para a disputa (trecho citado); confirmar no aviso antes da sessão.",
      dados,
      fontes,
    };
  }
  if (portal.url) {
    return {
      codigo: "portal.oficial",
      natureza: "fato",
      metodo: "regra",
      severidade: "info",
      titulo: "portal.oficial",
      detalhe: "Sessão, chat e documentos de origem ficam no portal oficial; o PNCP repete com atraso.",
      dados,
      fontes,
    };
  }
  return {
    codigo: portal.nome ? "portal.oficial_sem_link" : "portal.nao_informado",
    natureza: "fato",
    metodo: "regra",
    severidade: "atencao",
    titulo: portal.nome ? "portal.oficial_sem_link" : "portal.nao_informado",
    detalhe: portal.nome
      ? "Portal da disputa identificado, mas sem link público seguro: acompanhar direto nesse portal."
      : "Nem o PNCP nem o edital lido indicam o portal da disputa: localizar no edital ou aviso antes da sessão.",
    dados,
    fontes,
  };
}

export function agenteEdital(entrada: {
  chunks: ChunkEdital[];
  data_abertura: string | null;
  licitacao_id?: number;
  portal_oficial?: PortalOficial | null;
}): ResultadoAgente {
  const achados = entrada.chunks.length === 0 ? [] : [...detectarExigencias(entrada.chunks), ...detectarPotencia(entrada.chunks)];
  if (entrada.portal_oficial && entrada.licitacao_id !== undefined) {
    achados.push(achadoPortalOficial(entrada.licitacao_id, entrada.portal_oficial));
  }
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
