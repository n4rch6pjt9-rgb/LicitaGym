/** PostgREST max-rows safe pagination helpers for sync Edge functions. */

export const POSTGREST_PAGE_SIZE = 1000;

/**
 * Max values in one PostgREST `.in()` sent as GET.
 * The list goes in the query string. 550 UUIDs are about 21 KB and Deno
 * fetch throws `TypeError: error sending request` before any HTTP status
 * (sync-pncp-orgaos, job 6, 2026-10-03 through 2026-10-07).
 * 80 UUIDs stay near 3 KB.
 */
export const POSTGREST_IN_CHUNK = 80;

export type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

export type FetchAllByRangeOptions = {
  pageSize?: number;
  /**
   * Unique stable column that caller MUST already apply via
   * `.order(orderBy)` before `.range(...)` inside `fetchPage`.
   * Required so offset pages cannot skip/duplicate rows.
   */
  orderBy: string;
};

/**
 * Fetch all rows via repeated `.range(from, to)` until a short page.
 * Avoids silent truncation at the PostgREST max-rows default (1000).
 *
 * Accepts PromiseLike so Supabase PostgrestFilterBuilder (Thenable) works
 * without wrapping the builder in `async` / `await`.
 *
 * Caller MUST apply `.order(options.orderBy)` before `.range(...)` in fetchPage.
 * Prefer PK / unique natural keys (e.g. `id`, `codigo_pdm`, `codigo_item`).
 */
export async function fetchAllByRange<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  options: FetchAllByRangeOptions,
): Promise<{ rows: T[]; pages: number }> {
  const orderBy = options.orderBy?.trim();
  if (!orderBy) {
    throw new Error(
      "fetchAllByRange requires options.orderBy (stable unique column already used in .order())",
    );
  }
  const pageSize = options.pageSize ?? POSTGREST_PAGE_SIZE;
  const rows: T[] = [];
  let pages = 0;
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    pages += 1;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return { rows, pages };
}

/** Chunk an `.in(...)` filter list so URL/body size stays bounded. */
export function chunkValues<T>(
  values: readonly T[],
  size = POSTGREST_PAGE_SIZE,
): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size) as T[]);
  }
  return chunks;
}
