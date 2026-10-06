"""A suíte não fala com o GCS. ARQUIVO_RAW_GCS=1 num teste liga o cliente injetado."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def arquivo_raw_local(monkeypatch, tmp_path):
    pasta = tmp_path / "arquivo-raw"
    monkeypatch.setenv("ARQUIVO_RAW_GCS", "0")
    monkeypatch.setenv("ARQUIVO_RAW_DIR", str(pasta))
    return pasta
