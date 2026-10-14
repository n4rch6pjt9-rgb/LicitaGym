"""Proveniência por linha de licitacoes_externas (spec 0023, #363).

Toda gravação do payload de uma licitação leva três campos derivados da passagem do coletor:
  payload_hash     sha256 hex do `raw` serializado de forma estável (chaves ordenadas, sem espaços, UTF-8).
                   Regra própria do coletor Python: NÃO é comparável com _shared/pncp/hash.ts (hashPayload), que
                   formata números diferente (150000.0 vs 150000) e descarta chaves voláteis. Alinhar as duas antes
                   de os syncs em TS gravarem licitacoes_externas (#363). Nulo quando não há payload.
  ingestao_origem  'cron' (agendado) ou 'manual' (disparo pela tela ou pela linha de comando).
  ingestao_em      instante UTC da passagem (ISO 8601). A tela mostra em Brasília.
Só a última passagem fica na linha (decisão do Marcelo, 14/10/2026). Backfills e o sync-portal-compras não mexem.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

ORIGENS = ("cron", "manual")


def hash_payload(raw) -> str | None:
    """sha256 hex do payload serializado de forma estável; None para payload ausente ou vazio."""
    if not raw:
        return None
    # sem default=: tipo não serializável é erro de programação (o raw já precisa ser JSON para o PostgREST)
    texto = json.dumps(raw, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def campos_proveniencia(raw, origem: str, agora: datetime | None = None) -> dict:
    """Os três campos para o upsert. `origem` fora de ORIGENS é erro de programação, não de dado."""
    if origem not in ORIGENS:
        raise ValueError(f"origem da ingestão deve ser uma de {ORIGENS}, não {origem!r}")
    instante = agora or datetime.now(timezone.utc)
    return {"payload_hash": hash_payload(raw), "ingestao_origem": origem, "ingestao_em": instante.isoformat()}
