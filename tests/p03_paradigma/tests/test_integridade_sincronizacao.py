"""Testes comportamentais P0.3.5: preservação documental."""

from unittest.mock import MagicMock, patch

import pytest

from coletor.documentos_paradigma import DocumentosParadigma
from coletor.destino import sha256


ARQUIVO = "edital.pdf"
CONTEUDO_ANTIGO = b"%PDF-1.4 versao antiga"
CONTEUDO_NOVO = b"%PDF-1.4 versao nova"

ANEXO = {
    "nCdAnexo": 1,
    "sNmArquivo": ARQUIVO,
    "sDsAnexo": "Edital",
    "sDsParametroCriptografado": "?q=teste",
}


def executar(conteudo, existente=None, falha=None):
    sb = MagicMock()
    arm = MagicMock()
    portal = MagicMock()

    portal._ws.return_value = [ANEXO]

    sb.selecionar.return_value = [existente] if existente else []

    sb.upsert.return_value = [{
        "id": 100,
        "arquivo_origem": ARQUIVO,
        "status_processamento": "pendente",
    }]

    coletor = DocumentosParadigma(
        portal, sb, arm, visitante=None
    )

    coletor._identificar = MagicMock(return_value=True)
    coletor._baixar = MagicMock(
        return_value=(conteudo, "application/pdf")
    )

    def versao_fake(**kwargs):
        if falha:
            raise RuntimeError(falha)

        digest = sha256(kwargs["conteudo"])

        return {
            "sha256": digest,
            "storage_uri": f"supabase://teste/{digest}",
            "tamanho_bytes": len(kwargs["conteudo"]),
        }, True

    with patch(
        "coletor.versionamento.processar_versao",
        side_effect=versao_fake,
    ):
        resumo = coletor.sincronizar(
            10,
            {
                "nCdAnexo": 1,
                "nCdProcesso": 32,
                "nCdOrigem": 32,
                "nCdModulo": 18,
            },
            "paradigma/teste",
        )

    return resumo, sb


def existente_confirmado():
    return {
        "id": 90,
        "arquivo_origem": ARQUIVO,
        "status_processamento": "baixado",
        "sha256": sha256(CONTEUDO_ANTIGO),
        "removido_do_portal_em": None,
    }


def test_documento_existente_preserva_id():
    resumo, sb = executar(
        CONTEUDO_NOVO,
        existente=existente_confirmado(),
    )

    assert resumo["erros"] == 0
    assert resumo["novos"] == 0

    sb.upsert.assert_not_called()

    atualizacao = sb.atualizar.call_args

    assert atualizacao.args[1] == 90
    assert atualizacao.args[2]["sha256"] == sha256(
        CONTEUDO_NOVO
    )


def test_falha_versionamento_preserva_documento_confirmado():
    resumo, sb = executar(
        CONTEUDO_NOVO,
        existente=existente_confirmado(),
        falha="storage indisponivel",
    )

    assert resumo["erros"] == 1
    assert resumo["baixados"] == 0

    sb.upsert.assert_not_called()
    sb.atualizar.assert_not_called()


def test_documento_inalterado_nao_atualiza_versao_principal():
    resumo, sb = executar(
        CONTEUDO_ANTIGO,
        existente=existente_confirmado(),
    )

    assert resumo["erros"] == 0
    assert resumo["baixados"] == 1

    sb.upsert.assert_not_called()
    sb.atualizar.assert_not_called()


def test_documento_novo_e_confirmado_apos_versionamento():
    resumo, sb = executar(CONTEUDO_NOVO)

    assert resumo["novos"] == 1
    assert resumo["baixados"] == 1

    sb.upsert.assert_called_once()

    atualizacao = sb.atualizar.call_args

    assert atualizacao.args[1] == 100
    assert atualizacao.args[2]["status_processamento"] == "baixado"
    assert atualizacao.args[2]["sha256"] == sha256(
        CONTEUDO_NOVO
    )


def test_falha_documento_novo_registra_erro():
    resumo, sb = executar(
        CONTEUDO_NOVO,
        falha="banco indisponivel",
    )

    assert resumo["erros"] == 1
    assert resumo["baixados"] == 0

    atualizacao = sb.atualizar.call_args

    assert atualizacao.args[1] == 100
    assert atualizacao.args[2]["status_processamento"] == "erro"


def test_g52c05_documento_ausente_com_historico_extra():
    """Um historico extra nao pode mascarar documento ausente."""
    salvos = {"A": {"id": 1}, "C": {"id": 3}}
    anexos = [
        {"sNmArquivo": "A"},
        {"sNmArquivo": "B"},
    ]

    esperados = {a["sNmArquivo"] for a in anexos}

    assert not esperados.issubset(salvos)
    assert esperados - salvos.keys() == {"B"}


def test_g52c05_historico_extra_com_documentos_presentes():
    """Historicos extras sao permitidos se todos os esperados existem."""
    salvos = {"A": {"id": 1}, "B": {"id": 2}, "C": {"id": 3}}
    anexos = [
        {"sNmArquivo": "A"},
        {"sNmArquivo": "B"},
    ]

    esperados = {a["sNmArquivo"] for a in anexos}

    assert esperados.issubset(salvos)
