"""Persistência de versões documentais — LicitaGym P0.3."""

import requests


def buscar_versao(sb, documento_id: int, sha256: str) -> dict | None:
    linhas = sb.selecionar(
        "licitacao_documento_versoes",
        select="id,documento_id,sha256,storage_uri,tamanho_bytes,mime_type",
        documento_id=f"eq.{documento_id}",
        sha256=f"eq.{sha256}",
    )

    if len(linhas) > 1:
        raise RuntimeError("Integridade violada: versões duplicadas")

    return linhas[0] if linhas else None


def _validar_versao(
    versao: dict,
    documento_id: int,
    digest: str,
    storage_uri: str,
    tamanho_bytes: int,
) -> None:
    if (
        str(versao.get("documento_id")) != str(documento_id)
        or versao.get("sha256") != digest
        or versao.get("storage_uri") != storage_uri
        or type(versao.get("tamanho_bytes")) is not int
        or versao.get("tamanho_bytes") != tamanho_bytes
    ):
        raise RuntimeError(
            "Versão concorrente divergente: registro não reutilizável"
        )


def registrar_versao_com_estado(
    sb,
    documento_id: int,
    sha256: str,
    storage_uri: str,
    tamanho_bytes: int,
    mime_type: str | None,
) -> tuple[dict, bool]:
    """Insere versão ou recupera colisão exata de unicidade."""

    payload = {
        "documento_id": documento_id,
        "sha256": sha256,
        "storage_uri": storage_uri,
        "tamanho_bytes": tamanho_bytes,
        "mime_type": mime_type,
    }

    resposta = requests.post(
        f"{sb.base}/licitacao_documento_versoes",
        json=payload,
        headers={**sb.h, "Prefer": "return=representation"},
        timeout=60,
    )

    if resposta.status_code >= 300:
        erro = {}
        try:
            erro = resposta.json()
        except (ValueError, TypeError, AttributeError):
            pass

        if (
            resposta.status_code == 409
            and isinstance(erro, dict)
            and erro.get("code") == "23505"
        ):
            existente = buscar_versao(sb, documento_id, sha256)

            if existente is None:
                raise RuntimeError(
                    "Conflito de unicidade sem versão recuperável"
                )

            _validar_versao(
                existente,
                documento_id,
                sha256,
                storage_uri,
                tamanho_bytes,
            )
            return existente, False

        raise RuntimeError(
            f"Registro de versão falhou: HTTP {resposta.status_code} "
            f"{resposta.text[:300]}"
        )

    linhas = resposta.json()
    if not isinstance(linhas, list) or len(linhas) != 1:
        raise RuntimeError("Resposta inválida ao registrar versão")

    # Mantém o contrato legado de inserção. A recuperação
    # concorrente 23505 continua exigindo metadados completos.
    return linhas[0], True


def registrar_versao(
    sb,
    documento_id: int,
    sha256: str,
    storage_uri: str,
    tamanho_bytes: int,
    mime_type: str | None,
) -> dict:
    """Interface compatível: retorna somente o registro."""
    versao, _ = registrar_versao_com_estado(
        sb, documento_id, sha256, storage_uri,
        tamanho_bytes, mime_type,
    )
    return versao
