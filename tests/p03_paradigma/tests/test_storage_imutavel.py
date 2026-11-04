import tempfile
from pathlib import Path
from types import SimpleNamespace

from coletor.storage_imutavel import (
    caminho_versao,
    hash_conteudo,
    salvar_imutavel,
)


def test_hash_deterministico():
    assert hash_conteudo(b"edital") == hash_conteudo(b"edital")
    assert hash_conteudo(b"edital") != hash_conteudo(b"errata")


def test_caminho_por_hash():
    a = caminho_versao("portal/123", "processo", 10, b"edital")
    b = caminho_versao("portal/123", "processo", 10, b"errata")
    assert a != b
    assert "/10/" in a


def test_storage_local_nao_sobrescreve():
    with tempfile.TemporaryDirectory() as pasta:
        arm = SimpleNamespace(
            supabase=None,
            _bucket=None,
            pasta_local=pasta,
        )

        caminho = "teste/arquivo"
        salvar_imutavel(arm, caminho, b"primeiro", "application/pdf")

        try:
            salvar_imutavel(
                arm, caminho, b"segundo", "application/pdf"
            )
            raise AssertionError("Sobrescrita permitida")
        except FileExistsError:
            pass

        assert (Path(pasta) / caminho).read_bytes() == b"primeiro"


def test_supabase_sem_upsert():
    chamadas = []

    class Sessao:
        def post(self, url, **kwargs):
            chamadas.append((url, kwargs))
            return SimpleNamespace(status_code=200)

    sb = SimpleNamespace(
        s=Sessao(),
        base="https://exemplo.invalid/storage/v1",
        bucket="documentos",
        h={"Authorization": "Bearer TESTE"},
    )
    arm = SimpleNamespace(supabase=sb)

    salvar_imutavel(
        arm, "teste/arquivo", b"conteudo", "application/pdf"
    )

    assert chamadas[0][1]["headers"]["x-upsert"] == "false"
