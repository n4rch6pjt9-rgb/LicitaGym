"""Regressões dos achados do review do PR #137 no parser XLSX (coletor/textos.py, 03/10/2026).
Offline: os XLSX são montados em memória com zipfile, dados fictícios.

1. zip bomb: teto de bytes descompactados (o mesmo do _zip) e limites de linhas/células
2. números: o texto do XML sai intacto (sem float)
3. colunas esparsas: a célula vai para a coluna da referência "r"
4. XLSX inválido vira erro (status 'erro' com motivo no indexador), nunca 'ignorado'

Decisões aprovadas (03/10/2026, revisáveis pelo Marcelo no review):
(a) XLSX inválido DENTRO de um ZIP: pula só ele, registra o motivo em arquivos_ignorados e indexa o
    resto do ZIP; o ZIP não vira 'erro'. XLSX avulso inválido continua 'erro'.
(b) ruído de float do Excel (6626.5300000000007) fica exatamente como gravado, sem arredondar.
"""
import io
import zipfile
from unittest.mock import MagicMock

import pytest

from coletor import indexador as IX
from coletor import textos as T
from coletor.textos import extrair

NS_X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _zip(membros: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in membros.items():
            z.writestr(n, b)
    return buf.getvalue()


def _xlsx(linhas_xml: str, compartilhadas: list[str] | None = None, extra: dict[str, bytes] | None = None) -> bytes:
    """XLSX mínimo com uma aba "Planilha" cujo <sheetData> recebe linhas_xml."""
    membros = {
        "[Content_Types].xml": b"<Types/>",
        "xl/workbook.xml": (f'<workbook xmlns="{NS_X}" xmlns:r="{NS_R}"><sheets>'
                            '<sheet name="Planilha" sheetId="1" r:id="rId1"/></sheets></workbook>').encode(),
        "xl/_rels/workbook.xml.rels": ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                       '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>').encode(),
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{NS_X}"><sheetData>{linhas_xml}</sheetData></worksheet>'.encode(),
    }
    if compartilhadas is not None:
        membros["xl/sharedStrings.xml"] = (f'<sst xmlns="{NS_X}">'
                                           + "".join(f"<si><t>{s}</t></si>" for s in compartilhadas)
                                           + "</sst>").encode()
    membros.update(extra or {})
    return _zip(membros)


def _linhas(conteudo: bytes, nome: str = "planilha.xlsx") -> list[str]:
    r = extrair(conteudo, nome)
    assert not r.ignorados and len(r.paginas) == 1
    return r.paginas[0].texto.split("\n")


# ---------- 1. zip bomb ----------
def test_xlsx_acima_do_teto_descompactado_vira_erro_sem_ler():
    # ~61 MiB de XML que comprime para poucos KB: tem que barrar pelo file_size, antes de ler/parsear.
    teto = 60 * 1024 * 1024   # o mesmo teto do _zip
    enchimento = b"<row/>" * ((teto // 6) + 200_000)
    bomba = _xlsx("", extra={"xl/worksheets/sheet1.xml":
                             f'<worksheet xmlns="{NS_X}"><sheetData>'.encode() + enchimento + b"</sheetData></worksheet>"})
    assert len(bomba) < 1024 * 1024
    lidos = []
    original = zipfile.ZipFile.open
    def _open(self, nome, *a, **k):
        lidos.append(getattr(nome, "filename", nome))
        return original(self, nome, *a, **k)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(zipfile.ZipFile, "open", _open)
        with pytest.raises(ValueError, match=r"XLSX inválido \(bomba.xlsx\).*teto"):
            extrair(bomba, "bomba.xlsx")
    assert lidos == []   # nenhuma parte foi descompactada
    assert T.ZIP_MAX_DESCOMPACTADO == teto   # constante única, reusada pelo _zip


def test_xlsx_soma_das_partes_conta_para_o_teto(monkeypatch):
    # Cada parte isolada cabe, a soma não: o teto é cumulativo.
    monkeypatch.setattr(T, "ZIP_MAX_DESCOMPACTADO", 3000, raising=False)
    grande = "x" * 1500
    xlsx = _xlsx(f'<row r="1"><c r="A1" t="s"><v>0</v></c></row>', compartilhadas=[grande, grande])
    with pytest.raises(ValueError, match="teto"):
        extrair(xlsx, "soma.xlsx")


def test_xlsx_com_linhas_demais_vira_erro(monkeypatch):
    monkeypatch.setattr(T, "XLSX_MAX_LINHAS", 50, raising=False)
    xlsx = _xlsx("".join(f'<row r="{i}"/>' for i in range(1, 61)) + '<row r="61"><c r="A61"><v>1</v></c></row>')
    with pytest.raises(ValueError, match="linhas"):
        extrair(xlsx, "linhas.xlsx")


def test_xlsx_com_celulas_demais_vira_erro(monkeypatch):
    # Lacunas preenchidas pela referência contam: uma célula em CV1 equivale a 100 células.
    monkeypatch.setattr(T, "XLSX_MAX_CELULAS", 250, raising=False)
    xlsx = _xlsx("".join(f'<row r="{i}"><c r="CV{i}"><v>{i}</v></c></row>' for i in range(1, 4)))
    with pytest.raises(ValueError, match="células"):
        extrair(xlsx, "celulas.xlsx")


def test_xlsx_referencia_alem_da_ultima_coluna_do_excel_vira_erro():
    xlsx = _xlsx('<row r="1"><c r="A1"><v>1</v></c><c r="XFE1"><v>2</v></c></row>')
    with pytest.raises(ValueError, match="XFE1"):
        extrair(xlsx, "colunas.xlsx")


# ---------- 2. números preservados ----------
def test_numeros_saem_com_o_texto_original_do_xml():
    xlsx = _xlsx('<row r="1">'
                 '<c r="A1"><v>12345678901234567890</v></c>'
                 '<c r="B1"><v>0,10</v></c>'
                 '<c r="C1" t="n"><v>123456789012345.67</v></c>'
                 '<c r="D1"><v>6626.5300000000007</v></c>'
                 '<c r="E1"><v>1234567890123456</v></c>'
                 '</row>')
    assert _linhas(xlsx) == ["12345678901234567890 | 0,10 | 123456789012345.67 | 6626.5300000000007 | 1234567890123456"]


# ---------- 3. colunas esparsas ----------
def test_celula_vazia_nao_desloca_as_demais():
    xlsx = _xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
                 '<row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>5</v></c></row>'                    # lacuna no meio
                 '<row r="3"><c r="C3"><v>7</v></c></row>'                                           # lacuna no início
                 '<row r="4"><c r="B4" t="inlineStr"><is><t>Bola de vôlei</t></is></c>'
                 '<c r="C4" t="s"><v>3</v></c></row>'                                                # inline + shared
                 '<row r="5"><c r="A5"><v>2</v></c><c r="B5"/><c r="C5"><v>9</v></c><c r="D5"/></row>',  # vazias explícitas
                 compartilhadas=["Item", "Descrição", "Quantidade", "12"])
    assert _linhas(xlsx) == ["Item | Descrição | Quantidade", "1 |  | 5", " |  | 7", " | Bola de vôlei | 12", "2 |  | 9"]


def test_celula_sem_referencia_segue_a_anterior():
    xlsx = _xlsx('<row><c><v>1</v></c><c><v>2</v></c><c r="E1"><v>5</v></c></row>')
    assert _linhas(xlsx) == ["1 | 2 |  |  | 5"]


# ---------- 4. XLSX inválido vira erro ----------
@pytest.mark.parametrize("extra,motivo", [
    ({"xl/worksheets/sheet1.xml": b"<worksheet><sheetData><row>"}, "ParseError"),        # aba truncada
    ({"xl/sharedStrings.xml": b"<sst><si><t>abc"}, "ParseError"),                          # shared strings quebradas
    ({"xl/workbook.xml": b"<nao-e-xml"}, "ParseError"),                                    # workbook quebrado
    ({"xl/_rels/workbook.xml.rels": ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                                     '<Relationship Id="rId1" Target="worksheets/sumiu.xml"/></Relationships>').encode()},
     "não existe"),                                                                         # aba apontando para o nada
])
def test_xlsx_invalido_vira_erro_com_motivo(extra, motivo):
    xlsx = _xlsx('<row r="1"><c r="A1"><v>1</v></c></row>', extra=extra)
    with pytest.raises(ValueError, match=rf"XLSX inválido \(planilha.xlsx\).*{motivo}"):
        extrair(xlsx, "planilha.xlsx")


def test_xlsx_sem_nenhuma_aba_vira_erro():
    with pytest.raises(ValueError, match="nenhuma aba"):
        extrair(_zip({"xl/styles.xml": b"<styleSheet/>"}), "planilha.xlsx")


def test_xlsx_com_crc_corrompido_vira_erro():
    bom = _zip({"xl/worksheets/sheet1.xml": f'<worksheet xmlns="{NS_X}"><sheetData><row r="1"><c r="A1"><v>1</v></c>'
                                             f'</row></sheetData></worksheet>'.encode() * 1})
    z = zipfile.ZipFile(io.BytesIO(bom))
    info = z.infolist()[0]
    ini = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    ruim = bytearray(bom)
    ruim[ini + 5] ^= 0xFF   # estraga um byte dos dados comprimidos
    with pytest.raises(ValueError, match=r"XLSX inválido"):
        extrair(bytes(ruim), "planilha.xlsx")


def test_planilha_valida_e_vazia_continua_ignorada():
    r = extrair(_xlsx('<row r="1"><c r="A1"/></row>'), "vazia.xlsx")
    assert r.ignorados == ["vazia.xlsx"] and not r.paginas


def test_indexador_grava_erro_com_motivo_para_xlsx_quebrado(tmp_path, monkeypatch):
    # Mesmo caminho de erro do PDF: a exceção sobe de indexar_grupo e o main grava status 'erro' com o motivo.
    arq = tmp_path / "pncp-9.bin"
    arq.write_bytes(_xlsx("", extra={"xl/worksheets/sheet1.xml": b"<worksheet><sheetData><row>"}))
    docs = [{"id": 7, "licitacao_id": 1, "secao": "processo", "nome_original": "Planilha de preços",
             "arquivo_origem": "pncp-9.bin", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)}]
    sb = MagicMock()
    sb.selecionar.side_effect = lambda tabela, **k: (
        docs if tabela == "licitacao_documentos" else [{"id": 1, "numero_processo": "1/2026", "numero_edital": None,
                                                         "fonte": "pncp", "entidade": None, "orgao_nome": "Prefeitura"}])
    monkeypatch.setattr(IX, "Supabase", lambda *a, **k: sb)
    monkeypatch.setattr(IX, "env", lambda *a, **k: "x")
    monkeypatch.setattr("coletor.ia.Gemini", MagicMock)
    assert IX.main(["--sem-extracao"]) == 0
    atualizacoes = [c.args for c in sb.atualizar.call_args_list]
    assert len(atualizacoes) == 1
    tabela, id_, campos = atualizacoes[0]
    assert (tabela, id_, campos["status_processamento"]) == ("licitacao_documentos", 7, "erro")
    assert campos["erro"].startswith("XLSX inválido (Planilha de preços): ParseError")


# ---------- decisão (a): XLSX inválido dentro de ZIP ----------
_XLSX_QUEBRADO = _xlsx("", extra={"xl/worksheets/sheet1.xml": b"<worksheet><sheetData><row>"})
_XLSX_BOM = _xlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>Bola de futsal</t></is></c><c r="B1"><v>89.9</v></c></row>')
_TXT = ("AVISO DE LICITAÇÃO. Pregão eletrônico para aquisição de material esportivo: bolas, redes e "
        "tatames para a secretaria de esportes.\n").encode() * 3


def test_zip_com_xlsx_quebrado_pula_so_ele_e_indexa_o_resto():
    zip_ = _zip({"Anexo I.xlsx": _XLSX_QUEBRADO, "Anexo II.xlsx": _XLSX_BOM, "aviso.txt": _TXT})
    r = extrair(zip_, "Edital.zip")   # não levanta: o ZIP não vira erro por causa de uma planilha
    assert sorted(p.origem for p in r.paginas) == ["Edital.zip/Anexo II.xlsx#Planilha", "Edital.zip/aviso.txt"]
    assert any("Bola de futsal | 89.9" in p.texto for p in r.paginas)
    assert len(r.ignorados) == 1
    assert r.ignorados[0].startswith("XLSX inválido (Edital.zip/Anexo I.xlsx): ParseError")


def test_zip_dentro_de_zip_com_xlsx_quebrado_tambem_pula_so_ele():
    interno = _zip({"Planilha.xlsx": _XLSX_QUEBRADO, "aviso.txt": _TXT})
    r = extrair(_zip({"anexos.zip": interno}), "Edital.zip")
    assert [p.origem for p in r.paginas] == ["Edital.zip/anexos.zip/aviso.txt"]
    assert r.ignorados and r.ignorados[0].startswith("XLSX inválido (Edital.zip/anexos.zip/Planilha.xlsx)")


def test_xlsx_avulso_quebrado_continua_erro():
    with pytest.raises(T.ErroExtracao, match=r"XLSX inválido \(Anexo I.xlsx\): ParseError"):
        extrair(_XLSX_QUEBRADO, "Anexo I.xlsx")


def test_indexador_indexa_zip_com_xlsx_quebrado_e_grava_motivo(tmp_path):
    arq = tmp_path / "pncp-10.bin"
    arq.write_bytes(_zip({"Anexo I.xlsx": _XLSX_QUEBRADO, "aviso.txt": _TXT}))
    docs = [{"id": 8, "licitacao_id": 1, "secao": "processo", "nome_original": "Edital.zip",
             "arquivo_origem": "pncp-10.bin", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)}]
    ia = MagicMock()
    ia.embed.side_effect = lambda ts, **k: [[0.1] * 768 for _ in ts]
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, docs, {"numero_processo": "1/2026", "numero_edital": None, "fonte": "pncp"}, False)
    assert r["status"] == "indexado" and r["trechos"] >= 1
    linhas = [l for c in sb.upsert.call_args_list for l in c.args[1]]
    assert any("material esportivo" in l["texto"] for l in linhas)
    tabela, id_, campos = sb.atualizar.call_args.args
    assert (tabela, id_, campos["status_processamento"], campos["erro"]) == ("licitacao_documentos", 8, "indexado", None)
    ignorados = campos["extracao"]["arquivos_ignorados"]
    assert len(ignorados) == 1 and ignorados[0].startswith("XLSX inválido (Edital.zip/Anexo I.xlsx): ParseError")


# ---------- decisão (b): ruído de float do Excel preservado ----------
@pytest.mark.parametrize("gravado", ["6626.5300000000007", "0.30000000000000004", "1.0000000000000002E-3", "89.899999999999991"])
def test_ruido_de_float_do_excel_fica_exatamente_como_gravado(gravado):
    xlsx = _xlsx(f'<row r="1"><c r="A1"><v>{gravado}</v></c><c r="B1" t="n"><v>{gravado}</v></c></row>')
    assert _linhas(xlsx) == [f"{gravado} | {gravado}"]
