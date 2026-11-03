"""Arquivo do raw no GCS: formato, caminho, lotes, md5, fail closed e ausência no upsert."""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from coletor import arquivo_raw as A
from coletor import compras_precos, pncp as P
from coletor.arquivo_raw import ArquivoRaw, ArquivoRawErro
from test_compras_novos_coletores import SAMPLE_PRECO_ITEM
from test_pncp import COMPRA, ITENS, RESULTADO, _pncp

EID = "11111111-1111-4111-8111-111111111111"
QUANDO = datetime(2026, 10, 4, 3, 15, 0, tzinfo=timezone.utc)


def _relogio():
    return QUANDO


def _ler(pasta: Path, tabela: str) -> list[dict]:
    linhas = []
    for caminho in sorted((pasta / "arquivo-db" / tabela).rglob("*.jsonl.gz")):
        with gzip.open(caminho, "rt", encoding="utf-8") as fh:
            for linha in fh:
                linhas.append(json.loads(linha))
    return linhas


def _sb():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    return sb


class _Blob:
    def __init__(self, bucket, nome):
        self.bucket = bucket
        self.nome = nome
        self.md5_hash = None
        self.generation = None
        self.kwargs = None
        self.dados = None

    def upload_from_string(self, dados, **kwargs):
        if self.bucket.falha is not None:
            raise self.bucket.falha
        if kwargs.get("if_generation_match") == 0 and self.generation is not None:
            raise RuntimeError("412 precondition")
        digest = hashlib.md5(dados).digest()
        self.md5_hash = base64.b64encode(b"\x00" * 16).decode("ascii") if self.bucket.md5_errado else (
            base64.b64encode(digest).decode("ascii"))
        self.generation = 1
        self.kwargs = kwargs
        self.dados = dados
        self.bucket.uploads.append(self)


class _Bucket:
    def __init__(self):
        self.blobs = {}
        self.uploads = []
        self.falha = None
        self.md5_errado = False

    def blob(self, nome):
        self.blobs.setdefault(nome, _Blob(self, nome))
        return self.blobs[nome]


class _Cliente:
    def __init__(self, bucket):
        self._bucket = bucket
        self.buckets = []

    def bucket(self, nome):
        self.buckets.append(nome)
        return self._bucket


def test_linha_caminho_e_md5_local(arquivo_raw_local):
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=_relogio, diretorio=arquivo_raw_local)
    arq.adicionar({"licitacao_id": 9, "numero_item": 1}, {"descricao": "Halter", "cnpj": "04372852000160"})
    (man,) = arq.fechar()
    assert man["linhas"] == 1
    assert man["chave_min"] == {"licitacao_id": 9, "numero_item": 1}
    assert man["chave_max"] == man["chave_min"]
    assert man["coletado_em"] == "2026-10-04T03:15:00.000000Z"
    assert man["uri"].endswith(
        "arquivo-db/licitacao_itens/pncp/2026-10-04/"
        "11111111-1111-4111-8111-111111111111-0001.jsonl.gz")
    caminho = next(arquivo_raw_local.rglob("*.jsonl.gz"))
    dados = caminho.read_bytes()
    assert hashlib.md5(dados).hexdigest() == man["md5"]
    with gzip.open(caminho, "rt", encoding="utf-8") as fh:
        linha = json.loads(fh.readline())
    assert list(linha) == ["tabela", "fonte", "chave", "coletado_em", "raw"]
    assert linha["tabela"] == "licitacao_itens" and linha["fonte"] == "pncp"
    texto = gzip.decompress(dados).decode("utf-8")
    assert linha["raw"]["cnpj"] == "04372852000160"
    assert "04372852000160" in texto and "\\u" not in texto


def test_lotes_de_mil(arquivo_raw_local):
    arq = ArquivoRaw("licitacao_resultados", "pncp", execucao_id=EID, relogio=_relogio,
                     diretorio=arquivo_raw_local)
    for i in range(1001):
        arq.adicionar({"n": i}, {"i": i})
    mans = arq.fechar()
    assert [m["linhas"] for m in mans] == [1000, 1]
    assert mans[0]["uri"].endswith("-0001.jsonl.gz")
    assert mans[1]["uri"].endswith("-0002.jsonl.gz")
    primeiro = [{"n": i} for i in range(1000)]
    ordenadas = sorted(primeiro, key=A._canonico)
    assert mans[0]["chave_min"] == ordenadas[0]
    assert mans[0]["chave_max"] == ordenadas[-1]
    assert len(_ler(arquivo_raw_local, "licitacao_resultados")) == 1001


def test_modo_local_nao_usa_o_cliente(monkeypatch, arquivo_raw_local):
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "0")

    def proibido():
        raise AssertionError("modo local não pode abrir o GCS")

    monkeypatch.setattr(A.storage, "Client", proibido)
    cliente = MagicMock(side_effect=AssertionError("cliente injetado não é usado no modo local"))
    arq = ArquivoRaw("precos_praticados_itens", "compras-precos", execucao_id=EID, relogio=_relogio,
                     diretorio=arquivo_raw_local, cliente=cliente)
    arq.adicionar({"id_compra": "1", "id_item_compra": 2}, {"marca": "X"})
    man = arq.fechar()[0]
    assert man["uri"].startswith("file:")
    cliente.bucket.assert_not_called()
    outro = ArquivoRaw("precos_praticados_itens", "compras-precos", execucao_id=EID, relogio=_relogio,
                       diretorio=arquivo_raw_local)
    outro.adicionar({"id_compra": "1", "id_item_compra": 3}, {"marca": "Y"})
    with pytest.raises(ArquivoRawErro, match="já existe"):
        outro.fechar()


def test_dry_run_grava_local_mesmo_com_gcs_ligado(monkeypatch, arquivo_raw_local):
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "1")
    monkeypatch.setattr(A.storage, "Client", lambda: (_ for _ in ()).throw(AssertionError("ADC")))
    arq = ArquivoRaw("licitacao_itens", "sfiec", execucao_id=EID, dry_run=True, relogio=_relogio,
                     diretorio=arquivo_raw_local)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"a": 1})
    assert arq.fechar()[0]["uri"].startswith("file:")


def test_gcs_confere_md5_e_nao_sobrescreve(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "1")
    bucket = _Bucket()
    cliente = _Cliente(bucket)
    arq = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=_relogio, cliente=cliente)
    arq.adicionar({"licitacao_id": 1, "numero_item": 1}, {"descricao": "piso"})
    (man,) = arq.fechar()
    assert cliente.buckets == ["licitagym-documentos"]
    blob = bucket.uploads[0]
    assert blob.kwargs["if_generation_match"] == 0
    assert blob.kwargs["checksum"] == "md5"
    assert blob.kwargs["content_type"] == "application/gzip"
    assert man["uri"] == (
        "gs://licitagym-documentos/arquivo-db/licitacao_itens/pncp/2026-10-04/"
        "11111111-1111-4111-8111-111111111111-0001.jsonl.gz")
    assert man["md5"] == hashlib.md5(blob.dados).hexdigest()
    outro = ArquivoRaw("licitacao_itens", "pncp", execucao_id=EID, relogio=_relogio, cliente=cliente)
    outro.adicionar({"licitacao_id": 1, "numero_item": 2}, {"descricao": "outro"})
    with pytest.raises(ArquivoRawErro, match="fail closed"):
        outro.fechar()


def test_gcs_md5_divergente_e_falha_de_upload_param_a_coleta(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "1")
    bucket = _Bucket()
    bucket.md5_errado = True
    arq = ArquivoRaw("licitacao_resultados", "pncp", execucao_id=EID, relogio=_relogio, cliente=_Cliente(bucket))
    arq.adicionar({"licitacao_id": 1, "numero_item": 1, "sequencial_resultado": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="md5"):
        arq.fechar()

    bucket = _Bucket()
    bucket.falha = RuntimeError("timeout no GCS")
    arq = ArquivoRaw("licitacao_resultados", "pncp", execucao_id=EID, relogio=_relogio, cliente=_Cliente(bucket))
    arq.adicionar({"licitacao_id": 1, "numero_item": 1, "sequencial_resultado": 1}, {"x": 1})
    with pytest.raises(ArquivoRawErro, match="fail closed"):
        arq.fechar()


def test_pncp_nao_manda_raw_e_arquiva_a_chave(arquivo_raw_local):
    sb = _sb()
    P.coletar(_pncp([COMPRA]), sb, None, ["borracha granulada"], "todos", 1, 50,
              com_resultados=True, baixar_arquivos=False, max_bytes=10**8, dry_run=False, workers=1)
    tabelas = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}
    assert "raw" not in tabelas["licitacao_itens"][0]
    assert "raw" not in tabelas["licitacao_resultados"][0]
    assert isinstance(tabelas["licitacoes_externas"]["raw"], dict)
    assert tabelas["licitacao_documentos"][0]["raw"]["tipo_documento"] == "Edital"
    itens = _ler(arquivo_raw_local, "licitacao_itens")
    assert itens[0]["chave"] == {"licitacao_id": 9, "numero_item": 1}
    assert itens[0]["raw"]["descricao"] == ITENS[0]["descricao"]
    assert itens[0]["fonte"] == "pncp"
    res = _ler(arquivo_raw_local, "licitacao_resultados")
    assert res[0]["chave"]["sequencial_resultado"] == 1
    assert "niFornecedor" not in res[0]["raw"]
    assert res[0]["raw"]["nomeRazaoSocialFornecedor"].startswith("HG")


def test_pncp_pessoa_fisica_sai_do_raw_arquivado(arquivo_raw_local):
    sb = _sb()
    p = _pncp([COMPRA])
    p.resultados.return_value = [dict(RESULTADO[0], tipoPessoa="PF", niFornecedor="12345678901",
                                      nomeRazaoSocialFornecedor="Fulano de Tal")]
    p.arquivos.return_value = []
    P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, workers=1)
    res = _ler(arquivo_raw_local, "licitacao_resultados")[0]["raw"]
    assert "niFornecedor" not in res and "nomeRazaoSocialFornecedor" not in res
    enviado = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacao_resultados"][0]
    assert "raw" not in enviado


def test_compras_precos_nao_manda_raw(arquivo_raw_local):
    cliente = MagicMock()
    cliente.consultar_material.return_value = {"resultado": [SAMPLE_PRECO_ITEM], "totalRegistros": 1}
    sb = MagicMock()
    res = compras_precos.coletar(cliente, sb, itens=[480144], dry_run=False)
    payload = sb.upsert.call_args.args[1]
    assert sb.upsert.call_args.args[0] == "precos_praticados_itens"
    assert "raw" not in payload[0] and "_bruto" not in payload[0]
    assert "raw" not in compras_precos.normalizar_preco_praticado(SAMPLE_PRECO_ITEM)
    (linha,) = _ler(arquivo_raw_local, "precos_praticados_itens")
    assert linha["fonte"] == "compras-precos"
    assert linha["chave"] == {"id_compra": payload[0]["id_compra"], "id_item_compra": payload[0]["id_item_compra"]}
    assert linha["raw"]["marca"] == "FORTIX"
    assert linha["raw"]["niFornecedor"] == "04372852000160"
    assert res["arquivo_raw"][0]["linhas"] == 1
    assert res["arquivo_raw"][0]["md5"] == hashlib.md5(
        next((arquivo_raw_local / "arquivo-db" / "precos_praticados_itens").rglob("*.jsonl.gz")).read_bytes()
    ).hexdigest()


def test_compras_dry_run_grava_local_e_nao_upserta(arquivo_raw_local):
    cliente = MagicMock()
    cliente.consultar_material.return_value = {"resultado": [SAMPLE_PRECO_ITEM], "totalRegistros": 1}
    sb = MagicMock()
    compras_precos.coletar(cliente, sb, itens=[480144], dry_run=True)
    sb.upsert.assert_not_called()
    assert _ler(arquivo_raw_local, "precos_praticados_itens")[0]["raw"]["idItemCompra"] == 5858679


def test_falha_de_upload_interrompe_os_coletores(monkeypatch):
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "1")

    class _Quebrado:
        def bucket(self, nome):
            raise RuntimeError("sem ADC")

    monkeypatch.setattr(A.storage, "Client", lambda: _Quebrado())
    with pytest.raises(ArquivoRawErro):
        P.coletar(_pncp([COMPRA]), _sb(), None, ["borracha granulada"], "todos", 1, 50,
                  True, False, 10**8, False, workers=1)
    cliente = MagicMock()
    cliente.consultar_material.return_value = {"resultado": [SAMPLE_PRECO_ITEM], "totalRegistros": 1}
    with pytest.raises(ArquivoRawErro):
        compras_precos.coletar(cliente, MagicMock(), itens=[480144], dry_run=False)
