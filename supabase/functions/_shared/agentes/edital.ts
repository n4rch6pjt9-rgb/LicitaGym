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

// Início ancorado: sem ele, uma sequência longa de dígitos dá backtracking quadrático (revisor-seguranca, 19/10).
const RE_HP = /(?<![\w.,])(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?)\s*)?(hpm|hpp|hp|cv)\b/g;
const RE_FAIXA_ANTES = /(entre|de)\s+(\d+(?:[.,]\d+)?)\s+(a|ate|e)\s+$/;
const RE_CONTINUO = /\b(continu[ao]|nominal|real|rms)\b/;
/** "(8.0 hp de pico)", "(pico 4 hp)", "(pico de 8 cv)" logo depois da menção: a menção é a contínua. */
const RE_PICO_ENTRE_PARENTESES = /^\s*\(\s*(?:(?:pico|peak)\s*(?:de\s*)?\d+(?:[.,]\d+)?\s*(?:hp|cv)|\d+(?:[.,]\d+)?\s*(?:hp|cv)\s*(?:de\s*)?(?:pico|peak))/;
/** Distância máxima (caracteres normalizados) para duas menções valerem como o mesmo item. */
const MESMO_ITEM = 150;
const HP_MAXIMO = 50;

/** "1.500" vira 1,5 (separador de milhar não é tratado); inócuo aqui, HP acima de 50 é descartado. */
function numero(s: string): number {
  return Number(s.replace(",", "."));
}

type TipoPotencia = "continua" | "pico" | "faixa" | "sem_tipo";
interface Mencao {
  tipo: TipoPotencia;
  hp: number;
  hp_max: number | null;
  inicio: number;
  fim: number;
}

/** Classifica cada menção "N HP" pelo que está colado a ela. "corrente contínua" (motor DC) não é potência contínua. */
function mencoesPotencia(norm: string): Mencao[] {
  const saida: Mencao[] = [];
  for (const m of norm.matchAll(RE_HP)) {
    const inicio = m.index ?? 0;
    const fim = inicio + m[0].length;
    const antes = norm.slice(Math.max(0, inicio - 40), inicio).replaceAll("corrente continua", "");
    const depois = norm.slice(fim, fim + 25).replaceAll("corrente continua", "");
    let hp = numero(m[1]);
    let hpMax: number | null = null;
    let tipoFracao = false;
    if (m[2] !== undefined) {
      const den = numero(m[2]);
      // "1/2 HP" é fração (meio HP), não faixa; "3/5 HP" é a faixa do CATMAT.
      // Frações usuais de motor pequeno (1/2, 3/4, 3/8...): denominador 2, 4 ou 8 maior que o numerador.
      if ([2, 4, 8].includes(den) && hp < den) {
        hp = hp / den;
        tipoFracao = true;
      } else if (hp >= 1 && den > hp) {
        hpMax = den;
      } else {
        continue;
      }
    }
    if (!Number.isFinite(hp) || hp <= 0 || hp > HP_MAXIMO) continue;
    const mencao = (tipo: TipoPotencia) => saida.push({ tipo, hp, hp_max: hpMax, inicio, fim });
    if (RE_PICO_ENTRE_PARENTESES.test(norm.slice(fim, fim + 30))) {
      mencao("continua");
      continue;
    }
    // O qualificador colado antes do número vale mais que o que vem depois ("nominal de 4,0 hp, com pico de 8 hp").
    if (/(nominal|continua|real)\s*(de\s*)?$/.test(antes) || /potencia (nominal|continua|real)( minima)?( de)?\s*$/.test(antes)) {
      mencao("continua");
      continue;
    }
    if (m[3] === "hpm" || m[3] === "hpp" || /(pico|peak)\s*(de\s*)?$/.test(antes) ||
      /^\s*\(?\s*(de\s+)?(pico|peak|potencia maxima)\b(?!\s*(de\s*)?:?\s*\d)/.test(depois)) {
      mencao("pico");
      continue;
    }
    if (RE_CONTINUO.test(depois.slice(0, 15))) {
      mencao("continua");
      continue;
    }
    if (hpMax !== null) {
      mencao("faixa");
      continue;
    }
    const faixa = RE_FAIXA_ANTES.exec(antes);
    if (faixa && !tipoFracao) {
      saida.push({ tipo: "faixa", hp: numero(faixa[2]), hp_max: hp, inicio, fim });
      continue;
    }
    mencao("sem_tipo");
  }
  return saida;
}

/** Fronteira de item: "item N", "lote N" ou lista numerada ("2. ", "2) ") depois de fim de frase. */
const RE_FRONTEIRA_ITEM = /\b(item|lote)\s*\d|(^|[.;:]\s)\d{1,3}\s?[.)]\s/g;

const RE_OUTRO_EQUIPAMENTO =
  /\b(esteiras?|bicicletas?|elipticos?|transports?|simuladores?|bombas?|compressor(es)?|bebedouros?|ventiladores?|geradores?|elevadores?|climatizadores?|aparelhos?)\b/;

/** Duas menções do mesmo item: próximas e sem fronteira de item entre elas. */
function mesmoItem(norm: string, a: Mencao, b: Mencao): boolean {
  const [x, y] = a.inicio < b.inicio ? [a, b] : [b, a];
  if (y.inicio - x.fim > MESMO_ITEM) return false;
  const entre = norm.slice(x.fim, y.inicio);
  // Outro equipamento nomeado entre as duas menções também é outro item (Codex no #401: "4 HP nominal" de um compressor
  // seguido de "esteira ... 3 HPM" no mesmo trecho, sem "item N").
  return !new RegExp(RE_FRONTEIRA_ITEM.source).test(entre) && !RE_OUTRO_EQUIPAMENTO.test(entre);
}

/** Janela do item da menção: até 400 caracteres para cada lado, cortada na fronteira de item mais próxima. */
function janelaDoItem(norm: string, m: Mencao): string {
  let ini = Math.max(0, m.inicio - 400);
  let fim = Math.min(norm.length, m.fim + 400);
  for (const f of norm.slice(ini, m.inicio).matchAll(RE_FRONTEIRA_ITEM)) ini = Math.max(ini, ini + (f.index ?? 0));
  const depois = new RegExp(RE_FRONTEIRA_ITEM.source).exec(norm.slice(m.fim, fim));
  if (depois) fim = m.fim + depois.index;
  return norm.slice(ini, fim);
}

/** Sinais de uso profissional perto da menção: palavra, motor AC ou capacidade do usuário acima de 150 kg. */
function perfilProfissional(norm: string): string[] {
  const perfil: string[] = [];
  if (/\bprofissiona(l|is)\b|\buso (continuo|intenso|comercial)\b|\bacademias?\b/.test(norm)) perfil.push("profissional");
  if (/corrente alternada|\bmotor (c\.?a\.?|ac)\b|\(ac\)/.test(norm)) perfil.push("motor_ac");
  const pesos: number[] = [];
  // Por ocorrência: nos ~40 caracteres antes do número, a palavra mais próxima decide (usuário × equipamento).
  for (const x of norm.matchAll(/(?<![\d.,])(\d{3})\s*kg/g)) {
    const n = Number(x[1]);
    if (n <= 150 || n > 300) continue;
    const antes = norm.slice(Math.max(0, (x.index ?? 0) - 40), x.index ?? 0);
    const ultima = (re: RegExp) => Math.max(-1, ...[...antes.matchAll(re)].map((y) => y.index ?? -1));
    const usuario = ultima(/usuario|capacidade|suport|peso maximo/g);
    const exclui = ultima(/equipamento|liquido|bruto|embalagem|produto|aparelho|piso/g);
    if (usuario > exclui) pesos.push(n);
  }
  if (pesos.length) perfil.push(`peso_usuario_${Math.min(...pesos)}kg`);
  return perfil;
}

export function detectarPotencia(chunks: ChunkEdital[]): Achado[] {
  const grupos = new Map<string, Achado>();
  const juntar = (a: Achado) => {
    const g = grupos.get(a.codigo);
    if (!g) grupos.set(a.codigo, a);
    else if (g.fontes.filter((f) => f.tipo === "chunk").length < 3) {
      // Trechos em ordem de citação; a fonte de cálculo (se houver) fica no fim.
      const calculo = g.fontes.filter((f) => f.tipo !== "chunk");
      g.fontes = [...g.fontes.filter((f) => f.tipo === "chunk"), ...a.fontes.filter((f) => f.tipo === "chunk"), ...calculo];
    }
  };
  for (const chunk of chunks) {
    const { norm, origem } = normalizarComMapa(chunk.texto);
    const mencoes = mencoesPotencia(norm);
    const fonte = (m: Mencao): Fonte => ({
      tipo: "chunk",
      chunk_id: chunk.id,
      documento_id: chunk.documento_id,
      pagina: chunk.pagina,
      trecho: trechoNoOriginal(chunk.texto, m.inicio, m.fim, origem),
    });
    for (const m of mencoes) {
      if (m.tipo !== "pico" && m.tipo !== "faixa") continue;
      const vizinhas = mencoes.filter((o) => o !== m && mesmoItem(norm, m, o));
      // Contínuo do mesmo item informado: nada a apontar.
      if (vizinhas.some((o) => o.tipo === "continua")) continue;
      // "Potência do motor 2 a 3 HP ... potência de pico 4 a 6 HP": o número menor ao lado de um pico maior é o contínuo.
      if (m.tipo === "pico" && vizinhas.some((o) => o.tipo !== "pico" && o.hp < m.hp)) continue;
      if (m.tipo === "faixa" && vizinhas.some((o) => o.tipo === "pico" && o.hp > (m.hp_max ?? m.hp))) continue;

      if (m.tipo === "pico") {
        juntar({
          codigo: "especificacao.potencia_so_pico",
          natureza: "fato",
          metodo: "regra",
          severidade: "info",
          titulo: "especificacao.potencia_so_pico",
          detalhe: "O termo informa só a potência de pico do motor, não a contínua.",
          dados: { pico_hp: m.hp },
          fontes: [fonte(m)],
        });
      } else {
        juntar({
          codigo: "especificacao.potencia_faixa_ambigua",
          natureza: "fato",
          metodo: "regra",
          severidade: "atencao",
          titulo: "especificacao.potencia_faixa_ambigua",
          detalhe: "Potência em faixa (ex.: \"3/5 HP\", \"entre 3 a 5 HP\") sem dizer se é contínua ou de pico.",
          dados: { hp_min: m.hp, hp_max: m.hp_max },
          fontes: [fonte(m)],
        });
      }
      // Perfil só ao redor da menção: o trecho indexado pode ter vários itens.
      const perfil = perfilProfissional(janelaDoItem(norm, m));
      if (perfil.length === 0) continue;
      const pico = m.tipo === "pico";
      juntar({
        codigo: "especificacao.inconsistente",
        natureza: "inferencia",
        metodo: "regra",
        severidade: "atencao",
        titulo: "especificacao.inconsistente",
        detalhe: pico
          ? "Perfil de uso profissional com potência só de pico: um motor residencial atende o texto. Contínuo " +
            "estimado pela regra de mercado (pico ≈ 2 × contínuo), não pelo edital."
          : "Perfil de uso profissional com potência em faixa, sem dizer se é contínua ou de pico: um motor " +
            "residencial atende o texto.",
        dados: pico
          ? { pico_hp: m.hp, continuo_estimado_hp: Math.round((m.hp / 2) * 100) / 100, regra_estimativa: "pico_aprox_2x_continuo", perfil }
          : { hp_min: m.hp, hp_max: m.hp_max, perfil },
        fontes: pico
          ? [fonte(m), { tipo: "calculo", regra: "pico_aprox_2x_continuo", versao: REGRA_VERSAO }]
          : [fonte(m)],
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
