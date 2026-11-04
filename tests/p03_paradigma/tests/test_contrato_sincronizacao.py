"""Contratos de segurança da sincronização Paradigma."""

import ast
from pathlib import Path


COLETOR = (
    Path(__file__).resolve().parents[3]
    / "services"
    / "coletor-externo"
    / "coletor"
    / "documentos_paradigma.py"
)


def obter_metodo(nome):
    arvore = ast.parse(COLETOR.read_text())
    classe = next(
        n for n in arvore.body
        if isinstance(n, ast.ClassDef)
        and n.name == "DocumentosParadigma"
    )
    return next(
        n for n in classe.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and n.name == nome
    )


def test_nao_apagar_remocao_historica_no_payload():
    metodo = obter_metodo("linha")

    for node in ast.walk(metodo):
        if not isinstance(node, ast.Dict):
            continue

        for chave in node.keys:
            if (
                isinstance(chave, ast.Constant)
                and chave.value == "removido_do_portal_em"
            ):
                raise AssertionError(
                    "Payload de upsert contém removido_do_portal_em; "
                    "pode apagar informação histórica"
                )


def test_nao_ignorar_documentos_ja_baixados():
    metodo = obter_metodo("sincronizar")

    for node in ast.walk(metodo):
        if not isinstance(node, ast.If):
            continue

        condicao = ast.unparse(node.test)

        if (
            "status_processamento" in condicao
            and "pendente" in condicao
            and "erro" in condicao
            and "sha256" in condicao
            and any(
                isinstance(n, ast.Continue)
                for n in ast.walk(node)
            )
        ):
            raise AssertionError(
                "Coletor ainda ignora documentos já baixados"
            )


def test_nao_utilizar_storage_mutavel():
    metodo = obter_metodo("sincronizar")

    chamadas = [
        node for node in ast.walk(metodo)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "salvar"
    ]

    assert not chamadas, (
        "Coletor ainda utiliza salvar() com sobrescrita"
    )
