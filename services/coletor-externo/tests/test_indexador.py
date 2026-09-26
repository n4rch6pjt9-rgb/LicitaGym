"""Testes offline do indexador (Gemini e Supabase simulados)."""
import io
import zipfile
from unittest.mock import MagicMock

from coletor import indexador as IX
from coletor.textos import Pagina, dividir, extrair


def _pdf(textos):
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for t in textos:
        y = 800
        for linha in t.split("\n"):
            c.drawString(40, y, linha); y -= 14
        c.showPage()
    c.save()
    return buf.getvalue()


RECURSO = ("RECURSO ADMINISTRATIVO\nA empresa Freedom Motors Ltda interpõe recurso contra a\n"
           "habilitação da licitante vencedora do lote 14, com base no art. 165 da Lei 14.133.\n") * 6


def test_pdf_com_texto_vira_paginas():
    r = extrair(_pdf([RECURSO, RECURSO]), "recurso.pdf")
    assert len(r.paginas) == 2 and not r.pdfs_escaneados and "Freedom" in r.paginas[0].texto


def test_pdf_sem_texto_vai_para_ocr():
    r = extrair(_pdf(["", ""]), "escaneado.pdf")
    assert r.pdfs_escaneados and not r.paginas


def test_zip_com_pdf_docx_e_rar():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("a/recurso.pdf", _pdf([RECURSO]))
        docx = io.BytesIO()
        with zipfile.ZipFile(docx, "w") as d:
            d.writestr("word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body><w:p><w:r><w:t>Declaração de habilitação</w:t></w:r></w:p></w:body></w:document>')
        z.writestr("b/decl.docx", docx.getvalue())
        z.writestr("c/certidoes.rar", b"Rar!")
    r = extrair(buf.getvalue(), "PROPOSTA.zip")
    origens = {p.origem for p in r.paginas}
    assert "PROPOSTA.zip/a/recurso.pdf" in origens and "PROPOSTA.zip/b/decl.docx" in origens
    assert r.ignorados == ["PROPOSTA.zip/c/certidoes.rar"]


def test_dividir_com_cabecalho_e_sobreposicao():
    tr = dividir([Pagina("x.pdf", 3, "Parágrafo longo. " * 400)], "CAB", tamanho=1000, sobreposicao=100)
    assert len(tr) > 5 and all(t["texto"].startswith("CAB\n\n") and t["pagina"] == 3 for t in tr)
    assert all(len(t["texto"]) <= 1000 + 10 for t in tr)


def test_ocr_paginado():
    ps = IX.paginas_do_ocr("[[PÁGINA 1]] um [[PÁGINA 2]] dois", "s.pdf")
    assert [(p.numero, p.texto.strip()) for p in ps] == [(1, "um"), (2, "dois")]


def test_indexa_uma_vez_por_hash_e_marca_copias(tmp_path):
    arq = tmp_path / "r.pdf"; arq.write_bytes(_pdf([RECURSO]))
    docs = [
        {"id": 5, "licitacao_id": 1, "secao": "processo", "nome_original": "[FREEDOM] RECURSO.pdf",
         "arquivo_origem": "a.pdf", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)},
        {"id": 23, "licitacao_id": 1, "secao": "recurso", "nome_original": "RECURSO.pdf",
         "arquivo_origem": "b.pdf", "fornecedor_nome": "Freedom Motors Ltda", "sha256": "h", "storage_uri": str(arq)},
    ]
    ia = MagicMock()
    ia.extrair_campos.return_value = {"tipo_documento": "recurso", "resumo": "Recurso da Freedom."}
    ia.embed.side_effect = lambda ts, **k: [[0.1] * 768 for _ in ts]
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, docs, {"numero_processo": "0400-8/2025", "numero_edital": "PE 112/2025"}, True)
    assert r["status"] == "indexado" and r["doc"] == 23          # seção 'recurso' é a canônica
    linhas = sb.upsert.call_args.args[1]
    assert linhas[0]["metadados"]["chunk_kind"] == "resumo"
    assert all(l["documento_id"] == 23 for l in linhas)
    assert "RECURSO — Freedom Motors Ltda" in linhas[1]["texto"]
    assert ia.extrair_campos.call_count == 1
    status = {c.args[1]: c.args[2]["status_processamento"] for c in sb.atualizar.call_args_list}
    assert status == {23: "indexado", 5: "indexado"}
    copia = [c.args[2] for c in sb.atualizar.call_args_list if c.args[1] == 5][0]
    assert copia["extracao"]["copia_de_documento_id"] == 23


def test_arquivo_sem_texto_fica_ignorado(tmp_path):
    arq = tmp_path / "x.rar"; arq.write_bytes(b"Rar!\x1a\x07")
    docs = [{"id": 1, "licitacao_id": 1, "secao": "processo", "nome_original": "x.rar",
             "arquivo_origem": "x.rar", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)}]
    r = IX.indexar_grupo(MagicMock(), MagicMock(), docs, {"numero_processo": "1", "numero_edital": None}, True)
    assert r["status"] == "ignorado"


def test_mascara_cpf_mas_mantem_cnpj():
    from coletor.textos import limpar_texto
    t = limpar_texto("Sócio João, CPF 123.456.789-01; CPF: 12345678901. Empresa CNPJ 07.486.108/0001-85")
    assert "123.456.789-01" not in t and "12345678901" not in t
    assert "07.486.108/0001-85" in t
