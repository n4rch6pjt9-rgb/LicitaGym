"""Versionamento documental imutável — LicitaGym P0.3."""

from pathlib import Path

from .destino import sha256
from .persistencia_versoes import (
    buscar_versao,
    registrar_versao_com_estado,
)
from .storage_imutavel import caminho_versao, salvar_imutavel


def _verificar_objeto(arm, uri: str, digest: str) -> None:
    """Confirma integridade antes de reutilizar objeto existente."""

    if arm.supabase is not None:
        if not uri.startswith(f"supabase://{arm.supabase.bucket}/"):
            raise RuntimeError("Bucket Supabase divergente")
        conteudo = arm.supabase.ler(uri)

    elif arm._bucket is not None:
        prefixo = f"gs://{arm.bucket_nome}/"
        if not uri.startswith(prefixo):
            raise RuntimeError("Bucket GCS divergente")
        caminho = uri[len(prefixo):]
        conteudo = arm._bucket.blob(caminho).download_as_bytes()

    else:
        destino = Path(uri).resolve()
        raiz = Path(arm.pasta_local).resolve()
        if not destino.is_relative_to(raiz) or not destino.is_file():
            raise RuntimeError("Objeto local inválido")
        conteudo = destino.read_bytes()

    if sha256(conteudo) != digest:
        raise RuntimeError("Objeto existente diverge do SHA-256 esperado")



def _validar_retorno_banco(
    versao: dict,
    documento_id: int,
    digest: str,
    uri: str,
    tamanho: int,
    mime_type: str | None,
) -> None:
    """Rejeita registros incompatíveis com a operação solicitada."""

    if not isinstance(versao, dict):
        raise RuntimeError("Metadados inválidos no retorno do banco")

    if (
        str(versao.get("documento_id")) != str(documento_id)
        or versao.get("sha256") != digest
        or versao.get("storage_uri") != uri
        or type(versao.get("tamanho_bytes")) is not int
        or versao["tamanho_bytes"] != tamanho
        or (
            "mime_type" in versao
            and versao["mime_type"] != mime_type
        )
    ):
        raise RuntimeError("Metadados divergentes no retorno do banco")

def processar_versao(
    sb,
    arm,
    documento_id: int,
    caminho_base: str,
    secao: str,
    conteudo: bytes,
    mime_type: str | None,
) -> tuple[dict, bool]:
    """Retorna (versão, criada), sem alterar licitacao_documentos."""

    digest = sha256(conteudo)
    caminho = caminho_versao(
        caminho_base, secao, documento_id, conteudo
    )

    existente = buscar_versao(sb, documento_id, digest)
    if existente is not None:
        if (
            str(existente.get("documento_id")) != str(documento_id)
            or existente.get("sha256") != digest
            or type(existente.get("tamanho_bytes")) is not int
            or existente["tamanho_bytes"] != len(conteudo)
        ):
            raise RuntimeError("Metadados da versão existente divergentes")

        uri = existente.get("storage_uri")
        if not uri:
            raise RuntimeError("Versão existente sem storage_uri")

        _verificar_objeto(arm, uri, digest)
        return existente, False

    try:
        uri = salvar_imutavel(arm, caminho, conteudo, mime_type)
    except FileExistsError:
        if arm.supabase is not None:
            uri = f"supabase://{arm.supabase.bucket}/{caminho}"
        elif arm._bucket is not None:
            uri = f"gs://{arm.bucket_nome}/{caminho}"
        else:
            uri = str((Path(arm.pasta_local) / caminho).resolve())

        _verificar_objeto(arm, uri, digest)

    versao, criada = registrar_versao_com_estado(
        sb,
        documento_id,
        digest,
        uri,
        len(conteudo),
        mime_type,
    )

    _validar_retorno_banco(
        versao,
        documento_id,
        digest,
        uri,
        len(conteudo),
        mime_type,
    )
    _verificar_objeto(arm, versao["storage_uri"], digest)
    return versao, criada
