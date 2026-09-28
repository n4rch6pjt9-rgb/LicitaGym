/** Page budget for contratacoes atas/editais/contratos.

One run may fetch at most PAGE_HARD_CAP pages. A window whose first page
reports more pages than that cap is split on the date range when the range
covers more than one day. A single day that still exceeds the cap is
checkpointed at the next page. A run with slices left is `incompleta`.
`concluida` is only returned when the pending queue is empty.
*/

export const PAGE_HARD_CAP = 200;

export type DateSlice = {
  dataInicial: string;
  dataFinal: string;
  nextPage: number;
  modalidade?: number;
};

export type FetchedPage = {
  paginasRestantes: number;
  status: number;
  elapsedMs: number;
  body: unknown;
};

export type RunStatus = "concluida" | "incompleta";

const DAY_MS = 86_400_000;

export function parsePncpDay(value: string): number {
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`invalid PNCP date ${value}`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`invalid PNCP date ${value}`);
  }
  return utc;
}

export function formatPncpDay(utcMs: number): string {
  const date = new Date(utcMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function splitDateWindow(slice: DateSlice): [DateSlice, DateSlice] | null {
  const start = parsePncpDay(slice.dataInicial);
  const end = parsePncpDay(slice.dataFinal);
  if (end <= start) return null;
  const spanDays = Math.round((end - start) / DAY_MS);
  const mid = start + Math.floor(spanDays / 2) * DAY_MS;
  const rightStart = mid + DAY_MS;
  const left: DateSlice = {
    dataInicial: slice.dataInicial,
    dataFinal: formatPncpDay(mid),
    nextPage: 1,
  };
  const right: DateSlice = {
    dataInicial: formatPncpDay(rightStart),
    dataFinal: slice.dataFinal,
    nextPage: 1,
  };
  if (slice.modalidade !== undefined) {
    left.modalidade = slice.modalidade;
    right.modalidade = slice.modalidade;
  }
  return [left, right];
}

export function rootSlices(
  dataInicial: string,
  dataFinal: string,
  modalidades?: number[],
): DateSlice[] {
  if (!modalidades || modalidades.length === 0) {
    return [{ dataInicial, dataFinal, nextPage: 1 }];
  }
  return modalidades.map((modalidade) => ({
    dataInicial,
    dataFinal,
    nextPage: 1,
    modalidade,
  }));
}

function isDateSlice(value: unknown): value is DateSlice {
  if (!value || typeof value !== "object") return false;
  const slice = value as DateSlice;
  return typeof slice.dataInicial === "string" &&
    typeof slice.dataFinal === "string" &&
    Number.isInteger(slice.nextPage) &&
    slice.nextPage >= 1 &&
    (slice.modalidade === undefined || Number.isInteger(slice.modalidade));
}

export function pendingFromPriorRun(
  prior: { status: string; parametros: unknown } | null,
): DateSlice[] | null {
  if (!prior || prior.status !== "incompleta") return null;
  const parametros = prior.parametros;
  if (!parametros || typeof parametros !== "object") return null;
  const continuation = (parametros as { continuation?: { pending?: unknown } }).continuation;
  const pending = continuation?.pending;
  if (!Array.isArray(pending) || pending.length === 0) return null;
  if (!pending.every(isDateSlice)) return null;
  return pending.map((slice) => ({ ...slice }));
}

export function syncTerminalStatus(
  pending: DateSlice[],
  upsertErrors: number,
): "incompleta" | "concluida" | "concluida_com_erros" {
  if (pending.length > 0) return "incompleta";
  return upsertErrors > 0 ? "concluida_com_erros" : "concluida";
}

/**
 * Soft-delete unseen rows only when modo=completo AND the continuation chain
 * fully finished as `concluida`. Never on `incompleta` or `concluida_com_erros`.
 */
export function mayInactivateNotSeen(modo: string | undefined, status: string): boolean {
  return modo === "completo" && status === "concluida";
}

/**
 * Shared marker for last_seen across capped continuation runs.
 * First run in a chain uses its own run id; later runs inherit
 * `parametros.continuation.chain_id` (or the prior incompleta run id).
 */
export function resolveContinuationChainId(
  prior: { id: string; status: string; parametros: unknown } | null,
  currentRunId: string,
): string {
  if (!prior || prior.status !== "incompleta") return currentRunId;
  const parametros = prior.parametros;
  if (parametros && typeof parametros === "object") {
    const continuation = (parametros as {
      continuation?: { chain_id?: unknown };
    }).continuation;
    if (typeof continuation?.chain_id === "string" && continuation.chain_id.length > 0) {
      return continuation.chain_id;
    }
  }
  return prior.id;
}

export class PageFetchError extends Error {
  readonly pending: DateSlice[];

  constructor(message: string, pending: DateSlice[]) {
    super(message);
    this.name = "PageFetchError";
    this.pending = pending.map((slice) => ({ ...slice }));
  }
}

function cloneQueue(queue: DateSlice[]): DateSlice[] {
  return queue.map((slice) => ({ ...slice }));
}

export async function runCappedDateSync(opts: {
  cap?: number;
  slices: DateSlice[];
  fetchPage: (slice: DateSlice, pagina: number) => Promise<FetchedPage>;
  onPage: (slice: DateSlice, pagina: number, page: FetchedPage) => Promise<void>;
  onHeartbeat?: (pendingQueue: DateSlice[], pagesFetched: number) => Promise<void>;
}): Promise<{ status: RunStatus; pending: DateSlice[]; pagesFetched: number }> {
  const cap = opts.cap ?? PAGE_HARD_CAP;
  const queue = cloneQueue(opts.slices);
  let pagesFetched = 0;

  while (queue.length > 0 && pagesFetched < cap) {
    const slice = queue[0];
    let page: FetchedPage;
    try {
      page = await opts.fetchPage(slice, slice.nextPage);
      if (page.status >= 400) {
        throw new Error(`PNCP consulta HTTP ${page.status}`);
      }
      if (!Number.isFinite(page.paginasRestantes) || page.paginasRestantes < 0) {
        throw new Error("paginasRestantes invalido");
      }
      pagesFetched++;
      await opts.onPage(slice, slice.nextPage, page);
    } catch (error) {
      if (error instanceof PageFetchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PageFetchError(message, cloneQueue(queue));
    }

    const totalPages = slice.nextPage + page.paginasRestantes;
    if (slice.nextPage === 1 && totalPages > cap) {
      const halves = splitDateWindow(slice);
      if (halves) {
        queue.shift();
        queue.unshift(halves[1], halves[0]);
        if (opts.onHeartbeat) await opts.onHeartbeat(cloneQueue(queue), pagesFetched);
        continue;
      }
    }

    if (page.paginasRestantes <= 0) {
      queue.shift();
    } else {
      slice.nextPage += 1;
    }

    if (opts.onHeartbeat) {
      await opts.onHeartbeat(cloneQueue(queue), pagesFetched);
    }

    if (pagesFetched >= cap) break;
  }

  const pending = cloneQueue(queue);
  return {
    status: pending.length === 0 ? "concluida" : "incompleta",
    pending,
    pagesFetched,
  };
}
