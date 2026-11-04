"""Armazenamento imutável — LicitaGym P0.3."""

import hashlib
import mimetypes
import os
import tempfile
from pathlib import Path


def hash_conteudo(conteudo: bytes) -> str:
    return hashlib.sha256(conteudo).hexdigest()


def caminho_versao(
    caminho_base: str,
    secao: str,
    documento_id: int,
    conteudo: bytes,
) -> str:
    digest = hash_conteudo(conteudo)
    return f"{caminho_base}/{secao}/versoes/{documento_id}/{digest}"


def salvar_imutavel(
    arm,
    caminho: str,
    conteudo: bytes,
    content_type: str | None,
) -> str:
    ctype = (
        content_type
        or mimetypes.guess_type(caminho)[0]
        or "application/octet-stream"
    )

    if arm.supabase is not None:
        sb = arm.supabase
        resposta = sb.s.post(
            f"{sb.base}/object/{sb.bucket}/{caminho}",
            data=conteudo,
            headers={
                **sb.h,
                "Content-Type": ctype,
                "x-upsert": "false",
            },
            timeout=(30, 300),
        )
        if resposta.status_code >= 300:
            # Conflito de objeto existente: recuperar somente após
            # verificar os bytes na camada de versionamento.
            if resposta.status_code == 409:
                try:
                    erro = resposta.json()
                except (ValueError, TypeError):
                    erro = {}

                codigo_erro = str(
                    erro.get("code", "")
                ) if isinstance(erro, dict) else ""

                if codigo_erro in ("409", "ResourceAlreadyExists"):
                    raise FileExistsError(
                        "Objeto já existe no Supabase Storage"
                    )

            raise RuntimeError(
                f"Storage imutável: HTTP {resposta.status_code}"
            )
        return f"supabase://{sb.bucket}/{caminho}"

    if arm._bucket is not None:
        blob = arm._bucket.blob(caminho)
        from google.api_core.exceptions import PreconditionFailed

        try:
            blob.upload_from_string(
                conteudo,
                content_type=ctype,
                if_generation_match=0,
            )
        except PreconditionFailed as exc:
            raise FileExistsError(
                "Objeto já existe no Google Cloud Storage"
            ) from exc
        return f"gs://{arm.bucket_nome}/{caminho}"

    destino = Path(arm.pasta_local) / caminho
    destino.parent.mkdir(parents=True, exist_ok=True)

    temporario = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destino.parent,
            prefix=".versao-",
            delete=False,
        ) as arquivo:
            temporario = Path(arquivo.name)
            arquivo.write(conteudo)
            arquivo.flush()
            os.fsync(arquivo.fileno())

        # Link exclusivo: não substitui um destino existente.
        os.link(temporario, destino)

        # Persistência do diretório, quando suportada.
        if os.name == "posix":
            fd = os.open(destino.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

        return str(destino.resolve())

    finally:
        if temporario is not None:
            temporario.unlink(missing_ok=True)
