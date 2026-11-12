"""Arquivo do raw no Supabase Storage (bucket privado `arquivo-raw`), destino do coletor no GitHub Actions.

Em 12/11/2026 o `coletor-pncp.yml` rodava com ARQUIVO_RAW_GCS=0: o JSONL.gz ia para o disco do runner e era
descartado no fim do job, e desde 04/10 `licitacao_itens.raw` fica NULL (o original iria para o arquivo). O Actions não
tem credencial do GCP (sem Workload Identity e sem chave JSON, por regra); o destino do Actions passa a ser o Storage
do próprio Supabase, com a service role que o job já usa. Mesmo caminho do contrato gcs-raw-1, mesmo fail closed."""
from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime, timezone

import pytest

from coletor.arquivo_raw import ArquivoRaw, ArquivoRawErro

EID = "11111111-1111-4111-8111-111111111111"
QUANDO = datetime(2026, 11, 12, 10, 0, 0, tzinfo=timezone.utc)
URL = "https://projeto.supabase.co"
CHAVE = "chave-service-role-de-teste"
OBJETO = "arquivo-db/licitacao_itens/pncp/2026-11-12/11111111-1111-4111-8111-111111111111-0001.jsonl.gz"


class _Resp:
    def __init__(self, status, content=b"", headers=None, text=""):
        self.status_code = status
        self.content = content
        self.headers = headers or {}
        self.text = text or (content.decode("utf-8", "replace") if isinstance(content, bytes) else "")


class _Storage:
    """Storage falso: guarda os objetos e registra as chamadas."""

    def __init__(self):
        self.objetos: dict[str, bytes] = {}
        self.chamadas: list[tuple] = []
        self.respostas_post: list = []
        self.respostas_get: list = []
        self.corromper_download = False
        self.descomprimir_download = False

    def post(self, url, data=None, headers=None, timeout=None, allow_redirects=True):
        assert allow_redirects is False
        self.chamadas.append(("POST", url, dict(headers or {}), timeout))
        if self.respostas_post:
            r = self.respostas_post.pop(0)
            if isinstance(r, Exception):
                raise r
            if r.status_code == 200:
                self.objetos[url.split("/object/arquivo-raw/", 1)[1]] = data
            return r
        caminho = url.split("/object/arquivo-raw/", 1)[1]
        if caminho in self.objetos:
            return _Resp(400, b'{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}')
        self.objetos[caminho] = data
        return _Resp(200, json.dumps({"Key": f"arquivo-raw/{caminho}"}).encode())

    def get(self, url, headers=None, timeout=None, allow_redirects=True):
        assert allow_redirects is False
        self.chamadas.append(("GET", url, dict(headers or {}), timeout))
        if self.respostas_get:
            r = self.respostas_get.pop(0)
            if isinstance(r, Exception):
                raise r
            if r is not None:
                return r
        caminho = url.split("/object/authenticated/arquivo-raw/", 1)[1]
        if caminho not in self.objetos:
            return _Resp(404, b'{"error":"not_found"}')
        dados = self.objetos[caminho]
        if self.descomprimir_download:  # servidor/CDN que entrega com Content-Encoding: gzip já decodificado
            return _Resp(200, gzip.decompress(dados))
        return _Resp(200, b"x" + dados if self.corromper_download else dados)


@pytest.fixture
def destino_supabase(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_DESTINO", "supabase")
    monkeypatch.setenv("SUPABASE_URL", URL)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", CHAVE)
    monkeypatch.delenv("ARQUIVO_RAW_GCS", raising=False)


def _arq(storage, **kw):
    return ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                      dormir=lambda s: None, **kw)


def test_supabase_grava_no_bucket_privado_e_confere_o_md5(destino_supabase):
    storage = _Storage()
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 2541, "numero_item": 3}, {"descricao": "Multi estação", "catalogoCodigoItem": 623742})
    (man,) = arq.fechar()

    metodo, url, headers, timeout = storage.chamadas[0]
    assert metodo == "POST"
    assert url == f"{URL}/storage/v1/object/arquivo-raw/{OBJETO}"
    assert headers["Authorization"] == f"Bearer {CHAVE}" and headers["apikey"] == CHAVE
    assert headers["Content-Type"] == "application/gzip"
    assert headers["x-upsert"] == "false"  # imutável: não sobrescreve (equivale ao if_generation_match=0)
    assert timeout and timeout > 0
    # Conferência: baixa o objeto pelo caminho autenticado e compara o md5 com o do gzip gerado.
    assert storage.chamadas[1][0] == "GET"
    assert storage.chamadas[1][1] == f"{URL}/storage/v1/object/authenticated/arquivo-raw/{OBJETO}"
    dados = storage.objetos[OBJETO]
    assert man["md5"] == hashlib.md5(dados).hexdigest()
    assert man["uri"] == f"supabase://arquivo-raw/{OBJETO}"
    linha = json.loads(gzip.decompress(dados).decode("utf-8").splitlines()[0])
    assert linha["raw"]["catalogoCodigoItem"] == 623742


def test_supabase_md5_divergente_para_a_coleta(destino_supabase):
    storage = _Storage()
    storage.corromper_download = True
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="md5"):
        arq.fechar()


def test_supabase_nao_sobrescreve_objeto_diferente(destino_supabase):
    storage = _Storage()
    storage.objetos[OBJETO] = b"conteudo anterior"
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="fail closed"):
        arq.fechar()
    assert storage.objetos[OBJETO] == b"conteudo anterior"


def test_supabase_reenvio_do_mesmo_objeto_e_aceito(destino_supabase):
    """Timeout depois de gravar: o reenvio recebe Duplicate, mas o objeto no bucket é o mesmo (md5 igual)."""
    storage = _Storage()
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    # Pré-grava exatamente o que o arquivo vai gerar, como se o primeiro POST tivesse gravado e caído na resposta.
    from coletor.arquivo_raw import _jsonl_gz  # noqa: PLC0415 (função interna, usada só para montar o caso)
    storage.objetos[OBJETO] = _jsonl_gz([arq._registro({"licitacao_id": 1, "numero_item": 1}, {"x": 1})])
    (man,) = arq.fechar()
    assert man["md5"] == hashlib.md5(storage.objetos[OBJETO]).hexdigest()


def test_supabase_retry_com_backoff_e_retry_after(destino_supabase):
    storage = _Storage()
    storage.respostas_post = [_Resp(503, b"indisponivel"), _Resp(429, b"lento", {"Retry-After": "7"}),
                              _Resp(200, b'{"Key":"ok"}')]
    esperas = []
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                     dormir=esperas.append)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    arq.fechar()
    assert [c[0] for c in storage.chamadas].count("POST") == 3
    assert len(esperas) == 2 and esperas[1] == 7


def test_supabase_erro_persistente_para_a_coleta(destino_supabase):
    storage = _Storage()
    storage.respostas_post = [_Resp(503, b"x")] * 10
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="fail closed"):
        arq.fechar()


def test_supabase_sem_credencial_falha_ao_abrir(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_DESTINO", "supabase")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(ArquivoRawErro, match="SUPABASE_URL"):
        ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID)


def test_destino_desconhecido_falha(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_DESTINO", "s3")
    with pytest.raises(ArquivoRawErro, match="ARQUIVO_RAW_DESTINO"):
        ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID)


def test_dry_run_continua_local_com_destino_supabase(destino_supabase, tmp_path):
    storage = _Storage()
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                     dry_run=True, diretorio=tmp_path)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    (man,) = arq.fechar()
    assert storage.chamadas == []
    assert man["uri"].startswith("file://")


def test_supabase_exige_https(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_DESTINO", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "http://projeto.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", CHAVE)
    with pytest.raises(ArquivoRawErro, match="https"):
        ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID)


@pytest.mark.parametrize("respostas", [
    [_Resp(403, b'{"error":"Unauthorized","message":"invalid signature"}')],
    [_Resp(503, b"x")] * 10,
])
def test_erro_nao_expoe_a_chave(destino_supabase, respostas):
    storage = _Storage()
    storage.respostas_post = list(respostas)
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro) as erro:
        arq.fechar()
    assert CHAVE not in str(erro.value)


def test_raw_de_precos_tira_cpf_e_nome_de_pessoa_fisica():
    from coletor.compras_precos import raw_arquivado  # noqa: PLC0415
    pf = {"idCompra": "1", "niFornecedor": "12345678901", "nomeFornecedor": "FULANO DE TAL", "marca": "X"}
    assert raw_arquivado(pf) == {"idCompra": "1", "marca": "X"}
    pj = {"idCompra": "1", "niFornecedor": "04372852000160", "nomeFornecedor": "W.E.V COMERCIAL LTDA"}
    assert raw_arquivado(pj) == pj


def test_get_da_conferencia_tambem_tenta_de_novo(destino_supabase):
    import requests  # noqa: PLC0415
    storage = _Storage()
    storage.respostas_get = [_Resp(503, b"x"), requests.ConnectionError("caiu"), None]
    esperas = []
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                     dormir=esperas.append)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    (man,) = arq.fechar()
    assert man["uri"].startswith("supabase://")
    assert len(esperas) == 2 and all(e <= 60 for e in esperas)
    get = [c for c in storage.chamadas if c[0] == "GET"]
    assert get[0][2]["Accept-Encoding"] == "identity"


def test_get_404_para_na_hora_sem_retry(destino_supabase):
    storage = _Storage()
    storage.respostas_get = [_Resp(404, b'{"error":"not_found"}')]
    esperas = []
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                     dormir=esperas.append)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="HTTP 404"):
        arq.fechar()
    assert esperas == []


def test_erro_de_rede_no_post_tenta_de_novo_e_nao_dorme_depois_da_ultima(destino_supabase):
    import requests  # noqa: PLC0415
    storage = _Storage()
    storage.respostas_post = [requests.ConnectionError("x")] * 10
    esperas = []
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=lambda: QUANDO, http=storage,
                     dormir=esperas.append)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="rede"):
        arq.fechar()
    assert len(esperas) == 4  # 5 tentativas, 4 esperas: nada de dormir depois da última


def test_duplicado_como_http_409_com_mesmo_conteudo_e_aceito(destino_supabase):
    from coletor.arquivo_raw import _jsonl_gz  # noqa: PLC0415
    storage = _Storage()
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    storage.objetos[OBJETO] = _jsonl_gz([arq._registro({"licitacao_id": 1, "numero_item": 1}, {"x": 1})])
    storage.respostas_post = [_Resp(409, b'{"error":"Duplicate","message":"The resource already exists"}')]
    (man,) = arq.fechar()
    assert man["uri"] == f"supabase://arquivo-raw/{OBJETO}"


def test_download_ja_descomprimido_pelo_servidor_confere(destino_supabase):
    storage = _Storage()
    storage.descomprimir_download = True
    arq = _arq(storage)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"x": 1})
    (man,) = arq.fechar()
    assert man["md5"] == hashlib.md5(storage.objetos[OBJETO]).hexdigest()


def test_cpf_com_mascara_tambem_sai_do_raw_de_precos():
    from coletor.compras_precos import raw_arquivado  # noqa: PLC0415
    assert raw_arquivado({"niFornecedor": "123.456.789-01", "nomeFornecedor": "FULANO", "x": 1}) == {"x": 1}


def test_coletor_de_precos_passa_o_raw_pela_regra_antes_de_arquivar():
    import inspect  # noqa: PLC0415

    from coletor import compras_precos  # noqa: PLC0415
    assert "raw_arquivado(bruto)" in inspect.getsource(compras_precos._coletar_precos)
