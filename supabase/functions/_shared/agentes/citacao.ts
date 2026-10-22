/**
 * Citação legível de um trecho do edital (spec 0038, K-4): o item/cláusula ("8.4.2") e o trecho limpo (frases
 * inteiras, até ~300 caracteres), extraídos do texto do chunk no momento da resposta.
 *
 * Funções puras. Nada é inventado: o item é o último cabeçalho de item (numeração no início de uma frase ou linha)
 * que aparece até a posição citada; sem nenhum, null. O trecho limpo só corta em fim de frase ou entre palavras; quando precisa cortar no meio de uma frase, marca
 * o corte com "…".
 */

/**
 * Numeração de item no início da frase/linha: "8.4.2 ", "6.7.1.", "5.1.2)", "5.1 -". Exige ao menos um ponto
 * ("8." sozinho não é item). Não aceita data ("21.10.2026"), valor ("1.500,00") nem lei ("14.133/2021").
 */
const RE_ITEM = /^\s*(\d{1,2}(?:\.\d{1,3}){1,4})(?![\d,/])(?:[\s)\-–—]|\.(?!\d)|$)/;
/** Segmento que é só a numeração ("8.4.2.", "1."): a frase começa no segmento seguinte e vai junto com ele. */
const RE_SO_ITEM = /^\s*\d{1,3}(?:\.\d{1,3}){0,4}\.?\s*$/;
/** Fim de frase: . ! ? seguidos de espaço (ou fim do texto), e quebra de linha. */
const RE_FIM_FRASE = /[.!?]+(?=\s|$)|\n/g;
/** Palavras abreviadas que terminam em ponto sem fechar a frase ("art. 5º", "nº. 12", "Ltda."). */
const ABREVIACOES = new Set([
  "art", "arts", "inc", "incs", "n", "nº", "no", "nos", "núm", "num", "sr", "sra", "dr", "dra", "ltda", "fls", "fl",
  "pág", "pag", "p", "pp", "cf", "ex", "obs", "al", "alín", "par", "parág", "cap", "séc", "tel", "un", "und", "qtd",
  "qtde", "ref", "id", "etc", "s.a", "me", "epp", "eireli",
]);
const MAX_PADRAO = 300;

interface Frase {
  inicio: number;
  fim: number;
}

function abreviacao(texto: string, posPonto: number): boolean {
  if (texto[posPonto] !== ".") return false;
  const antes = texto.slice(Math.max(0, posPonto - 12), posPonto);
  const palavra = /([\p{L}º°]+(?:\.[\p{L}]+)?)$/u.exec(antes)?.[1];
  return palavra !== undefined && ABREVIACOES.has(palavra.toLowerCase());
}

/** Frases (e linhas) do texto, em posições do original; segmento só de numeração vai junto com o seguinte. */
function frases(texto: string): Frase[] {
  const brutas: Frase[] = [];
  let inicio = 0;
  for (const m of texto.matchAll(RE_FIM_FRASE)) {
    const pos = m.index ?? 0;
    if (m[0] !== "\n" && abreviacao(texto, pos)) continue;
    const fim = pos + m[0].length;
    brutas.push({ inicio, fim });
    inicio = fim;
  }
  if (inicio < texto.length) brutas.push({ inicio, fim: texto.length });
  const saida: Frase[] = [];
  for (const f of brutas) {
    if (texto.slice(f.inicio, f.fim).trim() === "") continue;
    const anterior = saida[saida.length - 1];
    if (anterior && RE_SO_ITEM.test(texto.slice(anterior.inicio, anterior.fim))) anterior.fim = f.fim;
    else saida.push({ ...f });
  }
  return saida;
}

/** Posição do trecho no texto: exata, ou ignorando caixa e espaços. -1 se não está. */
function posicao(texto: string, trecho: string): number {
  const exata = texto.indexOf(trecho);
  if (exata >= 0) return exata;
  const palavras = trecho.trim().split(/\s+/).filter(Boolean).slice(0, 60);
  if (palavras.length === 0) return -1;
  const re = new RegExp(palavras.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu");
  return re.exec(texto)?.index ?? -1;
}

/**
 * Item/cláusula vigente na posição: o último cabeçalho de item (numeração no início de uma frase ou linha) da frase
 * que contém a posição ou de uma anterior. "8.1 … 8.2 … [posição]" → "8.2". Sem cabeçalho até ali: null.
 */
export function itemNaPosicao(texto: string, pos: number): string | null {
  if (pos < 0 || pos > texto.length) return null;
  let item: string | null = null;
  for (const f of frases(texto)) {
    if (f.inicio > pos) break;
    const cabecalho = RE_ITEM.exec(texto.slice(f.inicio, f.fim))?.[1];
    if (cabecalho) item = cabecalho;
  }
  return item;
}

/**
 * Item/cláusula ("8.4.2") vigente onde o trecho aparece no texto do chunk (itemNaPosicao). Sem trecho, o do início do
 * texto. Trecho que não está no texto, ou nenhum cabeçalho até ali: null (não se inventa).
 */
export function itemDoTrecho(texto: string, trecho?: string | null): string | null {
  if (typeof texto !== "string" || texto.length === 0) return null;
  const pos = trecho ? posicao(texto, trecho) : 0;
  return pos < 0 ? null : itemNaPosicao(texto, pos);
}

const colapsar = (s: string) => s.replace(/\s+/g, " ").trim();

/** O texto começa no meio de uma frase: letra minúscula ou pontuação logo no início ("nte o preenchimento…"). */
function comecaNoMeio(trecho: string): boolean {
  const primeiro = trecho.trimStart()[0];
  return primeiro !== undefined && (/\p{Ll}/u.test(primeiro) || /[,;:)\]\-–]/.test(primeiro));
}

const terminada = (s: string) => /[.!?]["'”»)]*$/.test(s);

/** Tira a primeira palavra (pode estar cortada) de um fragmento. */
function semPrimeiraPalavra(s: string): string {
  const i = s.search(/\s/);
  return i < 0 ? "" : s.slice(i).trim();
}

/** Tira a última palavra (pode estar cortada) e marca o corte. */
function semUltimaPalavra(s: string): string {
  const i = s.search(/\s\S*$/);
  return i <= 0 ? s : `${s.slice(0, i).replace(/[\s,;:]+$/, "")}…`;
}

/** Foco com posição exata no texto (o "apoio" do serviço, já conferido contra o texto do banco). */
export interface FocoPosicionado {
  inicio: number;
  texto: string;
}

/** Corta uma frase longa entre palavras, mantendo o foco (se houver) dentro do recorte. */
function cortarFrase(frase: string, max: number, foco: string | null): string {
  let ini = 0;
  if (foco) {
    const p = posicao(frase, foco);
    if (p >= 0 && p + foco.length > max - 1) {
      const alvo = Math.max(0, p - Math.floor((max - Math.min(foco.length, max)) / 2));
      const espaco = frase.lastIndexOf(" ", alvo);
      ini = espaco < 0 ? 0 : espaco + 1;
    }
  }
  const prefixo = ini > 0 ? "…" : "";
  const resto = frase.slice(ini);
  const limite = max - prefixo.length - 1;
  if (resto.length <= limite + 1) return prefixo + resto;
  const corte = resto.lastIndexOf(" ", limite);
  const parte = (corte > 0 ? resto.slice(0, corte) : resto.slice(0, limite)).replace(/[\s,;:]+$/, "");
  return `${prefixo}${parte}…`;
}

/**
 * Trecho legível: frases inteiras (até `max` caracteres), espaços colapsados, sem palavra cortada.
 *  - fragmento no início (começa em minúscula, como "nte o preenchimento") sai: o trecho começa na próxima frase ou linha;
 *  - com `foco` (o trecho citado, ou o trecho com a posição exata), começa na frase que o contém;
 *  - última frase sem pontuação final (texto cortado na fonte) perde a última palavra e ganha "…";
 *  - frase sozinha maior que `max` é cortada entre palavras, com "…".
 */
export function trechoLimpo(texto: string, max = MAX_PADRAO, foco?: string | FocoPosicionado | null): string {
  if (typeof texto !== "string") return "";
  const lista = frases(texto);
  if (lista.length === 0) return "";
  const pedaco = (f: Frase) => colapsar(texto.slice(f.inicio, f.fim));

  const fragmento = comecaNoMeio(texto);
  let alvo = fragmento && lista.length > 1 ? 1 : 0;
  const focoTexto = foco ? (typeof foco === "string" ? foco : foco.texto) : null;
  if (foco) {
    const p = typeof foco === "string" ? posicao(texto, foco) : foco.inicio;
    if (p >= 0) alvo = Math.max(0, lista.findIndex((f) => p < f.fim));
  }

  const ultimaDoTexto = lista.length - 1;
  let primeira = pedaco(lista[alvo]);
  if (alvo === 0 && fragmento) primeira = semPrimeiraPalavra(primeira);
  if (alvo === ultimaDoTexto && !terminada(primeira)) primeira = semUltimaPalavra(primeira);
  if (primeira.length > max) return cortarFrase(primeira, max, focoTexto ? colapsar(focoTexto) : null);

  let saida = primeira;
  for (let j = alvo + 1; j < lista.length; j++) {
    const frase = pedaco(lista[j]);
    // a última frase sem pontuação final veio cortada da fonte: fica de fora
    if (j === ultimaDoTexto && !terminada(frase)) break;
    if (saida.length + 1 + frase.length > max) break;
    saida = `${saida} ${frase}`;
  }
  return saida;
}
