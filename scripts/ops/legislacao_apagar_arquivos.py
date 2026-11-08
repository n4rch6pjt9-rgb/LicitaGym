#!/usr/bin/env python3
"""Apaga do bucket pncp-legislation os arquivos dos documentos-lixo do catálogo de legislação (spec 0042, K-3).

A migration 20261109000100_legislacao_limpeza_catalogo apaga as linhas; os arquivos ficam no Storage, que não se apaga
por SQL. Os caminhos são `<documento_id>/<sha16>/original.pdf`, então o script lista o bucket e apaga só o que está
debaixo dos ids da migration. Sem --executar, só mostra o que apagaria (dry-run).

Uso (Marcelo, depois do merge):
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...      # do ambiente, nunca no código
  python scripts/ops/legislacao_apagar_arquivos.py            # dry-run: lista e conta
  python scripts/ops/legislacao_apagar_arquivos.py --executar
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import requests

BUCKET = "pncp-legislation"
MIGRATION = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "20261109000100_legislacao_limpeza_catalogo.sql"
TIMEOUT_S = 30
PAGINA = 100
LOTE_APAGAR = 100


def ids_da_migration(caminho: Path = MIGRATION) -> list[str]:
    """Os ids apagados pela migration (fonte única: a própria migration)."""
    texto = caminho.read_text(encoding="utf-8")
    bloco = texto[texto.index("v_apagados := private.legislacao_apagar_documentos(array["):]
    bloco = bloco[: bloco.index("]::uuid[]")]
    return re.findall(r"'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'", bloco)


class Storage:
    def __init__(self, url: str, chave: str, sessao: requests.Session | None = None):
        self.base = url.rstrip("/") + "/storage/v1"
        self.s = sessao or requests.Session()
        self.h = {"apikey": chave, "Authorization": f"Bearer {chave}", "Content-Type": "application/json"}

    def listar(self, prefixo: str) -> list[dict]:
        itens: list[dict] = []
        offset = 0
        while True:
            r = self.s.post(f"{self.base}/object/list/{BUCKET}", headers=self.h, timeout=TIMEOUT_S,
                            json={"prefix": prefixo, "limit": PAGINA, "offset": offset})
            if r.status_code >= 300:
                raise RuntimeError(f"Storage list {prefixo!r}: HTTP {r.status_code} {r.text[:200]}")
            pagina = r.json()
            if not isinstance(pagina, list):
                raise RuntimeError(f"Storage list {prefixo!r}: resposta fora do formato")
            itens += pagina
            if len(pagina) < PAGINA:
                return itens
            offset += PAGINA

    def arquivos(self, prefixo: str) -> list[str]:
        """Caminhos dos objetos debaixo do prefixo (pastas têm id nulo e são percorridas)."""
        caminhos: list[str] = []
        for item in self.listar(prefixo):
            caminho = f"{prefixo}/{item['name']}" if prefixo else item["name"]
            if item.get("id") is None:
                caminhos += self.arquivos(caminho)
            else:
                caminhos.append(caminho)
        return caminhos

    def apagar(self, caminhos: list[str]) -> None:
        for i in range(0, len(caminhos), LOTE_APAGAR):
            r = self.s.delete(f"{self.base}/object/{BUCKET}", headers=self.h, timeout=TIMEOUT_S,
                              json={"prefixes": caminhos[i:i + LOTE_APAGAR]})
            if r.status_code >= 300:
                raise RuntimeError(f"Storage delete: HTTP {r.status_code} {r.text[:200]}")


def planejar(storage: Storage, ids: list[str]) -> tuple[list[str], list[str]]:
    """(a apagar, fora da lista). O que não é de um id da lista nunca é apagado."""
    alvo = set(ids)
    todos = storage.arquivos("")
    apagar = [c for c in todos if c.split("/", 1)[0] in alvo]
    return apagar, [c for c in todos if c not in apagar]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--executar", action="store_true", help="apaga de fato (sem isso, só lista)")
    args = ap.parse_args(argv)
    url, chave = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not chave:
        print("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias", file=sys.stderr)
        return 2
    storage = Storage(url, chave)
    apagar, fora = planejar(storage, ids_da_migration())
    for c in apagar:
        print(f"{'apagar' if args.executar else 'apagaria'}: {c}")
    print(f"{len(apagar)} arquivo(s) dos documentos-lixo; {len(fora)} arquivo(s) fora da lista ficam no bucket")
    if args.executar and apagar:
        storage.apagar(apagar)
        print("apagado")
    return 0


if __name__ == "__main__":
    sys.exit(main())
