"""Gravação no Supabase (PostgREST) e no armazenamento de arquivos (GCS ou disco local)."""
from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from pathlib import Path

import requests

POSTGREST_MAX_ROWS = int(os.environ.get("SUPABASE_PAGE_SIZE", "1000"))


class Supabase:
    """Cliente mínimo do PostgREST usando a service_role key (ignora RLS; só no backend!)."""

    def __init__(self, url: str, service_key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }

    def upsert(self, tabela: str, linhas: list[dict] | dict, conflito: str) -> list[dict]:
        r = requests.post(
            f"{self.base}/{tabela}",
            params={"on_conflict": conflito},
            json=linhas,
            headers={**self.h, "Prefer": "resolution=merge-duplicates,return=representation"},
            timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela}: {r.status_code} {r.text[:500]}")
        return r.json()

    def atualizar(self, tabela: str, id_: int, campos: dict) -> None:
        r = requests.patch(
            f"{self.base}/{tabela}", params={"id": f"eq.{id_}"}, json=campos,
            headers={**self.h, "Prefer": "return=minimal"}, timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela}#{id_}: {r.status_code} {r.text[:500]}")

    def remover_pendentes_exceto(self, licitacao_id: int, manter_ids: list[int]) -> None:
        """Apaga linhas desta licitação que não correspondem mais a nenhum documento do
        portal (ex.: cópias por lote registradas por versões antigas do coletor).
        Não mexe em linhas já extraídas/indexadas pelo RAG."""
        params = {"licitacao_id": f"eq.{licitacao_id}",
                  "status_processamento": "in.(pendente,baixado,erro,ignorado)"}
        if manter_ids:
            params["id"] = f"not.in.({','.join(str(i) for i in manter_ids)})"
        r = requests.delete(f"{self.base}/licitacao_documentos", params=params,
                            headers={**self.h, "Prefer": "return=minimal"}, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase limpeza: {r.status_code} {r.text[:300]}")

    def remover_chunks(self, documento_id: int) -> None:
        r = requests.delete(f"{self.base}/licitacao_chunks", params={"documento_id": f"eq.{documento_id}"},
                            headers={**self.h, "Prefer": "return=minimal"}, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase chunks: {r.status_code} {r.text[:300]}")

    def rpc(self, funcao: str, params: dict) -> list[dict]:
        r = requests.post(f"{self.base}/rpc/{funcao}", json=params, headers=self.h, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase rpc {funcao}: {r.status_code} {r.text[:300]}")
        return r.json()

    @staticmethod
    def _int_param(valor) -> int | None:
        if valor in (None, ""):
            return None
        return int(valor)

    def selecionar(self, tabela: str, **filtros: str) -> list[dict]:
        params_base = dict(filtros)
        limite_total = self._int_param(params_base.pop("limit", None))
        offset_inicial = self._int_param(params_base.pop("offset", None)) or 0
        linhas: list[dict] = []
        while True:
            restante = None if limite_total is None else limite_total - len(linhas)
            if restante is not None and restante <= 0:
                return linhas
            limite_pagina = POSTGREST_MAX_ROWS if restante is None else min(POSTGREST_MAX_ROWS, restante)
            params = {
                **params_base,
                "limit": str(limite_pagina),
                "offset": str(offset_inicial + len(linhas)),
            }
            r = requests.get(f"{self.base}/{tabela}", params=params, headers=self.h, timeout=60)
            r.raise_for_status()
            lote = r.json()
            if not isinstance(lote, list):
                raise RuntimeError(f"Supabase {tabela}: resposta inesperada ao selecionar")
            linhas.extend(lote)
            if len(lote) < limite_pagina:
                return linhas


class Armazenamento:
    """Salva no Google Cloud Storage se GCS_BUCKET estiver definido; senão em ./dados."""

    def __init__(self, bucket: str | None = None, pasta_local: str = "dados"):
        self.bucket_nome = bucket
        self.pasta_local = Path(pasta_local)
        self._bucket = None
        if bucket:
            from google.cloud import storage  # import tardio: só precisa no Cloud Run
            self._bucket = storage.Client().bucket(bucket)

    @staticmethod
    def caminho(fonte: str, modulo: int, id_externo: int, secao: str, arquivo: str) -> str:
        seguro = re.sub(r"[^A-Za-z0-9._-]", "_", arquivo)
        return f"{fonte}/{modulo}/{id_externo}/{secao}/{seguro}"

    def salvar(self, caminho: str, conteudo: bytes, content_type: str | None) -> str:
        ctype = content_type or mimetypes.guess_type(caminho)[0] or "application/octet-stream"
        if self._bucket is not None:
            blob = self._bucket.blob(caminho)
            blob.upload_from_string(conteudo, content_type=ctype)
            return f"gs://{self.bucket_nome}/{caminho}"
        destino = self.pasta_local / caminho
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(conteudo)
        return str(destino.resolve())


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parece_html(conteudo: bytes, ctype: str | None) -> bool:
    """O portal devolve uma página HTML quando o download falha."""
    if ctype and "html" in ctype and not conteudo[:5] == b"%PDF-":
        head = conteudo[:512].lower()
        return b"<html" in head or b"<!doctype" in head
    return False


def env(nome: str, padrao: str | None = None, obrigatorio: bool = False) -> str | None:
    v = os.environ.get(nome, padrao)
    if obrigatorio and not v:
        raise SystemExit(f"Variável de ambiente obrigatória ausente: {nome}")
    return v
