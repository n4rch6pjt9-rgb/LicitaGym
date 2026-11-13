from unittest.mock import patch

import pytest

from coletor.destino import Armazenamento, sha256
from coletor.versionamento import processar_versao


def executar(arm, conteudo=b"edital"):
    return processar_versao(
        sb=object(),
        arm=arm,
        documento_id=10,
        caminho_base="portal/123",
        secao="processo",
        conteudo=conteudo,
        mime_type="application/pdf",
    )


def registro(documento_id, digest, uri, tamanho, mime, id_=1):
    return {
        "id": id_,
        "documento_id": documento_id,
        "sha256": digest,
        "storage_uri": uri,
        "tamanho_bytes": tamanho,
        "mime_type": mime,
    }


def test_primeira_versao(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))

    def registrar(sb, documento_id, digest, uri, tamanho, mime):
        return registro(documento_id, digest, uri, tamanho, mime), True

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=registrar,
    ) as gravar:
        resultado, criada = executar(arm)

    assert criada is True
    assert resultado["sha256"] == sha256(b"edital")
    assert gravar.call_count == 1
    assert (tmp_path / "portal").exists()


def test_hash_repetido(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))

    def registrar(sb, documento_id, digest, uri, tamanho, mime):
        return registro(documento_id, digest, uri, tamanho, mime), True

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=registrar,
    ):
        primeira, _ = executar(arm)

    with patch(
        "coletor.versionamento.buscar_versao", return_value=primeira
    ), patch(
        "coletor.versionamento.salvar_imutavel"
    ) as salvar, patch(
        "coletor.versionamento.registrar_versao_com_estado"
    ) as gravar:
        segunda, criada = executar(arm)

    assert criada is False
    assert segunda == primeira
    salvar.assert_not_called()
    gravar.assert_not_called()


def test_conteudo_alterado(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))
    sequencia = iter([1, 2])

    def registrar(sb, documento_id, digest, uri, tamanho, mime):
        return registro(
            documento_id, digest, uri, tamanho, mime,
            id_=next(sequencia),
        ), True

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=registrar,
    ) as gravar:
        primeira, _ = executar(arm, b"edital")
        segunda, criada = executar(arm, b"errata")

    assert criada is True
    assert primeira["id"] == 1
    assert segunda["id"] == 2
    assert primeira["sha256"] != segunda["sha256"]
    assert primeira["storage_uri"] != segunda["storage_uri"]
    assert gravar.call_count == 2


def test_falha_storage_nao_registra(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.salvar_imutavel",
        side_effect=RuntimeError("Storage indisponível"),
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado"
    ) as gravar:
        with pytest.raises(RuntimeError, match="Storage indisponível"):
            executar(arm)

    gravar.assert_not_called()


def test_falha_banco_nao_oculta_erro(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=RuntimeError("Banco indisponível"),
    ):
        with pytest.raises(RuntimeError, match="Banco indisponível"):
            executar(arm)
