"""Detecção do tipo pelos bytes em coletor/textos.py (o PNCP entrega anexos como .bin ou sem extensão)."""
import io
import zipfile

import pytest

from coletor.textos import _nome_zip, extrair, tipo_por_bytes

TEXTO = ("EDITAL DE PREGÃO ELETRÔNICO\nObjeto: aquisição de materiais esportivos para a secretaria municipal.\n") * 5
NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _pdf(texto=TEXTO):
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    y = 800
    for linha in texto.split("\n"):
        c.drawString(40, y, linha); y -= 14
    c.showPage(); c.save()
    return buf.getvalue()


def _zip(membros: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in membros.items():
            z.writestr(n, b)
    return buf.getvalue()


def _docx(texto="Declaração de habilitação da licitante") -> bytes:
    return _zip({"[Content_Types].xml": b"<Types/>",
                 "word/document.xml": (f'<w:document xmlns:w="{NS_W}"><w:body><w:p><w:r><w:t>{texto}</w:t>'
                                       f'</w:r></w:p></w:body></w:document>').encode()})


def _xlsx() -> bytes:
    shared = (f'<sst xmlns="{NS_X}"><si><t>Item</t></si><si><t>Descrição</t></si><si><t>Valor Total</t></si>'
              f'<si><r><t>Bola de </t></r><r><t>Handebol H1</t></r></si></sst>')
    sheet = (f'<worksheet xmlns="{NS_X}"><sheetData>'
             '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
             '<row r="2"><c r="A2"><v>4</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>6626.5300000000007</v></c></row>'
             '<row r="3"><c r="A3" t="inlineStr"><is><t>Total geral</t></is></c><c r="B3"/></row>'
             '</sheetData></worksheet>')
    wb = (f'<workbook xmlns="{NS_X}" xmlns:r="{NS_R}"><sheets>'
          '<sheet name="Proposta" sheetId="1" r:id="rId1"/></sheets></workbook>')
    rels = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
    return _zip({"[Content_Types].xml": b"<Types/>", "xl/workbook.xml": wb.encode(),
                 "xl/_rels/workbook.xml.rels": rels.encode(), "xl/sharedStrings.xml": shared.encode(),
                 "xl/worksheets/sheet1.xml": sheet.encode()})


@pytest.mark.parametrize("conteudo,esperado", [
    (b"%PDF-1.5\n...", "pdf"),
    (b"lixo antes\n%PDF-1.4\n...", "pdf"),
    (b"Rar!\x1a\x07\x00", "rar"),
    (b"7z\xbc\xaf\x27\x1c\x00\x04", "7z"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 8, "ole"),
    (b"<html><body>Erro 404</body></html>", None),
    (b"PK\x03\x04 corrompido", None),
])
def test_tipo_por_bytes_assinaturas(conteudo, esperado):
    assert tipo_por_bytes(conteudo) == esperado


def test_tipo_por_bytes_containers_zip():
    assert tipo_por_bytes(_zip({"a.pdf": _pdf()})) == "zip"
    assert tipo_por_bytes(_docx()) == "docx"
    assert tipo_por_bytes(_xlsx()) == "xlsx"
    assert tipo_por_bytes(_zip({"ppt/presentation.xml": b"<p/>"})) == "pptx"


def test_zip_com_pdf_armazenado_nao_vira_pdf():
    # ZIP_STORED deixa "%PDF-" nos primeiros 1024 bytes; a assinatura PK tem que ganhar.
    assert tipo_por_bytes(_zip({"edital.pdf": _pdf()})) == "zip"


@pytest.mark.parametrize("nome", ["edital.pdf", "pncp-1.bin", "21 - Edital", "Edital 14.2026"])
def test_pdf_por_bytes_qualquer_nome(nome):
    r = extrair(_pdf(), nome)
    assert r.paginas and "materiais esportivos" in r.paginas[0].texto and not r.ignorados


@pytest.mark.parametrize("nome", ["anexos.zip", "pncp-2", "pncp-2.bin", "Edital 14.2026"])
def test_zip_por_bytes_qualquer_nome(nome):
    r = extrair(_zip({"edital.pdf": _pdf(), "modelo.docx": _docx()}), nome)
    origens = {p.origem for p in r.paginas}
    assert origens == {f"{nome}/edital.pdf", f"{nome}/modelo.docx"} and not r.ignorados


@pytest.mark.parametrize("nome", ["modelo.docx", "pncp-1", "pncp-1.bin", "Modelo.2026"])
def test_docx_por_bytes_nao_vira_xml_cru(nome):
    r = extrair(_docx(), nome)
    assert len(r.paginas) == 1 and r.paginas[0].origem == nome
    assert r.paginas[0].texto == "Declaração de habilitação da licitante"
    assert "<w:" not in r.paginas[0].texto and "Content_Types" not in r.paginas[0].texto


def test_html_com_nome_pdf_nao_vai_para_ocr():
    r = extrair(b"<!DOCTYPE html><html><body>Erro 404 - arquivo nao encontrado</body></html>", "pncp-1.pdf")
    assert not r.pdfs_escaneados and not r.paginas and r.ignorados == ["pncp-1.pdf"]


def test_html_com_extensao_html_continua_texto():
    r = extrair(b"<html><body><p>Aviso de licitacao</p></body></html>", "aviso.html")
    assert r.paginas and "Aviso de licitacao" in r.paginas[0].texto and "<p>" not in r.paginas[0].texto


def test_xlsx_vira_texto_simples():
    r = extrair(_xlsx(), "pncp-3.bin")
    assert not r.ignorados and len(r.paginas) == 1
    p = r.paginas[0]
    assert p.origem == "pncp-3.bin#Proposta" and p.numero is None
    # número sai com o texto do XML (review do #137: sem float, que alterava preços e identificadores)
    assert p.texto.split("\n") == ["Item | Descrição | Valor Total", "4 | Bola de Handebol H1 | 6626.5300000000007",
                                    "Total geral"]


def test_xlsx_dentro_do_zip_e_rar_ignorado():
    r = extrair(_zip({"Anexo II.xlsx": _xlsx(), "certidoes.rar": b"Rar!\x1a\x07\x00"}), "Edital.zip")
    assert [p.origem for p in r.paginas] == ["Edital.zip/Anexo II.xlsx#Proposta"]
    assert r.ignorados == ["Edital.zip/certidoes.rar"]


@pytest.mark.parametrize("membros", [
    {"xl/workbook.xml": b"<nao-e-xml", "xl/_rels/workbook.xml.rels": b"<Relationships/>"},   # XML inválido
    {"xl/workbook.xml": b"<nao-e-xml"},                                                        # workbook quebrado, sem abas
])
def test_xlsx_quebrado_vira_erro(membros):
    # review do #137: XLSX inválido não pode virar 'ignorado' (sairia de --reprocessar-erros)
    with pytest.raises(ValueError, match=r"XLSX inválido \(planilha.xlsx\)"):
        extrair(_zip(membros), "planilha.xlsx")


def test_xlsx_vazio_fica_ignorado():
    membros = {"xl/worksheets/sheet1.xml": f'<worksheet xmlns="{NS_X}"><sheetData/></worksheet>'.encode()}
    r = extrair(_zip(membros), "planilha.xlsx")
    assert r.ignorados == ["planilha.xlsx"] and not r.paginas


def _zip_nome_bruto(placeholder: bytes, bruto: bytes, conteudo: bytes) -> bytes:
    """ZIP com nome de entrada em bytes não-UTF-8 e sem o bit 11 (o zipfile do Python não gera isso)."""
    assert len(placeholder) == len(bruto)
    z = _zip({placeholder.decode("ascii"): conteudo})
    assert z.count(placeholder) == 2   # cabeçalho local + diretório central
    return z.replace(placeholder, bruto)


def test_nome_cp850_sem_flag_utf8_corrigido():
    z = _zip_nome_bruto(b"Edital PregXo.pdf", "Edital Pregão.pdf".encode("cp850"), _pdf())
    info = zipfile.ZipFile(io.BytesIO(z)).infolist()[0]
    assert info.filename == "Edital Preg╞o.pdf"          # o que o zipfile entrega (cp437)
    assert _nome_zip(info) == "Edital Pregão.pdf"
    r = extrair(z, "Edital e Anexos.zip")
    assert {p.origem for p in r.paginas} == {"Edital e Anexos.zip/Edital Pregão.pdf"}


def test_nome_utf8_sem_flag_corrigido_e_com_flag_mantido():
    z = _zip_nome_bruto(b"PregXXo.pdf", "Pregão.pdf".encode("utf-8"), _pdf())
    assert _nome_zip(zipfile.ZipFile(io.BytesIO(z)).infolist()[0]) == "Pregão.pdf"
    com_flag = zipfile.ZipFile(io.BytesIO(_zip({"Termo de Referência.pdf": _pdf()}))).infolist()[0]
    assert com_flag.flag_bits & 0x800 and _nome_zip(com_flag) == "Termo de Referência.pdf"
    ascii_ = zipfile.ZipFile(io.BytesIO(_zip({"edital.pdf": _pdf()}))).infolist()[0]
    assert _nome_zip(ascii_) == "edital.pdf"
