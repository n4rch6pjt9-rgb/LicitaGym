"""Testes offline da extração do processo administrativo a partir do edital."""
import io
import zipfile
from collections import Counter
from unittest.mock import MagicMock

from coletor import processo_edital as P


def test_fraco():
    assert P.fraco(None) and P.fraco("") and P.fraco("4") and P.fraco("0080")
    assert not P.fraco("74/2026")
    assert not P.fraco("04035-00002433/2025-00")
    assert not P.fraco("14702")


def test_candidatos_variacoes():
    t = """PREFEITURA MUNICIPAL
    PROCESSO ADMINISTRATIVO Nº 137/2026
    PREGÃO ELETRÔNICO Nº 65/2026
    Processo Licitatório n.º 0204000080/2025
    PROCESSO SEI: 23456.000123/2026-11
    Processo nº 12/2026"""
    c = dict(P.candidatos(t))
    assert c["137/2026"] == 5
    assert c["0204000080/2025"] == 4
    assert c["23456.000123/2026-11"] == 5
    assert c["12/2026"] == 1


def test_escolher_prefere_administrativo_e_ignora_fracos():
    cands = [("12/2026", 1), ("137/2026", 5), ("4", 5)]
    assert P.escolher(cands, "4") == "137/2026"
    assert P.escolher([("38", 5)], "38") is None


def test_escolher_compatibilidade_com_pncp():
    assert P.escolher([("005/2026", 1), ("004/2026", 1)], "4") == "004/2026"


def _pdf_com_texto(texto: str) -> bytes:
    # PDF mínimo com camada de texto (1 página)
    stream = f"BT /F1 12 Tf 50 750 Td ({texto}) Tj ET".encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offs = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for i, o in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs:
        out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref))
    return out.getvalue()


def test_processo_do_edital_zip():
    texto = "EDITAL DE PREGAO ELETRONICO No 4/2026 - PROCESSO ADMINISTRATIVO No 0137/2026 - " + "x" * 120
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("edital.pdf", _pdf_com_texto(texto))
    pncp = MagicMock()
    pncp.compra.return_value = {"objetoCompra": "material de expediente", "processo": "4"}
    pncp.arquivos.return_value = [
        {"titulo": "anexo.pdf", "tipoDocumentoNome": "Outros", "url": "u2"},
        {"titulo": "185062_editais.zip", "tipoDocumentoNome": "Edital", "url": "u1"},
    ]
    pncp.baixar.return_value = (buf.getvalue(), "application/zip")
    ach = P.processo_do_edital(pncp, {"title": "Edital nº 4/2026"}, "4", Counter(), edital="Edital nº 4/2026")
    assert ach.status == "encontrado"
    assert (ach.processo, ach.fonte, ach.arquivo, ach.peso) == ("0137/2026", "edital", "185062_editais.zip", 5)
    assert "PROCESSO ADMINISTRATIVO" in ach.trecho
    pncp.baixar.assert_called_once_with("u1", P.MAX_BYTES)   # Edital primeiro


def test_processo_nos_metadados_nao_baixa():
    pncp = MagicMock()
    pncp.compra.return_value = {"objetoCompra": "Aquisição de grama sintética"}
    ach = P.processo_do_edital(pncp, {"title": "Pregão - Eletrônico nº 65 | Processo 137/2026"}, "65", Counter())
    assert (ach.status, ach.processo, ach.fonte) == ("encontrado", "137/2026", "metadados")
    pncp.arquivos.assert_not_called()


# ---------------- v16: regra do edital, erro != vazio, gravação só em raw ----------------

def test_igual_ao_edital():
    assert P.igual_ao_edital("004/2026", "Pregão Eletrônico nº 4/2026")
    assert P.igual_ao_edital("004/2026", "PE 004/2026")
    assert P.igual_ao_edital("4/2026", "Pregão nº 4")          # rótulo sem ano: compara o 1º grupo
    assert not P.igual_ao_edital("137/2026", "Pregão Eletrônico nº 4/2026")
    assert not P.igual_ao_edital("004/2026", None)


def test_escolher_descarta_numero_do_edital_com_peso_baixo():
    r = Counter()
    cands = [P.Candidato("004/2026", 1, "PROCESSO Nº 004/2026")]
    assert P.escolher_ctx(cands, "4", "Pregão Eletrônico nº 4/2026", r) is None
    assert r["bloqueado_edital"] == 1
    # com qualificador forte ("Processo Administrativo") o mesmo número é aceito
    forte = [P.Candidato("004/2026", 5, "PROCESSO ADMINISTRATIVO Nº 004/2026")]
    assert P.escolher_ctx(forte, "4", "Pregão Eletrônico nº 4/2026").numero == "004/2026"
    # e o candidato diferente do edital continua valendo
    assert P.escolher([("004/2026", 1), ("137/2026", 1)], "4", "PE 4/2026") == "137/2026"


def test_falha_na_lista_de_arquivos_nao_vira_nao_encontrado():
    pncp = MagicMock()
    pncp.compra.return_value = {"objetoCompra": "material esportivo"}
    pncp.arquivos.side_effect = RuntimeError("503")
    r = Counter()
    ach = P.processo_do_edital(pncp, {"title": ""}, "4", r)
    assert ach.status == "falha" and r["falha_arquivos"] == 1


def test_todos_os_downloads_falhando_e_falha():
    pncp = MagicMock()
    pncp.compra.return_value = {}
    pncp.arquivos.return_value = [{"titulo": "edital.pdf", "tipoDocumentoNome": "Edital", "url": "u1"}]
    pncp.baixar.side_effect = RuntimeError("timeout")
    r = Counter()
    ach = P.processo_do_edital(pncp, {"title": ""}, "4", r)
    assert ach.status == "falha" and r["falha_download"] == 1


def test_falha_no_detalhe_segue_para_os_arquivos_e_fica_contada():
    pncp = MagicMock()
    pncp.compra.side_effect = RuntimeError("PNCP detalhe: 500")
    pncp.arquivos.return_value = []
    r = Counter()
    ach = P.processo_do_edital(pncp, {"title": ""}, "4", r)
    assert r["falha_detalhe"] == 1
    assert ach.status == "nao_encontrado"   # consultou os arquivos: a compra não tem nenhum
    pncp.arquivos.assert_called_once()


def _rodar_main(linhas, achado, argv):
    sb = MagicMock()
    sb.selecionar.return_value = linhas
    orig = (P.Supabase, P.PNCP, P.env, P.processo_do_edital)
    P.Supabase = lambda *a, **k: sb
    P.PNCP = lambda *a, **k: MagicMock()
    P.env = lambda nome, padrao=None, obrigatorio=False: padrao or "x"
    P.processo_do_edital = lambda *a, **k: achado
    try:
        codigo = P.main(argv)
    finally:
        P.Supabase, P.PNCP, P.env, P.processo_do_edital = orig
    return codigo, sb


_LINHA = {"id": 7, "codigo_externo": "13110218000140-1-000005/2026", "numero_processo": "4",
          "numero_edital": "Pregão Eletrônico nº 4/2026", "raw": {"x": 1}}


def test_main_padrao_grava_so_em_raw():
    ach = P.Achado("encontrado", "0137/2026", "edital", "ed.zip", 5, "PROCESSO ADMINISTRATIVO Nº 0137/2026")
    codigo, sb = _rodar_main([dict(_LINHA)], ach, [])
    assert codigo == 0
    _, id_, campos = sb.atualizar.call_args.args
    assert id_ == 7 and "numero_processo" not in campos
    assert campos["raw"]["processo_extraido"]["valor"] == "0137/2026"
    assert campos["raw"]["processo_extraido"]["processo_pncp"] == "4"
    assert campos["raw"]["x"] == 1


def test_main_flag_troca_numero_processo_so_com_peso_alto():
    alto = P.Achado("encontrado", "0137/2026", "edital", None, 5, "t")
    _, sb = _rodar_main([dict(_LINHA)], alto, ["--gravar-numero-processo"])
    campos = sb.atualizar.call_args.args[2]
    assert campos["numero_processo"] == "0137/2026" and campos["raw"]["processo_pncp"] == "4"
    baixo = P.Achado("encontrado", "0137/2026", "edital", None, 1, "t")
    _, sb = _rodar_main([dict(_LINHA)], baixo, ["--gravar-numero-processo"])
    assert "numero_processo" not in sb.atualizar.call_args.args[2]


def test_main_dry_run_nao_grava_e_falha_da_codigo_2():
    _, sb = _rodar_main([dict(_LINHA)], P.Achado("encontrado", "0137/2026", "edital", None, 5, "t"), ["--dry-run"])
    sb.atualizar.assert_not_called()
    codigo, _ = _rodar_main([dict(_LINHA)], P.Achado("falha", motivo="503"), ["--dry-run"])
    assert codigo == 2


def test_main_codigo_invalido_e_contado():
    ruim = dict(_LINHA, codigo_externo="sem-padrao")
    codigo, sb = _rodar_main([ruim], P.Achado("encontrado", "1/2026"), [])
    assert codigo == 0
    sb.atualizar.assert_not_called()
