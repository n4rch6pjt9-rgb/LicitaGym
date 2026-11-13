from unittest.mock import patch

import pytest

from coletor import ia


def executar_retry(fn, **kwargs):
    # Não inicializa o cliente remoto Gemini.
    gemini = object.__new__(ia.Gemini)
    return gemini._retry(fn, **kwargs)


def falha_transitoria():
    raise RuntimeError("falha simulada")


def test_retry_com_jitter():
    chamadas = []

    def fn():
        chamadas.append(1)
        if len(chamadas) == 1:
            falha_transitoria()
        return "ok"

    with (
        patch.object(ia, "transitorio", return_value=True),
        patch.object(ia.random, "uniform", return_value=0.75) as jitter,
        patch.object(ia.time, "sleep") as sleep,
    ):
        assert executar_retry(fn, tentativas=2) == "ok"

    jitter.assert_called_once()
    sleep.assert_called_once_with(5.75)
    assert len(chamadas) == 2


def test_retry_respeita_esperas_personalizadas():
    chamadas = []

    def fn():
        chamadas.append(1)
        if len(chamadas) < 3:
            falha_transitoria()
        return "ok"

    with (
        patch.object(ia, "transitorio", return_value=True),
        patch.object(ia.random, "uniform") as jitter,
        patch.object(ia.time, "sleep") as sleep,
    ):
        assert executar_retry(
            fn, tentativas=3, esperas=(0.1, 0.2)
        ) == "ok"

    assert [c.args[0] for c in sleep.call_args_list] == [0.1, 0.2]
    jitter.assert_not_called()


def test_retry_nao_repete_erro_permanente():
    with (
        patch.object(ia, "transitorio", return_value=False),
        patch.object(ia.time, "sleep") as sleep,
    ):
        with pytest.raises(RuntimeError, match="falha simulada"):
            executar_retry(falha_transitoria)

    sleep.assert_not_called()


def test_retry_respeita_limite_de_tentativas():
    chamadas = []

    def fn():
        chamadas.append(1)
        falha_transitoria()

    with (
        patch.object(ia, "transitorio", return_value=True),
        patch.object(ia.time, "sleep") as sleep,
    ):
        with pytest.raises(RuntimeError, match="falha simulada"):
            executar_retry(fn, tentativas=3, esperas=(0,))

    assert len(chamadas) == 3
    assert sleep.call_count == 2
