"""Arquivo imutável do `raw` jsonb que sai do Postgres e vai para o GCS.

Contrato (gcs-raw-1). O próximo coletor (Paradigma, depois do #220) importa esta
classe; a API de quem grava é só `adicionar` e `fechar`.

Caminho do objeto:
  gs://licitagym-documentos/arquivo-db/<tabela>/<fonte>/<AAAA-MM-DD UTC>/<execucao_id>-<lote:04d>.jsonl.gz

  tabela: licitacao_itens | licitacao_resultados | precos_praticados_itens
  fonte: pncp | compras-precos | slug do tenant Paradigma (sfiec, fiesc, ...)
  data: UTC da linha mais antiga do lote
  execucao_id: uuid4 da execução (quem cria dois ArquivoRaw na mesma execução
  passa o mesmo id, para os objetos do dia não se misturarem)
  lote: 0001, 0002, ... até 1000 linhas JSONL por objeto

Cada linha é um JSON UTF-8 (sem máscara: CPF/CNPJ de edital são públicos):
  {"tabela","fonte","chave","coletado_em","raw"}
  chave = chave natural do upsert (ex.: licitacao_id + numero_item)
  raw = o objeto que iria para a coluna

O objeto é imutável: upload com if_generation_match=0. O md5 do gzip (hex no
manifesto) é conferido com o md5Hash base64 que o GCS devolve na resposta do
insert. Não há GET depois do upload: roles/storage.objectCreator não inclui
storage.objects.get. Falha de upload, de precondition ou de md5 levanta
ArquivoRawErro — quem chama para a coleta (fail closed).

Modo local (não toca no GCS): ARQUIVO_RAW_GCS=0, ou dry_run=True. Os arquivos
vão para ARQUIVO_RAW_DIR (padrão ./arquivo-raw), no mesmo caminho relativo.
Credencial só por ADC (storage.Client() sem chave) ou pelo cliente injetado
em teste. Nada de JSON de conta de serviço neste módulo.

fechar() devolve um manifesto por objeto:
  {uri, linhas, md5, chave_min, chave_max, coletado_em}
"""
from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import io
import json
import logging
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from google.cloud import storage

log = logging.getLogger("coletor.arquivo_raw")

BUCKET = "licitagym-documentos"
LOTE_MAX = 1000
TABELAS = frozenset({"licitacao_itens", "licitacao_resultados", "precos_praticados_itens"})
_FONTE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_DIA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_DESLIGA = frozenset({"0", "false", "no", "off"})


class ArquivoRawErro(RuntimeError):
    """Falha ao gravar o raw. A coleta para (fail closed)."""


def gcs_ligado() -> bool:
    """False quando ARQUIVO_RAW_GCS=0 (testes e dry-run por ambiente). Ausente = ligado."""
    valor = os.environ.get("ARQUIVO_RAW_GCS")
    if valor is None:
        return True
    return valor.strip().lower() not in _DESLIGA


def nome_objeto(tabela: str, fonte: str, dia: str, execucao_id: str, lote: int) -> str:
    """Caminho do objeto dentro do bucket (sem o gs://)."""
    _validar_tabela(tabela)
    _validar_fonte(fonte)
    if not _DIA.fullmatch(dia):
        raise ArquivoRawErro(f"dia UTC inválido: {dia!r}")
    _validar_execucao(execucao_id)
    if not isinstance(lote, int) or lote < 1 or lote > 9999:
        raise ArquivoRawErro(f"lote fora de 0001..9999: {lote!r}")
    return f"arquivo-db/{tabela}/{fonte}/{dia}/{execucao_id}-{lote:04d}.jsonl.gz"


def fechar_todos(arquivos: list[ArquivoRaw]) -> list[dict[str, Any]]:
    """Fecha cada arquivo. Se um falhar, ainda tenta os outros e depois levanta (fail closed)."""
    manifestos: list[dict[str, Any]] = []
    falha: ArquivoRawErro | None = None
    for arq in arquivos:
        try:
            manifestos.extend(arq.fechar())
        except ArquivoRawErro as e:
            falha = e
    if falha is not None:
        raise falha
    return manifestos


class ArquivoRaw:
    """Acumula linhas e grava JSONL.gz em lotes de até 1000.

    Uso:
        arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=execucao)
        arq.adicionar({"licitacao_id": 1, "numero_item": 2}, item_bruto)
        manifestos = arq.fechar()
    """

    def __init__(
        self,
        tabela: str,
        fonte: str,
        *,
        execucao_id: str | None = None,
        dry_run: bool = False,
        diretorio: str | Path | None = None,
        cliente: Any = None,
        relogio: Callable[[], datetime] | None = None,
    ) -> None:
        _validar_tabela(tabela)
        _validar_fonte(fonte)
        self.tabela = tabela
        self.fonte = fonte
        self.execucao_id = execucao_id or str(uuid.uuid4())
        _validar_execucao(self.execucao_id)
        self._local = bool(dry_run) or not gcs_ligado()
        self._diretorio = Path(diretorio) if diretorio is not None else Path(
            os.environ.get("ARQUIVO_RAW_DIR") or "arquivo-raw")
        self._cliente = cliente
        self._relogio = relogio or (lambda: datetime.now(timezone.utc))
        self._buffer: list[dict[str, Any]] = []
        self._manifestos: list[dict[str, Any]] = []
        self._lote = 1
        self._fechado = False
        self._lock = threading.Lock()

    def adicionar(self, chave: dict[str, Any], raw: dict[str, Any]) -> None:
        """Uma linha. Ao completar 1000, grava o objeto. Falha de upload propaga ArquivoRawErro."""
        registro = self._registro(chave, raw)
        with self._lock:
            if self._fechado:
                raise ArquivoRawErro(f"{self.tabela}/{self.fonte}: arquivo já fechado")
            self._buffer.append(registro)
            if len(self._buffer) >= LOTE_MAX:
                self._flush_unlocked()

    def fechar(self) -> list[dict[str, Any]]:
        """Grava o restante e devolve os manifestos desta instância (vazio se já fechou)."""
        with self._lock:
            if self._fechado:
                return []
            self._flush_unlocked()
            self._fechado = True
            return list(self._manifestos)

    def _registro(self, chave: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(chave, dict) or not chave:
            raise ArquivoRawErro("chave do arquivo raw tem de ser um dict não vazio")
        if not isinstance(raw, dict):
            raise ArquivoRawErro("raw do arquivo tem de ser um dict (o payload da coluna)")
        if any(not isinstance(k, str) or not k for k in chave):
            raise ArquivoRawErro("chaves do dict `chave` têm de ser strings não vazias")
        coletado_em = _iso(self._relogio())
        registro = {
            "tabela": self.tabela,
            "fonte": self.fonte,
            "chave": copy.deepcopy(chave),
            "coletado_em": coletado_em,
            "raw": copy.deepcopy(raw),
        }
        try:
            json.dumps(registro, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as e:
            raise ArquivoRawErro(f"linha do arquivo raw não é JSON: {e}") from e
        return registro

    def _flush_unlocked(self) -> None:
        if not self._buffer:
            return
        lote = self._lote
        linhas = list(self._buffer)
        dia = min(ln["coletado_em"] for ln in linhas)[:10]
        objeto = nome_objeto(self.tabela, self.fonte, dia, self.execucao_id, lote)
        dados = _jsonl_gz(linhas)
        md5_hex = hashlib.md5(dados).hexdigest()
        md5_b64 = base64.b64encode(hashlib.md5(dados).digest()).decode("ascii")
        try:
            uri = self._gravar(objeto, dados, md5_b64)
        except ArquivoRawErro:
            raise
        except Exception as e:
            raise ArquivoRawErro(
                f"upload do raw falhou ({objeto}): {e}. Coleta interrompida (fail closed)."
            ) from e
        ordenadas = sorted(linhas, key=lambda ln: _canonico(ln["chave"]))
        manifesto = {
            "uri": uri,
            "linhas": len(linhas),
            "md5": md5_hex,
            "chave_min": ordenadas[0]["chave"],
            "chave_max": ordenadas[-1]["chave"],
            "coletado_em": min(ln["coletado_em"] for ln in linhas),
        }
        self._buffer.clear()
        self._lote += 1
        self._manifestos.append(manifesto)
        log.info("arquivo raw %s linhas=%s md5=%s", uri, manifesto["linhas"], md5_hex)

    def _gravar(self, objeto: str, dados: bytes, md5_b64: str) -> str:
        if self._local:
            destino = self._diretorio / objeto
            destino.parent.mkdir(parents=True, exist_ok=True)
            if destino.exists():
                raise ArquivoRawErro(
                    f"objeto local já existe ({destino}); não sobrescreve (if_generation_match=0)."
                )
            destino.write_bytes(dados)
            return destino.resolve().as_uri()
        blob = self._cliente_gcs().bucket(BUCKET).blob(objeto)
        blob.upload_from_string(
            dados,
            content_type="application/gzip",
            if_generation_match=0,
            checksum="md5",
        )
        servidor = getattr(blob, "md5_hash", None)
        if not servidor or not _md5_igual(md5_b64, servidor):
            raise ArquivoRawErro(
                f"md5 do objeto {objeto} não confere com o md5Hash do GCS "
                f"(local {md5_b64}, servidor {servidor!r}). Coleta interrompida (fail closed)."
            )
        return f"gs://{BUCKET}/{objeto}"

    def _cliente_gcs(self) -> Any:
        if self._cliente is None:
            # ADC: no Cloud Run, a conta de serviço do job. Sem chave no código.
            self._cliente = storage.Client()
        return self._cliente


def _validar_tabela(tabela: str) -> None:
    if tabela not in TABELAS:
        raise ArquivoRawErro(f"tabela fora do arquivo raw: {tabela!r}")


def _validar_fonte(fonte: str) -> None:
    if not isinstance(fonte, str) or not _FONTE.fullmatch(fonte):
        raise ArquivoRawErro(f"fonte inválida no caminho do arquivo: {fonte!r}")


def _validar_execucao(execucao_id: str) -> None:
    if not isinstance(execucao_id, str) or not _UUID.fullmatch(execucao_id):
        raise ArquivoRawErro(f"execucao_id tem de ser uuid: {execucao_id!r}")


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _canonico(chave: dict[str, Any]) -> str:
    return json.dumps(chave, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _jsonl_gz(linhas: list[dict[str, Any]]) -> bytes:
    texto = "".join(
        json.dumps(ln, ensure_ascii=False, separators=(",", ":")) + "\n" for ln in linhas
    )
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(texto.encode("utf-8"))
    return buf.getvalue()


def _md5_igual(esperado_b64: str, servidor_b64: str) -> bool:
    try:
        return base64.b64decode(esperado_b64) == base64.b64decode(servidor_b64)
    except (ValueError, TypeError):
        return False
