"""Gravação no Supabase (PostgREST) e no armazenamento de arquivos (GCS ou disco local)."""
from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from pathlib import Path

import logging

import requests

POSTGREST_MAX_ROWS = int(os.environ.get("SUPABASE_PAGE_SIZE", "1000"))

log = logging.getLogger(__name__)

# public.licitacao_match (migration 20261002170000): texto gravado em licitacao_itens.descricao ou
# licitacoes_externas.objeto vira pendência (trigger) e é recalculado por licitacao_match_atualizar.
# O coletor drena a cada LICITACAO_MATCH_LOTE linhas de texto gravadas e no fim da execução, para a
# pendência ficar pequena (a RPC do recorte CATMAT casa o texto pendente ao vivo, o que custa CPU).
TABELAS_TEXTO_CATMAT = {"licitacao_itens": {"descricao", "licitacao_id"}, "licitacoes_externas": {"objeto"}}
LICITACAO_MATCH_LOTE = int(os.environ.get("LICITACAO_MATCH_LOTE", "300"))
LICITACAO_MATCH_MAX_LOTES = 200


class Supabase:
    """Cliente mínimo do PostgREST usando a service_role key (ignora RLS; só no backend!)."""

    def __init__(self, url: str, service_key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        self._textos_sem_drenar = 0

    def _contar_textos(self, tabela: str, n: int) -> None:
        """Conta linhas de texto CATMAT gravadas e drena licitacao_match ao passar de LICITACAO_MATCH_LOTE."""
        self._textos_sem_drenar += n
        if self._textos_sem_drenar >= LICITACAO_MATCH_LOTE:
            self.drenar_licitacao_match()

    def drenar_licitacao_match(self, limite: int | None = None, max_lotes: int = LICITACAO_MATCH_MAX_LOTES) -> int | None:
        """Chama public.licitacao_match_atualizar em lotes até não sobrar pendência (ou max_lotes).

        Devolve quantas pendências restam, ou None se a drenagem falhou. Falha não interrompe a coleta: a RPC do
        recorte CATMAT continua correta com pendência (casa o texto pendente ao vivo), só fica mais lenta."""
        lote = limite or LICITACAO_MATCH_LOTE
        restantes = None
        try:
            for _ in range(max_lotes):
                restantes = int(self.rpc("licitacao_match_atualizar", {"p_limite": lote}))
                if restantes <= 0:
                    break
        except (requests.RequestException, RuntimeError, TypeError, ValueError) as e:
            log.warning("licitacao_match: drenagem falhou (%s); a pendência fica para a próxima execução", e)
            return None
        self._textos_sem_drenar = 0
        if restantes:
            log.warning("licitacao_match: %s pendência(s) após %s lotes", restantes, max_lotes)
        return restantes

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
        if tabela in TABELAS_TEXTO_CATMAT:
            self._contar_textos(tabela, len(linhas) if isinstance(linhas, list) else 1)
        return r.json()

    def atualizar(self, tabela: str, id_: int, campos: dict) -> None:
        r = requests.patch(
            f"{self.base}/{tabela}", params={"id": f"eq.{id_}"}, json=campos,
            headers={**self.h, "Prefer": "return=minimal"}, timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela}#{id_}: {r.status_code} {r.text[:500]}")
        if TABELAS_TEXTO_CATMAT.get(tabela, set()) & set(campos):
            self._contar_textos(tabela, 1)

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


def drenar_licitacao_match(sb) -> int | None:
    """Fim de execução de coletor: drena licitacao_match se houver cliente Supabase (nada no --dry-run)."""
    if isinstance(sb, Supabase):
        return sb.drenar_licitacao_match()
    return None


class SupabaseStorage:
    """Bucket privado do Supabase Storage (padrão do LicitaGym: os arquivos ficam dentro do SaaS).
    URI gravada no banco: supabase://<bucket>/<caminho>. O Dashboard abre por link assinado (usuário logado)."""

    def __init__(self, url: str, service_key: str, bucket: str, sessao: requests.Session | None = None):
        self.base = url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self.s = sessao or requests.Session()
        self.h = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}

    def salvar(self, caminho: str, conteudo: bytes, ctype: str) -> str:
        r = self.s.post(f"{self.base}/object/{self.bucket}/{caminho}", data=conteudo,
                        headers={**self.h, "Content-Type": ctype, "x-upsert": "true"}, timeout=(30, 300))
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase Storage {caminho}: {r.status_code} {r.text[:300]}")
        return f"supabase://{self.bucket}/{caminho}"

    def ler(self, uri: str) -> bytes:
        bucket, caminho = uri.removeprefix("supabase://").split("/", 1)
        r = self.s.get(f"{self.base}/object/{bucket}/{caminho}", headers=self.h, timeout=(30, 300))
        r.raise_for_status()
        return r.content


class Armazenamento:
    """Destino dos arquivos, nesta ordem:
    1. Supabase Storage, se SUPABASE_STORAGE_BUCKET estiver definido (padrão do LicitaGym);
    2. Google Cloud Storage, se GCS_BUCKET estiver definido;
    3. disco local ./dados (só para teste: fica fora do SaaS)."""

    def __init__(self, bucket: str | None = None, pasta_local: str = "dados", supabase: SupabaseStorage | None = None):
        self.bucket_nome = bucket
        self.pasta_local = Path(pasta_local)
        self._bucket = None
        self.supabase = supabase
        if bucket and supabase is None:
            from google.cloud import storage  # import tardio: só precisa no Cloud Run
            self._bucket = storage.Client().bucket(bucket)

    @classmethod
    def do_ambiente(cls) -> "Armazenamento":
        sb_bucket = env("SUPABASE_STORAGE_BUCKET")
        if sb_bucket:
            return cls(supabase=SupabaseStorage(env("SUPABASE_URL", obrigatorio=True),
                                                env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True), sb_bucket))
        return cls(env("GCS_BUCKET"))

    @property
    def dentro_do_saas(self) -> bool:
        return self.supabase is not None or self._bucket is not None

    @staticmethod
    def caminho(fonte: str, modulo: int, id_externo: int, secao: str, arquivo: str) -> str:
        seguro = re.sub(r"[^A-Za-z0-9._-]", "_", arquivo)
        return f"{fonte}/{modulo}/{id_externo}/{secao}/{seguro}"

    def salvar(self, caminho: str, conteudo: bytes, content_type: str | None) -> str:
        ctype = content_type or mimetypes.guess_type(caminho)[0] or "application/octet-stream"
        if self.supabase is not None:
            return self.supabase.salvar(caminho, conteudo, ctype)
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
