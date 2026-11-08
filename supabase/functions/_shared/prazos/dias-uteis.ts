/**
 * Contagem de dias úteis com calendário de feriados nacionais (spec 0041, K-2).
 *
 * Regras:
 * - a data de referência é o dia local em America/Sao_Paulo (uma data ISO sem hora já é o dia local);
 * - dia útil = segunda a sexta que não está no calendário; o dia de referência não conta;
 * - o calendário precisa cobrir cada ano tocado pela contagem: ano sem nenhum feriado cadastrado dá `RangeError`,
 *   nunca uma contagem que finge não haver feriado;
 * - só feriados nacionais (`public.feriados_nacionais`): estaduais, municipais e pontos facultativos não entram.
 */

export type Sentido = "antes_de" | "apos";

export interface CalendarioFeriados {
  readonly abrangencia: "nacional";
  readonly datas: ReadonlySet<string>;
  readonly anos: ReadonlySet<number>;
}

export interface ResultadoDiasUteis {
  data: string;
  /** Feriados que caíram em dia de semana dentro da contagem e foram pulados. */
  feriados_considerados: string[];
  abrangencia: "nacional";
}

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function validarDataIso(iso: string): { y: number; m: number; d: number } {
  const m = DATA_ISO.exec(iso);
  if (!m) throw new RangeError(`Data inválida: ${iso}`);
  const y = Number(m[1]);
  const mes = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mes - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mes - 1 || t.getUTCDate() !== d) {
    throw new RangeError(`Data inválida: ${iso}`);
  }
  return { y, m: mes, d };
}

function isoDe(t: Date): string {
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Dia local (America/Sao_Paulo) de uma data ISO; data sem hora é tomada como já local. */
export function diaLocal(dataOuInstante: string): string {
  if (DATA_ISO.test(dataOuInstante)) {
    validarDataIso(dataOuInstante);
    return dataOuInstante;
  }
  const instante = new Date(dataOuInstante);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(dataOuInstante) || Number.isNaN(instante.getTime())) {
    throw new RangeError(`Data inválida: ${dataOuInstante}`);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

/** Monta o calendário a partir das datas de `public.feriados_nacionais` (`YYYY-MM-DD`). */
export function calendarioNacional(datas: readonly string[]): CalendarioFeriados {
  const conjunto = new Set<string>();
  const anos = new Set<number>();
  for (const d of datas) {
    const { y } = validarDataIso(d);
    conjunto.add(d);
    anos.add(y);
  }
  return { abrangencia: "nacional", datas: conjunto, anos };
}

function exigirAno(cal: CalendarioFeriados, ano: number): void {
  if (!cal.anos.has(ano)) {
    throw new RangeError(`Calendário de feriados nacionais não cobre ${ano}: prazo não calculado.`);
  }
}

function ehFeriado(cal: CalendarioFeriados, t: Date): boolean {
  exigirAno(cal, t.getUTCFullYear());
  return cal.datas.has(isoDe(t));
}

export function somarDiasUteis(
  dataOuInstante: string,
  n: number,
  sentido: Sentido,
  cal: CalendarioFeriados,
): ResultadoDiasUteis {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Quantidade de dias úteis inválida: ${n}`);
  const { y, m, d } = validarDataIso(diaLocal(dataOuInstante));
  exigirAno(cal, y);
  const passo = sentido === "apos" ? 1 : -1;
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const feriados: string[] = [];
  let restantes = n;
  while (restantes > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + passo);
    const semana = cursor.getUTCDay();
    const feriado = ehFeriado(cal, cursor);
    if (semana === 0 || semana === 6) continue;
    if (feriado) {
      feriados.push(isoDe(cursor));
      continue;
    }
    restantes--;
  }
  feriados.sort();
  return { data: isoDe(cursor), feriados_considerados: feriados, abrangencia: cal.abrangencia };
}

/** Dias úteis de `inicio` (exclusive) até `fim` (inclusive). */
export function contarDiasUteis(inicio: string, fim: string, cal: CalendarioFeriados): number {
  const a = validarDataIso(diaLocal(inicio));
  const b = validarDataIso(diaLocal(fim));
  const cursor = new Date(Date.UTC(a.y, a.m - 1, a.d));
  const alvo = new Date(Date.UTC(b.y, b.m - 1, b.d));
  if (alvo < cursor) throw new RangeError(`Fim (${fim}) antes do início (${inicio}).`);
  exigirAno(cal, a.y);
  let total = 0;
  while (cursor < alvo) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const semana = cursor.getUTCDay();
    if (!ehFeriado(cal, cursor) && semana !== 0 && semana !== 6) total++;
  }
  return total;
}
