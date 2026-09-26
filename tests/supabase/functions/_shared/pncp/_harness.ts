export {
  clampConsultaPageSize,
  CONSULTA_PAGE_SIZE,
  PncpConsultaClient,
} from "../../../../../supabase/functions/_shared/pncp/consulta-client.ts";
export {
  BudgetExhaustedError,
  createRequestBudget,
  EDGE_REQUEST_DEADLINE_MS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  PermanentHttpError,
  RetryableHttpError,
  retryDelayMs,
  retryDelayWithJitter,
  withRetry,
} from "../../../../../supabase/functions/_shared/pncp/retry.ts";
export {
  isComplete,
  nextPage,
} from "../../../../../supabase/functions/_shared/pncp/checkpoint.ts";
export type { Checkpoint } from "../../../../../supabase/functions/_shared/pncp/checkpoint.ts";
export { hashPayload } from "../../../../../supabase/functions/_shared/pncp/hash.ts";
export { PncpSearchClient } from "../../../../../supabase/functions/_shared/pncp/search-client.ts";

export const SYNC_DIR = new URL(
  "../../../../../supabase/functions/",
  import.meta.url,
);

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { restore: () => void; urls: string[] } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL
      ? input.toString()
      : typeof input === "string"
      ? input
      : input.url;
    urls.push(url);
    return await handler(url, init);
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export async function readSync(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, SYNC_DIR));
}
