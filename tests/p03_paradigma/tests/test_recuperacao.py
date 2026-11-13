from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from coletor.destino import Armazenamento
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


def registro(documento_id, digest, uri, tamanho, mime):
    return {
        "id": 1,
        "documento_id": documento_id,
        "sha256": digest,
        "storage_uri": uri,
        "tamanho_bytes": tamanho,
        "mime_type": mime,
    }


def test_recupera_upload_apos_falha_banco(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))
    chamadas = []

    def registrar(sb, documento_id, digest, uri, tamanho, mime):
        chamadas.append(1)
        if len(chamadas) == 1:
            raise RuntimeError("Banco indisponível")
        return registro(documento_id, digest, uri, tamanho, mime), True

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=registrar,
    ):
        with pytest.raises(RuntimeError, match="Banco indisponível"):
            executar(arm)

        resultado, criada = executar(arm)

    assert criada is True
    assert resultado["id"] == 1
    assert len(chamadas) == 2


def test_objeto_divergente_e_rejeitado(tmp_path):
    arm = Armazenamento(pasta_local=str(tmp_path))

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado",
        side_effect=RuntimeError("Banco indisponível"),
    ):
        with pytest.raises(RuntimeError, match="Banco indisponível"):
            executar(arm)

    arquivos = [p for p in Path(tmp_path).rglob("*") if p.is_file()]
    assert len(arquivos) == 1
    arquivos[0].write_bytes(b"conteudo adulterado")

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado"
    ) as gravar:
        with pytest.raises(RuntimeError, match="diverge"):
            executar(arm)

    gravar.assert_not_called()


def test_recuperacao_remota_bloqueada():
    remoto = Mock()
    remoto.bucket = "licitacao-documentos"
    remoto.ler.side_effect = RuntimeError("Leitura remota indisponível")

    arm = SimpleNamespace(
        supabase=remoto,
        _bucket=None,
    )

    with patch(
        "coletor.versionamento.buscar_versao", return_value=None
    ), patch(
        "coletor.versionamento.salvar_imutavel",
        side_effect=FileExistsError(),
    ), patch(
        "coletor.versionamento.registrar_versao_com_estado"
    ) as gravar:
        with pytest.raises(RuntimeError, match="Leitura remota indisponível"):
            executar(arm)

    remoto.ler.assert_called_once()
    gravar.assert_not_called()
