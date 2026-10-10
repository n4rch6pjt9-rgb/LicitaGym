"""OCR por página + detector de degeneração (spec 0016, CA-16/CA-17; medição de 09/10/2026 em Baraúna).
Texto sintético: nenhum conteúdo do arquivo real entra no repositório."""
import io
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from coletor import ia as IA
from coletor import indexador as IX
from coletor.ocr import (EXTRAIDO, OCR_DEGENERADO, OCR_REQUIRED, Limiar, avaliar_pagina,
                         detectar_degeneracao)

UTIL = ("PREFEITURA MUNICIPAL DE EXEMPLO\nAVISO DE SUSPENSÃO\nO Pregoeiro torna público que fica SUSPENSO o "
        "andamento do Pregão Eletrônico nº 999/2026, até ulterior deliberação.\nExemplo, 1 de janeiro de 2026.\n")
# Padrão das págs. 2-4 do arquivo 3 de Baraúna: conteúdo útil e, depois, milhares de pontos.
DEGENERADO = UTIL + "." * 15000
SUMARIO = "\n".join(f"{i}. CLÁUSULA {i} {'.' * 60} {i + 2}" for i in range(1, 30))
TABELA = "\n".join(["ITEM | DESCRIÇÃO | UNID. | QTD"] + [f"{i} | Anilha {i} kg | UN | 10" for i in range(1, 60)])


def test_pontos_repetidos_viram_ocr_degenerado_com_parcial():
    p = avaliar_pagina(DEGENERADO)
    assert p.estado == OCR_DEGENERADO and p.texto == ""
    assert p.texto_parcial == UTIL.rstrip()
    assert "SUSPENSO" in p.texto_parcial and "." * 300 not in p.texto_parcial
    assert p.resumo() == {"estado": OCR_DEGENERADO, "chars_ocr": len(DEGENERADO),
                          "chars_parcial": len(UTIL.rstrip()), "motivo": p.motivo}


@pytest.mark.parametrize("cauda", [". " * 400, "0,00 " * 200, "LOTE 1 - ITEM 1\n" * 40, "-" * 500, "_" * 500])
def test_padroes_curtos_e_linhas_repetidas(cauda):
    d = detectar_degeneracao(UTIL + cauda)
    assert d is not None and d.inicio >= len(UTIL) - 1 and d.repeticoes >= 20


def test_linha_longa_repetida_em_sequencia():
    linha = "Declaro, sob as penas da lei, que a empresa atende aos requisitos do edital e seus anexos.\n"
    assert len(linha) > 80                                  # maior que a unidade da busca por padrão curto
    d = detectar_degeneracao(UTIL + linha * 25)
    assert d is not None and d.repeticoes == 25 and d.inicio == len(UTIL)


@pytest.mark.parametrize("texto", [UTIL, SUMARIO, TABELA, UTIL + "." * 120, "UNID.\n" * 30])
def test_texto_normal_nao_e_degenerado(texto):
    assert detectar_degeneracao(texto) is None
    assert avaliar_pagina(texto).estado == EXTRAIDO


def test_limiar_configuravel(monkeypatch):
    texto = UTIL + "." * 250
    assert detectar_degeneracao(texto) is None                               # padrão: 300 caracteres
    assert detectar_degeneracao(texto, Limiar(min_chars=200)) is not None
    monkeypatch.setenv("OCR_DEGENERADO_MIN_CHARS", "200")
    monkeypatch.setenv("OCR_DEGENERADO_MIN_REP", "5")
    lim = Limiar.do_ambiente()
    assert (lim.min_chars, lim.min_rep) == (200, 5)
    assert avaliar_pagina(texto, limiar=lim).estado == OCR_DEGENERADO


def test_limite_de_saida_nao_vira_extraido():
    p = avaliar_pagina(UTIL, truncado=True)
    assert p.estado == OCR_DEGENERADO and p.texto == "" and p.texto_parcial == UTIL.rstrip()
    assert "limite" in p.motivo


@pytest.mark.parametrize("texto", [None, "", "  \n ", "p. 3"])
def test_ocr_sem_texto_fica_ocr_required(texto):
    assert avaliar_pagina(texto).estado == OCR_REQUIRED


# --- indexador: uma chamada por página, número da página preservado, degenerada fora dos chunks ---

def _pdf_escaneado(n_paginas: int) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for _ in range(n_paginas):
        c.rect(50, 50, 100, 100)                         # página sem camada de texto
        c.showPage()
    c.save()
    return buf.getvalue()


def _ia_falsa(saidas):
    """saidas[i] = (texto, finish_reason) da i-ésima chamada de OCR."""
    ia = MagicMock()
    paginas_recebidas = []

    def ocr_pagina(pdf):
        from pypdf import PdfReader
        paginas_recebidas.append(len(PdfReader(io.BytesIO(pdf)).pages))
        return saidas[len(paginas_recebidas) - 1]
    ia.ocr_pagina.side_effect = ocr_pagina
    ia.extrair_campos.return_value = {"tipo_documento": "aviso"}
    ia.embed.side_effect = lambda ts, **k: [[0.1] * 768 for _ in ts]
    return ia, paginas_recebidas


def _docs(tmp_path, pdf):
    arq = tmp_path / "arquivo3.pdf"
    arq.write_bytes(pdf)
    return [{"id": 3, "licitacao_id": 135, "secao": "processo", "nome_original": "arquivo3.pdf",
             "arquivo_origem": "arquivo3.pdf", "fornecedor_nome": None, "sha256": "h", "storage_uri": str(arq)}]


def test_paginas_pdf_separa_uma_por_pagina():
    partes = IX.paginas_pdf(_pdf_escaneado(3))
    assert [n for n, _ in partes] == [1, 2, 3]
    assert IX.paginas_pdf(b"%PDF-quebrado") == [(None, b"%PDF-quebrado")]


def test_indexador_ocr_por_pagina_e_degenerada_fora_dos_chunks(tmp_path):
    ia, recebidas = _ia_falsa([(UTIL, "STOP"), (DEGENERADO, "STOP"), (UTIL + "." * 2000, "MAX_TOKENS"),
                               ("", "STOP")])
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, _docs(tmp_path, _pdf_escaneado(4)), {"numero_processo": "999/2026"}, True)

    assert recebidas == [1, 1, 1, 1]                      # CA-17: uma chamada por página, PDF de 1 página
    assert r["status"] == "indexado"
    linhas = sb.upsert.call_args.args[1]
    assert {l["pagina"] for l in linhas} == {1}            # só a pág. 1 (extraido) virou chunk
    assert not any("." * 300 in l["texto"] for l in linhas)
    extracao = sb.atualizar.call_args.args[2]["extracao"]
    assert extracao["ocr_incompleto"] is True
    assert [(p["pagina"], p["estado"]) for p in extracao["ocr_paginas"]] == [
        (1, EXTRAIDO), (2, OCR_DEGENERADO), (3, OCR_DEGENERADO), (4, OCR_REQUIRED)]
    assert extracao["ocr_paginas"][2]["finish_reason"] == "MAX_TOKENS"
    cfg = extracao["ocr_config"]
    assert cfg["modelo"] == IA.GEN_MODEL and cfg["max_output_tokens"] == IA.OCR_MAX_TOKENS
    assert cfg["limiar"]["min_chars"] == Limiar().min_chars and cfg["limiar"]["min_rep"] == Limiar().min_rep
    assert not any("texto" in p for p in extracao["ocr_paginas"])   # relatório sem conteúdo


def test_indexador_tudo_degenerado_nao_indexa(tmp_path):
    ia, _ = _ia_falsa([(DEGENERADO, "STOP"), (DEGENERADO, "STOP")])
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, _docs(tmp_path, _pdf_escaneado(2)), {"numero_processo": "999/2026"}, True)
    assert r["status"] == "ignorado" and r["erro"].startswith(OCR_DEGENERADO)
    assert [p["estado"] for p in r["extracao"]["ocr_paginas"]] == [OCR_DEGENERADO, OCR_DEGENERADO]
    sb.upsert.assert_not_called()
    sb.remover_chunks.assert_not_called()                 # chunks antigos não são apagados
    ia.embed.assert_not_called()


def test_main_grava_relatorio_de_ocr_no_ignorado(monkeypatch):
    sb = MagicMock()
    sb.selecionar.side_effect = [
        [{"id": 3, "licitacao_id": 1, "secao": "processo", "nome_original": "a.pdf", "arquivo_origem": "a.pdf",
          "fornecedor_nome": None, "sha256": "h", "storage_uri": "x"}],
        [{"id": 1, "numero_processo": "1"}]]
    monkeypatch.setattr(IX, "Supabase", lambda *a: sb)
    monkeypatch.setattr(IX, "env", lambda *a, **k: "x")
    monkeypatch.setattr("coletor.ia.Gemini", lambda: MagicMock())
    rel = {"ocr_paginas": [{"pagina": 1, "estado": OCR_DEGENERADO}]}
    monkeypatch.setattr(IX, "indexar_grupo", lambda *a: {"status": "ignorado", "erro": "OCR_DEGENERADO: páginas [1]",
                                                          "extracao": rel})
    IX.main([])
    campos = sb.atualizar.call_args.args[2]
    assert campos == {"status_processamento": "ignorado", "erro": "OCR_DEGENERADO: páginas [1]", "extracao": rel}


# --- chamada ao Gemini: limite de saída e pensamento desligado ---

def test_ocr_pagina_usa_limite_de_saida(monkeypatch):
    from google.genai import types
    g = object.__new__(IA.Gemini)
    g.types = types
    resposta = SimpleNamespace(text="texto", candidates=[SimpleNamespace(finish_reason=types.FinishReason.MAX_TOKENS)])
    g.client = MagicMock()
    g.client.models.generate_content.return_value = resposta
    assert g.ocr_pagina(b"%PDF-1.4") == ("texto", "MAX_TOKENS")
    cfg = g.client.models.generate_content.call_args.kwargs["config"]
    assert cfg.max_output_tokens == IA.OCR_MAX_TOKENS and cfg.temperature == 0
    assert cfg.thinking_config.thinking_budget == 0


def test_motivo_fim_sem_candidato():
    assert IA.motivo_fim(SimpleNamespace(candidates=[])) is None
    assert IA.motivo_fim(SimpleNamespace(candidates=None)) is None
    assert IA.motivo_fim(SimpleNamespace(candidates=[SimpleNamespace(finish_reason="STOP")])) == "STOP"


# --- achados da revisão: formulário em branco, reprocessamento, motivo sem conteúdo, modelo pro ---

FORMULARIO = "|" + "      |" * 6 + "\n"


@pytest.mark.parametrize("meio", [FORMULARIO * 40, ("_" * 70 + "\n") * 25])
def test_formulario_em_branco_no_meio_da_pagina_nao_e_degenerado(meio):
    texto = UTIL + meio + "Local e data. Assinatura do representante legal da empresa licitante.\n" * 3
    assert detectar_degeneracao(texto) is None
    assert avaliar_pagina(texto).estado == EXTRAIDO


def test_repeticao_enorme_no_meio_conta_mesmo_com_texto_depois():
    assert detectar_degeneracao(UTIL + "." * 5000 + UTIL * 3) is not None


def test_motivo_nao_carrega_conteudo_do_documento():
    linha = "CPF 123.456.789-01 FULANO DE TAL\n"
    p = avaliar_pagina(UTIL + linha * 30)
    assert p.estado == OCR_DEGENERADO
    assert "123" not in p.motivo and "FULANO" not in p.motivo and "texto" in p.motivo


def test_reprocessar_ocr_seleciona_ignorados_por_degeneracao(monkeypatch):
    sb = MagicMock()
    sb.selecionar.side_effect = [[], [], []]
    monkeypatch.setattr(IX, "Supabase", lambda *a: sb)
    monkeypatch.setattr(IX, "env", lambda *a, **k: "x")
    monkeypatch.setattr("coletor.ia.Gemini", lambda: MagicMock())
    IX.main(["--reprocessar-ocr"])
    filtros = sb.selecionar.call_args_list[1].kwargs
    assert filtros["status_processamento"] == "eq.ignorado"
    assert filtros["or"] == "(erro.like.OCR_DEGENERADO*,erro.like.OCR_REQUIRED*)"


def test_ocr_pagina_sem_thinking_budget_fora_do_flash(monkeypatch):
    from google.genai import types
    monkeypatch.setattr(IA, "GEN_MODEL", "gemini-2.5-pro")
    g = object.__new__(IA.Gemini)
    g.types = types
    g.client = MagicMock()
    g.client.models.generate_content.return_value = SimpleNamespace(text="t", candidates=[])
    assert g.ocr_pagina(b"%PDF-1.4") == ("t", None)
    cfg = g.client.models.generate_content.call_args.kwargs["config"]
    assert cfg.thinking_config is None and cfg.max_output_tokens == IA.OCR_MAX_TOKENS


def test_pagina_grande_demais_entra_no_relatorio_e_marca_incompleto(tmp_path, monkeypatch):
    # págs. 1 e 3 normais; pág. 2 "maior que 19 MB" (simulada) não vai ao OCR, mas fica no relatório
    monkeypatch.setattr(IX, "paginas_pdf", lambda pdf: [(1, b"p1"), (2, b"x" * (19 * 1024 * 1024 + 1)), (3, b"p3")])
    ia, _ = _ia_falsa([])
    ia.ocr_pagina.side_effect = lambda pdf: (UTIL, "STOP")
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, _docs(tmp_path, _pdf_escaneado(3)), {"numero_processo": "999/2026"}, True)
    assert r["status"] == "indexado" and ia.ocr_pagina.call_count == 2
    extracao = sb.atualizar.call_args.args[2]["extracao"]
    assert extracao["ocr_incompleto"] is True
    assert [(p["pagina"], p["estado"]) for p in extracao["ocr_paginas"]] == [
        (1, EXTRAIDO), (2, OCR_REQUIRED), (3, EXTRAIDO)]


def test_pdf_que_o_pypdf_nao_separa_fica_ocr_required_sem_ocr(tmp_path, monkeypatch):
    monkeypatch.setattr(IX, "paginas_pdf", lambda pdf: [(None, pdf)])
    ia, _ = _ia_falsa([])
    sb = MagicMock()
    r = IX.indexar_grupo(sb, ia, _docs(tmp_path, _pdf_escaneado(2)), {"numero_processo": "999/2026"}, True)
    ia.ocr_pagina.assert_not_called()                      # nada de OCR do documento inteiro
    assert r["status"] == "ignorado" and r["erro"].startswith(OCR_REQUIRED)
    assert [(p["pagina"], p["estado"]) for p in r["extracao"]["ocr_paginas"]] == [(None, OCR_REQUIRED)]
    assert r["extracao"]["ocr_config"]["modelo"] == IA.GEN_MODEL


def test_ocr_vazio_em_todas_as_paginas_e_reprocessavel(tmp_path):
    ia, _ = _ia_falsa([("", "STOP"), ("", "STOP")])
    r = IX.indexar_grupo(MagicMock(), ia, _docs(tmp_path, _pdf_escaneado(2)), {"numero_processo": "999/2026"}, True)
    assert r["status"] == "ignorado" and r["erro"].startswith(f"{OCR_REQUIRED}: páginas [1, 2]")
