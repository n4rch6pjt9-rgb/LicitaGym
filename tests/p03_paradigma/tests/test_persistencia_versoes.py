from types import SimpleNamespace
from unittest.mock import patch

import pytest

from coletor.persistencia_versoes import (
    buscar_versao,
    registrar_versao,
)


def cliente():
    return SimpleNamespace(
        base="https://exemplo.invalid/rest/v1",
        h={"Authorization": "Bearer TESTE"},
    )


def test_insercao_sem_merge():
    linha = {"id": 1, "documento_id": 10}
    resposta = SimpleNamespace(
        status_code=201,
        json=lambda: [linha],
        text="",
    )

    with patch(
        "coletor.persistencia_versoes.requests.post",
        return_value=resposta,
    ) as post:
        resultado = registrar_versao(
            cliente(), 10, "a" * 64,
            "supabase://teste/a", 100, "application/pdf",
        )

    assert resultado == linha
    assert post.call_args.kwargs["headers"]["Prefer"] == \
        "return=representation"
    assert post.call_args.kwargs["json"]["sha256"] == "a" * 64


def test_conflito_nao_silenciado():
    resposta = SimpleNamespace(
        status_code=409,
        text="duplicate key",
    )

    with patch(
        "coletor.persistencia_versoes.requests.post",
        return_value=resposta,
    ):
        with pytest.raises(RuntimeError, match="HTTP 409"):
            registrar_versao(
                cliente(), 10, "a" * 64,
                "supabase://teste/a", 100, None,
            )


def test_erro_servidor_nao_silenciado():
    resposta = SimpleNamespace(
        status_code=500,
        text="internal error",
    )

    with patch(
        "coletor.persistencia_versoes.requests.post",
        return_value=resposta,
    ):
        with pytest.raises(RuntimeError, match="HTTP 500"):
            registrar_versao(
                cliente(), 10, "a" * 64,
                "supabase://teste/a", 100, None,
            )


def test_busca_versao_existente():
    sb = cliente()
    sb.selecionar = lambda *args, **kwargs: [
        {"id": 1, "documento_id": 10, "sha256": "a" * 64}
    ]

    resultado = buscar_versao(sb, 10, "a" * 64)
    assert resultado["id"] == 1


def test_duplicidade_detectada():
    sb = cliente()
    sb.selecionar = lambda *args, **kwargs: [
        {"id": 1}, {"id": 2}
    ]

    with pytest.raises(RuntimeError, match="duplicadas"):
        buscar_versao(sb, 10, "a" * 64)
