"""Spec 0029, CA-10: o Python bate com o gabarito de escopo que a Edge Function também usa."""
from __future__ import annotations

import json

from coletor import escopo_casos as ec

DADOS = json.loads(ec.ARQUIVO.read_text(encoding="utf-8"))


def test_gabarito_e_corpus_sao_o_mesmo_conjunto():
    assert DADOS["funcoes"] == sorted(ec.FUNCOES)
    assert all(sorted(c["esperado"]) == DADOS["funcoes"] for c in DADOS["casos"])
    assert DADOS["textos"] == len(DADOS["casos"])
    no_gabarito = {c["entrada"] for c in DADOS["casos"]}
    atual = set(ec.corpus())
    novos, removidos = sorted(atual - no_gabarito), sorted(no_gabarito - atual)
    assert not novos and not removidos, (
        f"{len(novos)} textos novos e {len(removidos)} removidos nos testes; regrave o gabarito com "
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


def test_corpus_le_chamadas_parametrize_apelidos_e_lacos(tmp_path):
    fonte = tmp_path / "test_x.py"
    fonte.write_text(
        '"""Docstring do módulo que não é caso."""\n'
        "import pytest\n"
        "from coletor.escopo import classificar, item_core as ic\n"
        'FORA = ["Construção de quadra coberta", "Reforma de ginásio"]\n'
        'X = {"descricao": "Banco sueco de madeira", "numeroItem": 1}\n'
        "@pytest.mark.parametrize('texto,esperado', [('SBR', True), ('Aquisição de halter', False)])\n"
        "def test_a(texto, esperado):\n"
        '    assert classificar("Aquisição de esteira ergométrica") == "forte"\n'
        '    assert ic("tatame")\n'
        "    for o in FORA:\n"
        "        assert classificar(o) is None\n"
        '    classificar(X["descricao"])\n'
        '    assert outra_coisa("Texto de outra função")\n'
        "@pytest.mark.parametrize('modulo', ['Nome de módulo qualquer'])\n"
        "def test_b(modulo):\n"
        "    pass\n", encoding="utf-8")
    # X["descricao"] entra pelo valor do dict (o texto passado), nunca pela chave nem pelo índice
    assert ec.corpus([fonte]) == sorted(["Aquisição de esteira ergométrica", "Aquisição de halter", "Banco sueco de madeira",
                                         "Construção de quadra coberta", "Reforma de ginásio", "SBR", "tatame"])


def test_sinteticos_cobrem_o_que_difere_entre_python_e_javascript():
    juntos = "".join(ec.CASOS_SINTETICOS)
    for c in ("°", "–", "—", "“", " ", "\r\n", "\t", "ß", "🏋", "´", "×"):
        assert c in juntos
    assert set(ec.CASOS_SINTETICOS) <= {c["entrada"] for c in DADOS["casos"]}
