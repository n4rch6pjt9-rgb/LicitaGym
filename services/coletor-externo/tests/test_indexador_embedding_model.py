"""indexador grava licitacao_chunks.embedding_model com a constante do modelo (coletor/ia.py)."""
import io
from unittest.mock import MagicMock

from coletor import ia as IA
from coletor import indexador as IX

TEXTO = ("TERMO DE REFERÊNCIA\nAquisição de bolas, redes e tatames para a secretaria de esportes.\n") * 6


def _pdf():
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    y = 800
    for linha in TEXTO.split("\n"):
        c.drawString(40, y, linha); y -= 14
    c.showPage(); c.save()
    return buf.getvalue()


def _indexar(tmp_path, com_extracao=False):
    arq = tmp_path / "pncp-2.bin"; arq.write_bytes(_pdf())
    docs = [{"id": 7, "licitacao_id": 3, "secao": "processo", "nome_original": "ETP_E_TR",
             "arquivo_origem": "pncp-2", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)}]
    ia = MagicMock()
    ia.extrair_campos.return_value = {"tipo_documento": "termo_referencia", "resumo": "TR de material esportivo."}
    ia.embed.side_effect = lambda ts, **k: [[0.1] * 768 for _ in ts]
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, docs, {"numero_processo": "039/2026", "numero_edital": None, "fonte": "pncp"}, com_extracao)
    linhas = [l for c in sb.upsert.call_args_list for l in c.args[1]]
    return r, linhas, sb


def test_chunks_gravam_embedding_model_padrao(tmp_path):
    r, linhas, sb = _indexar(tmp_path)
    assert r["status"] == "indexado" and linhas
    assert IA.EMBED_MODEL == "text-multilingual-embedding-002"
    assert all(l["embedding_model"] == "text-multilingual-embedding-002" for l in linhas)
    assert sb.upsert.call_args.args[0] == "licitacao_chunks"


def test_resumo_tambem_grava_embedding_model(tmp_path):
    _, linhas, _ = _indexar(tmp_path, com_extracao=True)
    assert linhas[0]["metadados"]["chunk_kind"] == "resumo"
    assert {l["embedding_model"] for l in linhas} == {IA.EMBED_MODEL}


def test_embedding_model_segue_a_constante_do_ia(tmp_path, monkeypatch):
    # EMBED_MODEL vem do ambiente na importação de coletor.ia; o indexador lê a constante na hora de gravar.
    monkeypatch.setattr(IA, "EMBED_MODEL", "modelo-de-teste-001")
    _, linhas, _ = _indexar(tmp_path)
    assert {l["embedding_model"] for l in linhas} == {"modelo-de-teste-001"}
