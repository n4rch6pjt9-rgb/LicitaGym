const VOLATILE_KEYS = new Set([
  "last_synced_at",
  "lastSeenSyncId",
  "last_seen_sync_id",
  "created_at",
  "updated_at",
  "dataHoraAtualizacao",
]);

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const source = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const data = new Uint8Array(source.byteLength);
  data.set(source);
  const hash = await crypto.subtle.digest("SHA-256", data.buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !VOLATILE_KEYS.has(k))
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export async function hashPayload(payload: unknown): Promise<string> {
  return sha256Hex(stableStringify(payload));
}
