"""Contrato P0.3.5: preservar registros existentes antes do versionamento."""

import ast
from pathlib import Path

COLETOR = (
    Path(__file__).resolve().parents[3]
    / "services/coletor-externo/coletor/documentos_paradigma.py"
)


def test_upsert_nao_recebe_todos_os_anexos_indistintamente():
    arvore = ast.parse(COLETOR.read_text(encoding="utf-8"))
    classe = next(
        n for n in arvore.body
        if isinstance(n, ast.ClassDef)
        and n.name == "DocumentosParadigma"
    )
    metodo = next(
        n for n in classe.body
        if isinstance(n, ast.FunctionDef)
        and n.name == "sincronizar"
    )

    for node in ast.walk(metodo):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr != "upsert" or len(node.args) < 2:
            continue

        tabela = node.args[0]
        if not (
            isinstance(tabela, ast.Constant)
            and tabela.value == "licitacao_documentos"
        ):
            continue

        payload = ast.unparse(node.args[1])

        assert payload != "linhas", (
            "O upsert recebe todos os anexos, inclusive documentos "
            "existentes, antes de confirmar a nova versão."
        )
