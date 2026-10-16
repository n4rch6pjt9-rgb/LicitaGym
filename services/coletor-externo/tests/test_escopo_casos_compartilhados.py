"""Spec 0029, CA-10: o Python bate com o gabarito de escopo que a Edge Function também usa."""
from __future__ import annotations

import json

from coletor import escopo_casos as ec

DADOS = json.loads(ec.ARQUIVO.read_text(encoding="utf-8"))


def test_gabarito_cobre_todas_as_funcoes_e_todo_o_corpus():
    assert DADOS["funcoes"] == sorted(ec.FUNCOES)
    assert all(sorted(c["esperado"]) == DADOS["funcoes"] for c in DADOS["casos"])
    textos = {c["entrada"] for c in DADOS["casos"]}
    faltando = [t for t in ec.corpus() if t not in textos]
    assert not faltando, (f"{len(faltando)} textos novos nos testes de escopo; regrave o gabarito com "
                          "`python -m coletor.escopo_casos --gravar` e revise o diff")


def test_python_bate_com_o_gabarito():
    divergentes = []
    for caso in DADOS["casos"]:
        for nome, esperado in caso["esperado"].items():
            obtido = ec.FUNCOES[nome](caso["entrada"])
            if obtido != esperado:
                divergentes.append(f"{nome}({caso['entrada'][:60]!r}): esperado {esperado!r}, obtido {obtido!r}")
    assert not divergentes, (f"{len(divergentes)} divergências (a regra mudou? regrave com "
                             "`python -m coletor.escopo_casos --gravar`):\n" + "\n".join(divergentes[:20]))


def test_arquivo_esta_no_formato_gerado():
    assert ec.ARQUIVO.read_text(encoding="utf-8") == ec.serializar(DADOS)


def test_corpus_ignora_docstrings_e_identificadores(tmp_path):
    fonte = tmp_path / "test_escopo_x.py"
    fonte.write_text('"""Docstring do módulo que não é caso."""\n'
                     'X = ["Aquisição de esteira ergométrica", "termos_busca", "texto, esperado", "numeroItem",\n'
                     '     "46634234000191-1-000058/2025", "tatame"]\n', encoding="utf-8")
    assert ec.corpus([fonte]) == ["Aquisição de esteira ergométrica", "tatame"]
