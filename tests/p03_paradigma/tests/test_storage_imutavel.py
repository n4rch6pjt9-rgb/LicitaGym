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


def test_supabase_key_already_exists_http_400():
    class Sessao:
        def post(self, url, **kwargs):
            assert kwargs["headers"]["x-upsert"] == "false"
            return SimpleNamespace(
                status_code=400,
                json=lambda: {
                    "code": "KeyAlreadyExists",
                    "message": "The resource already exists",
                },
            )

    sb = SimpleNamespace(
        s=Sessao(),
        base="https://exemplo.invalid/storage/v1",
        bucket="documentos",
        h={"apikey": "TESTE"},
    )

    arm = SimpleNamespace(supabase=sb)

    try:
        salvar_imutavel(
            arm, "teste/arquivo", b"segundo", "application/pdf"
        )
    except FileExistsError:
        pass
    else:
        raise AssertionError(
            "KeyAlreadyExists não foi reconhecido"
        )


def test_supabase_http_400_nao_conflito_continua_erro():
    class Sessao:
        def post(self, url, **kwargs):
            return SimpleNamespace(
                status_code=400,
                json=lambda: {
                    "code": "InvalidRequest",
                    "message": "Invalid request",
                },
            )

    sb = SimpleNamespace(
        s=Sessao(),
        base="https://exemplo.invalid/storage/v1",
        bucket="documentos",
        h={"apikey": "TESTE"},
    )

    arm = SimpleNamespace(supabase=sb)

    try:
        salvar_imutavel(
            arm, "teste/arquivo", b"conteudo", "application/pdf"
        )
    except RuntimeError as exc:
        assert "HTTP 400" in str(exc)
    else:
        raise AssertionError(
            "HTTP 400 não relacionado a conflito foi aceito"
        )
