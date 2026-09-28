import { timingSafeEqual } from "node:crypto";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

export type AuthDecision =
  | "CRON_AUTHENTICATED"
  | "USER_AUTHENTICATED"
  | "REJECTED";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint, record.code]
      .filter((part) => typeof part === "string" && part.length > 0);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Extract Bearer token; empty/malformed → null. Does NOT authenticate. */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth == null) return null;
  const trimmed = auth.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Constant-time string equality check to prevent timing attacks. */
export function safeCompareSecret(provided: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/**
 * Cron auth: timing-safe match of Bearer token to SYNC_CRON_SECRET.
 * Supports comma-separated secret list for zero-downtime secret rotation.
 * Fail-closed if secret missing/empty. Presence of "Bearer " is never enough.
 */
export function authenticateCron(req: Request): AuthDecision {
  const secret = Deno.env.get("SYNC_CRON_SECRET")?.trim();
  if (!secret) return "REJECTED";
  const token = extractBearerToken(req);
  if (!token) return "REJECTED";

  const allowedSecrets = secret.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const matched = allowedSecrets.some((sec) => safeCompareSecret(token, sec));
  return matched ? "CRON_AUTHENTICATED" : "REJECTED";
}

/** @deprecated Prefer authenticateCron; kept for sync-* call sites. */
export function validateCronAuth(req: Request): boolean {
  return authenticateCron(req) === "CRON_AUTHENTICATED";
}

/**
 * Require cron secret for privileged sync triggers.
 * Returns 401 Response on failure; null when CRON_AUTHENTICATED.
 */
export function requireCronAuth(req: Request): Response | null {
  if (authenticateCron(req) === "CRON_AUTHENTICATED") return null;
  return jsonResponse({ error: "Unauthorized" }, 401);
}

/**
 * Validate Supabase Auth JWT (user session). Fail-closed on missing env/token/user.
 * Does not treat cron secret as a user session.
 */
export async function authenticateUserJwt(req: Request): Promise<AuthDecision> {
  const token = extractBearerToken(req);
  if (!token) return "REJECTED";

  const cronSecret = Deno.env.get("SYNC_CRON_SECRET")?.trim();
  if (cronSecret && token === cronSecret) {
    // Cron is not a user identity for signed-URL / user-scoped routes.
    return "REJECTED";
  }

  const url = Deno.env.get("SUPABASE_URL")?.trim();
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY")?.trim();
  const anon = (anonKey && anonKey.length > 0) ? anonKey : ((publishableKey && publishableKey.length > 0) ? publishableKey : undefined);
  if (!url || !anon) return "REJECTED";

  try {
    const { createClient } = await import("npm:@supabase/supabase-js@2");
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return "REJECTED";
    return "USER_AUTHENTICATED";
  } catch {
    return "REJECTED";
  }
}

export async function requireUserAuth(req: Request): Promise<Response | null> {
  if ((await authenticateUserJwt(req)) === "USER_AUTHENTICATED") return null;
  return jsonResponse({ error: "Unauthorized" }, 401);
}

/**
 * Cron OR authenticated user (for ops that allow either).
 * Still fail-closed; never accepts arbitrary Bearer strings.
 */
export async function authenticateCronOrUser(req: Request): Promise<AuthDecision> {
  const cron = authenticateCron(req);
  if (cron === "CRON_AUTHENTICATED") return cron;
  return await authenticateUserJwt(req);
}

export async function requireCronOrUserAuth(req: Request): Promise<Response | null> {
  const decision = await authenticateCronOrUser(req);
  if (decision === "CRON_AUTHENTICATED" || decision === "USER_AUTHENTICATED") {
    return null;
  }
  return jsonResponse({ error: "Unauthorized" }, 401);
}

export function parseQueryInt(
  url: URL,
  key: string,
  fallback: number,
): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
