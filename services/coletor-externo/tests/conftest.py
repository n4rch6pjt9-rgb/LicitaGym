"""A suíte não fala com o GCS. ARQUIVO_RAW_GCS=1 num teste liga o cliente injetado."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def arquivo_raw_local(monkeypatch, tmp_path):
    pasta = tmp_path / "arquivo-raw"
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "0")
    monkeypatch.setenv("ARQUIVO_RAW_DIR", str(pasta))
    return pasta


@pytest.fixture(autouse=True)
def sem_enriquecimento_0031_no_main(request, monkeypatch):
    """Nos testes do main da spec 0009 (test_precos_agendado), o passo de estimado e link da spec 0031 responde sucesso
    sem rede: ele tem testes próprios em test_compras_itens_contratacao.py."""
    if request.module.__name__.rsplit(".", 1)[-1] != "test_precos_agendado":
        return
    from coletor import compras_itens_contratacao

    monkeypatch.setattr(compras_itens_contratacao, "coletar", lambda cliente, sb, limite=0: {"sucesso": True, "erros": []})
