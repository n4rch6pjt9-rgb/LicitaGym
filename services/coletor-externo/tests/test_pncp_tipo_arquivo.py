"""Tipo real do anexo PNCP: magic numbers vencem octet-stream e a extensão do nome."""
import io
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from coletor import pncp as P
from coletor.destino import Armazenamento

URL = "https://pncp.gov.br/pncp-api/v1/orgaos/11111111000111/compras/2026/1/arquivos/1"
MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _zip(*nomes: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for nome in nomes:
            zf.writestr(nome, b"conteudo")
    dados = buf.getvalue()
    assert dados.startswith(b"PK\x03\x04")
    return dados


def test_magic_pdf_sem_extensao_no_nome():
    ext, mime = P.tipo_arquivo(b"%PDF-1.7\n%", "21 - Edital", "application/octet-stream")
    assert (ext, mime) == ("pdf", "application/pdf")


def test_magic_zip():
    ext, mime = P.tipo_arquivo(_zip("leia.txt"), "ETP_E_TR", "application/octet-stream")
    assert (ext, mime) == ("zip", "application/zip")


def test_magic_docx():
    ext, mime = P.tipo_arquivo(
        _zip("word/document.xml", "[Content_Types].xml"),
        "1+-+DFD+MATERIAL+ESPORTIVO+OK",
        "application/octet-stream",
    )
    assert (ext, mime) == ("docx", MIME_DOCX)


def test_magic_xlsx():
    ext, mime = P.tipo_arquivo(_zip("xl/workbook.xml"), "planilha", "application/octet-stream")
    assert (ext, mime) == ("xlsx", MIME_XLSX)


def test_docx_vence_xl_no_mesmo_zip():
    ext, mime = P.tipo_arquivo(_zip("word/document.xml", "xl/workbook.xml"), "misto", None)
    assert (ext, mime) == ("docx", MIME_DOCX)


def test_magic_rar():
    ext, mime = P.tipo_arquivo(b"Rar!\x1a\x07\x00resto", "arquivo", "application/octet-stream")
    assert (ext, mime) == ("rar", "application/vnd.rar")


def test_magic_7z():
    ext, mime = P.tipo_arquivo(b"7z\xbc\xaf\x27\x1cresto", "arquivo", "application/octet-stream")
    assert (ext, mime) == ("7z", "application/x-7z-compressed")


def test_magic_doc_ole():
    ext, mime = P.tipo_arquivo(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1resto", "arquivo", "application/octet-stream")
    assert (ext, mime) == ("doc", "application/msword")


def test_pk_truncado_continua_zip():
    ext, mime = P.tipo_arquivo(b"PK\x03\x04truncado", "21 - Edital", "application/octet-stream")
    assert (ext, mime) == ("zip", "application/zip")


def test_fallback_extensao_do_nome_quando_nao_ha_assinatura():
    ext, mime = P.tipo_arquivo(b"sem assinatura", "relatorio.xlsx", "application/octet-stream")
    assert (ext, mime) == ("xlsx", MIME_XLSX)


def test_fallback_content_type_quando_nome_nao_tem_extensao():
    ext, mime = P.tipo_arquivo(b"sem assinatura", "21 - Edital", "Application/PDF; charset=binary")
    assert (ext, mime) == ("pdf", "application/pdf")


def test_fallback_bin_sem_extensao_e_octet_stream():
    for nome in ("21 - Edital", "ETP_E_TR", "1+-+DFD+MATERIAL+ESPORTIVO+OK", None, ""):
        ext, mime = P.tipo_arquivo(b"sem assinatura", nome, "application/octet-stream")
        assert (ext, mime) == ("bin", "application/octet-stream"), nome
    ext, mime = P.tipo_arquivo(b"sem assinatura", "ETP_E_TR", None)
    assert (ext, mime) == ("bin", "application/octet-stream")


def test_nome_pdf_com_bytes_zip_vence_os_bytes():
    ext, mime = P.tipo_arquivo(_zip("anexo.txt"), ".pdf", "application/pdf")
    assert (ext, mime) == ("zip", "application/zip")
    ext, mime = P.tipo_arquivo(_zip("anexo.txt"), "edital.pdf", "application/octet-stream")
    assert (ext, mime) == ("zip", "application/zip")


def _pendente(nome, conteudo, ctype="application/octet-stream"):
    sb = MagicMock()
    lics = [{
        "id": 1, "codigo_externo": "11111111000111-1-000001/2026", "orgao_cnpj": "11111111000111",
        "categoria_escopo": "borracha", "raw": {},
    }]
    docs = [{
        "id": 7, "licitacao_id": 1, "secao": "processo", "arquivo_origem": "pncp-7",
        "nome_original": nome, "raw": {"url": URL}, "sha256": None, "status_processamento": "pendente",
    }]
    sb.selecionar.side_effect = lambda t, **kw: lics if t == "licitacoes_externas" else docs
    pncp = MagicMock()
    pncp.baixar.return_value = (conteudo, ctype)
    return sb, pncp


def test_baixar_pendentes_grava_extensao_mime_e_baixado_em(tmp_path):
    antes = datetime.now(timezone.utc)
    sb, pncp = _pendente(".pdf", _zip("anexo.txt"), "application/octet-stream")
    arm = Armazenamento(pasta_local=tmp_path)
    res = P.baixar_pendentes(pncp, sb, arm)
    assert res["baixados"] == 1
    payload = sb.atualizar.call_args[0][2]
    assert payload["mime_type"] == "application/zip"
    assert payload["status_processamento"] == "baixado"
    assert payload["erro"] is None
    baixado = datetime.fromisoformat(payload["baixado_em"])
    assert baixado.tzinfo is not None and baixado.utcoffset() == timedelta(0)
    assert antes - timedelta(seconds=2) <= baixado <= datetime.now(timezone.utc) + timedelta(seconds=2)
    relativo = "pncp/0/11111111000111-2026-1/processo/pncp-7.zip"
    assert payload["storage_uri"].endswith(relativo)
    assert (tmp_path / relativo).read_bytes().startswith(b"PK\x03\x04")


def test_baixar_pendentes_pdf_sem_extensao_nao_vira_bin(tmp_path):
    sb, pncp = _pendente("21 - Edital", b"%PDF-1.4 edital", "application/octet-stream")
    arm = Armazenamento(pasta_local=tmp_path)
    P.baixar_pendentes(pncp, sb, arm)
    payload = sb.atualizar.call_args[0][2]
    assert payload["mime_type"] == "application/pdf"
    assert payload["storage_uri"].endswith("pncp/0/11111111000111-2026-1/processo/pncp-7.pdf")
    assert "baixado_em" in payload
