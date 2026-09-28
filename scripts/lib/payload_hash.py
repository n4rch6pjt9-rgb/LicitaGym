"""Stable JSON serialization and SHA-256 payload hashing for LicitaGym.

Parity note:
Aligned with Edge Functions `supabase/functions/_shared/pncp/hash.ts`:
- Strips volatile keys (`last_synced_at`, `lastSeenSyncId`, `last_seen_sync_id`,
  `created_at`, `updated_at`, `dataHoraAtualizacao`, plus `sync_timestamp`,
  `data_sincronizacao`, `ultimo_sync_completo` to prevent hash changes on mere sync/re-read).
- Sorts keys recursively.
- Separators: `','` and `':'` with no space padding.
- Emits lowercase SHA-256 hex digest.

Note on SQL comments:
Legacy schema comments (such as in `supabase/migrations_archive/20260921_fase3_precos_praticados.sql`
or `SCHEMA_STANDARDS.md`) historically referenced 'MD5(serialized_row)'.
Python ingestion and Edge Functions have standardized on SHA-256 for collision resistance
and parity with Edge Functions (`_shared/pncp/hash.ts`). Production columns are
`TEXT NOT NULL UNIQUE`, accommodating 64-char SHA-256 hex strings without schema modifications.
"""

import hashlib
import json
from typing import Any, Set

VOLATILE_KEYS: Set[str] = {
    "last_synced_at",
    "lastSeenSyncId",
    "last_seen_sync_id",
    "created_at",
    "updated_at",
    "dataHoraAtualizacao",
    # Additional DB sync timestamps present in icatmat / collector rows
    "sync_timestamp",
    "data_sincronizacao",
    "ultimo_sync_completo",
}


def stable_stringify(value: Any, strip_volatile: bool = True) -> str:
    """Stable JSON stringification matching Edge `stableStringify` in `_shared/pncp/hash.ts`.

    - Primitive values formatted as canonical JSON.
    - Dict keys sorted alphabetically.
    - Volatile keys excluded if `strip_volatile=True`.
    - Compact separators without whitespace (`','`, `':'`).
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        items_str = ",".join(stable_stringify(v, strip_volatile) for v in value)
        return f"[{items_str}]"
    if isinstance(value, dict):
        keys = sorted(
            k for k in value.keys()
            if not (strip_volatile and k in VOLATILE_KEYS)
        )
        entries = [
            f'{json.dumps(str(k), ensure_ascii=False)}:{stable_stringify(value[k], strip_volatile)}'
            for k in keys
        ]
        return "{" + ",".join(entries) + "}"
    # Fallback for other objects
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compute_payload_hash(payload: Any, strip_volatile: bool = True) -> str:
    """Compute SHA-256 hex digest of stably stringified payload."""
    serialized = stable_stringify(payload, strip_volatile=strip_volatile)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


# Backwards compatibility alias for code that expects compute_hash(obj) -> str
compute_hash = compute_payload_hash
