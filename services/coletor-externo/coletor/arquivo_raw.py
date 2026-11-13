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

Destino Supabase Storage (ARQUIVO_RAW_DESTINO=supabase; 12/11/2026): o coletor no
GitHub Actions não tem credencial do GCP, e com ARQUIVO_RAW_GCS=0 o arquivo ia para
o disco do runner e se perdia no fim do job. Nesse destino o objeto vai para o
bucket privado `arquivo-raw` do Supabase (migration 20261112180000), no mesmo
caminho `arquivo-db/...`, com a service role que o job já usa (SUPABASE_URL e
SUPABASE_SERVICE_ROLE_KEY). Imutável (x-upsert: false); a conferência baixa o
objeto e compara o md5; reenvio que encontra o mesmo conteúdo é aceito. Falha
persistente levanta ArquivoRawErro (fail closed). URI: supabase://arquivo-raw/<objeto>.
ARQUIVO_RAW_DESTINO aceita gcs | supabase | local; ausente = gcs, ou local com
ARQUIVO_RAW_GCS=0.

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
import random
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests
from google.cloud import storage

log = logging.getLogger("coletor.arquivo_raw")

BUCKET = "licitagym-documentos"
LOTE_MAX = 1000
TABELAS = frozenset({"licitacao_itens", "licitacao_resultados", "precos_praticados_itens"})
_FONTE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_DIA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_DESLIGA = frozenset({"0", "false", "no", "off"})
DESTINOS = frozenset({"gcs", "supabase", "local"})
BUCKET_SUPABASE = "arquivo-raw"
TIMEOUT_SUPABASE = 60
TENTATIVAS_SUPABASE = 5


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
        http: Any = None,
        dormir: Callable[[float], None] | None = None,
    ) -> None:
        _validar_tabela(tabela)
        _validar_fonte(fonte)
        self.tabela = tabela
        self.fonte = fonte
        self.execucao_id = execucao_id or str(uuid.uuid4())
        _validar_execucao(self.execucao_id)
        self._destino = "local" if dry_run else _destino()
        self._local = self._destino == "local"
        self._http = http
        self._dormir = dormir or time.sleep
        self._supabase_url = self._supabase_chave = ""
        if self._destino == "supabase":
            self._supabase_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
            self._supabase_chave = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
            if not self._supabase_url or not self._supabase_chave:
                raise ArquivoRawErro(
                    "ARQUIVO_RAW_DESTINO=supabase exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (fail closed).")
            if not self._supabase_url.startswith("https://"):
                raise ArquivoRawErro("SUPABASE_URL tem de ser https:// (a service role não vai em texto puro).")
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
        if self._destino == "supabase":
            return self._gravar_supabase(objeto, dados)
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

    def _gravar_supabase(self, objeto: str, dados: bytes) -> str:
        base = f"{self._supabase_url}/storage/v1/object"
        auth = {"Authorization": f"Bearer {self._supabase_chave}", "apikey": self._supabase_chave}
        cabecalhos = {**auth, "Content-Type": "application/gzip", "x-upsert": "false"}
        r = self._pedir_supabase("upload", objeto, lambda http: http.post(
            f"{base}/{BUCKET_SUPABASE}/{objeto}", data=dados, headers=cabecalhos,
            timeout=TIMEOUT_SUPABASE, allow_redirects=False), aceita_duplicado=True)
        texto = (getattr(r, "text", "") or "").lower()
        if r.status_code != 200 and not _duplicado(r):
            raise ArquivoRawErro(
                f"upload do raw no Supabase Storage recusado ({objeto}): HTTP {r.status_code} {texto[:200]}. "
                "Coleta interrompida (fail closed).")
        # Duplicate: o objeto já existe (reenvio depois de timeout, ou caminho repetido). Só vale se o conteúdo no
        # bucket for o mesmo: a conferência decide.
        self._conferir_supabase(base, auth, objeto, dados, existia=_duplicado(r))
        return f"supabase://{BUCKET_SUPABASE}/{objeto}"

    def _conferir_supabase(self, base: str, auth: dict[str, str], objeto: str, dados: bytes, *,
                           existia: bool) -> None:
        # identity: o objeto é baixado como foi gravado (sem o servidor ou o CDN descomprimir o gzip no caminho).
        cabecalhos = {**auth, "Accept-Encoding": "identity"}
        r = self._pedir_supabase("conferência", objeto, lambda http: http.get(
            f"{base}/authenticated/{BUCKET_SUPABASE}/{objeto}", headers=cabecalhos,
            timeout=TIMEOUT_SUPABASE, allow_redirects=False))
        if r.status_code != 200:
            raise ArquivoRawErro(
                f"conferência do raw no Supabase Storage: HTTP {r.status_code} ({objeto}). "
                "Coleta interrompida (fail closed).")
        local = hashlib.md5(dados).hexdigest()
        recebido = r.content
        if hashlib.md5(recebido).hexdigest() != local and recebido != gzip.decompress(dados):
            motivo = ("o objeto já existia com outro conteúdo e não é sobrescrito" if existia
                      else "md5 do objeto baixado não confere com o gerado")
            raise ArquivoRawErro(f"{motivo} ({objeto}; md5 local {local}). Coleta interrompida (fail closed).")

    def _pedir_supabase(self, etapa: str, objeto: str, chamar: Callable[[Any], Any], *,
                        aceita_duplicado: bool = False) -> Any:
        """Chamada ao Storage com retry: rede, 429 e 5xx esperam (Retry-After ou backoff com jitter, até 60 s) e
        tentam de novo, com log de cada tentativa; o resto volta para quem chamou decidir (fail closed)."""
        http = self._http or requests
        ultimo = ""
        for tentativa in range(TENTATIVAS_SUPABASE):
            try:
                r = chamar(http)
            except requests.RequestException as e:
                r, ultimo = None, f"rede: {type(e).__name__}"
            else:
                if not (r.status_code == 429 or r.status_code >= 500) or (aceita_duplicado and _duplicado(r)):
                    return r
                ultimo = f"HTTP {r.status_code}"
            if tentativa == TENTATIVAS_SUPABASE - 1:
                break
            espera = _retry_after(r) if r is not None else None
            espera = min(60.0, espera if espera is not None else 5 * 2 ** tentativa + random.uniform(0, 1))
            log.warning("raw supabase %s %s: tentativa %s/%s, %s, espera %.0fs", etapa, objeto, tentativa + 1,
                        TENTATIVAS_SUPABASE, ultimo, espera)
            self._dormir(espera)
        raise ArquivoRawErro(
            f"{etapa} do raw no Supabase Storage falhou ({objeto}) após {TENTATIVAS_SUPABASE} tentativas: "
            f"{ultimo}. Coleta interrompida (fail closed).")

    def _cliente_gcs(self) -> Any:
        if self._cliente is None:
            # ADC: no Cloud Run, a conta de serviço do job. Sem chave no código.
            self._cliente = storage.Client()
        return self._cliente


def _destino() -> str:
    """gcs | supabase | local, de ARQUIVO_RAW_DESTINO; ausente = gcs, ou local com ARQUIVO_RAW_GCS=0."""
    valor = (os.environ.get("ARQUIVO_RAW_DESTINO") or "").strip().lower()
    if not valor:
        return "gcs" if gcs_ligado() else "local"
    if valor not in DESTINOS:
        raise ArquivoRawErro(f"ARQUIVO_RAW_DESTINO inválido: {valor!r} (use gcs, supabase ou local)")
    return valor


def _duplicado(resposta: Any) -> bool:
    """O Storage responde objeto existente com 409, ou 400 com statusCode 409 e error "Duplicate" no corpo."""
    texto = (getattr(resposta, "text", "") or "").lower()
    return resposta.status_code in (400, 409) and ("duplicate" in texto or "already exists" in texto)


def _retry_after(resposta: Any) -> float | None:
    bruto = (getattr(resposta, "headers", None) or {}).get("Retry-After")
    try:
        return min(300.0, max(1.0, float(bruto))) if bruto is not None else None
    except (TypeError, ValueError):
        return None


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
