"""Spec 0061, K-15 (CA-13): o coletor Paradigma grava o fórum do processo (PesquisarProcessoDetalheForum) em
licitacoes_externas.esclarecimentos, no formato da coleta da Sest Senat. Fixture sintética; nenhum teste chama o
portal."""
import json
from pathlib import Path
from unittest.mock import MagicMock

import requests

from coletor import paradigma as P

FX = json.loads((Path(__file__).parent / "fixtures" / "paradigma" / "fieb_38191_lances.json").read_text(encoding="utf-8"))

FORUM = [
    {"nCdMensagem": 501, "nCdMensagemPai": 0, "nIdTipo": 1, "sDsTitulo": "Pedido de esclarecimento",
     "sDsMensagem": "O piso pode ser de 15 mm?", "tDtMensagem": "/Date(1762900000000)/",
     "bFlUsuarioComprador": 0, "nCdAnexo": 0},
    {"nCdMensagem": 502, "nCdMensagemPai": 501, "nIdTipo": 1, "sDsTitulo": "Resposta",
     "sDsMensagem": "Sim, conforme o termo de referência.", "tDtMensagem": "/Date(1762990000000)/",
     "bFlUsuarioComprador": 1, "nCdAnexo": 9001},
]


class SbFake:
    def __init__(self):
        self.licitacoes: list[dict] = []

    def upsert(self, tabela, linhas, conflito):
        linhas = linhas if isinstance(linhas, list) else [linhas]
        if tabela == "licitacoes_externas":
            self.licitacoes.extend(linhas)
        return [{**ln, "id": 10} for ln in linhas]

    def selecionar(self, *a, **k):
        return []

    def atualizar(self, *a, **k):
        return None


def _portal(forum):
    p = P.PortalParadigma(P.FONTES["fieb"], sessao=MagicMock(), delay=0)
    p.detalhes = MagicMock(return_value=P.limpar(FX["detalhe"]))
    p.itens = MagicMock(return_value=P.limpar(FX["itens"]))
    p.resultado_item = lambda d, it, ls=None: P.limpar(FX["lances"])
    p.lances = lambda d, it: P.limpar(FX["lances"])
    chamadas = []
    ws = p._ws

    def fake_ws(metodo, corpo):
        chamadas.append((metodo, corpo))
        if metodo == "PesquisarProcessoDetalheForum":
            if isinstance(forum, Exception):
                raise forum
            return forum
        return ws(metodo, corpo)
    p._ws = fake_ws
    return p, chamadas


def _coletar(forum):
    sb = SbFake()
    p, chamadas = _portal(forum)
    resumo = P.coletar(p, sb, [], 1, False, True, None, None, [(38191, 19)], origem="manual")
    return sb, resumo, chamadas


def test_ca13_forum_grava_perguntas_e_respostas_no_formato_da_sest_senat():
    sb, resumo, chamadas = _coletar(FORUM)
    assert resumo["erros"] == 0
    corpo = [c[1] for c in chamadas if c[0] == "PesquisarProcessoDetalheForum"][0]
    assert corpo == {"dtoForum": {"dtoProcesso": {"nCdProcesso": 38191, "nCdModulo": 19},
                                  "dtoIdioma": {"nCdIdioma": 1}}}
    esc = sb.licitacoes[0]["esclarecimentos"]
    assert [m["id"] for m in esc] == [501, 502]
    assert esc[1] == {"id": 502, "id_pai": 501, "tipo": 1, "titulo": "Resposta",
                      "mensagem": "Sim, conforme o termo de referência.", "data": esc[1]["data"],
                      "autor_e_comprador": True, "anexo_id": 9001}
    assert esc[0]["data"].startswith("2025-11-11") and esc[0]["autor_e_comprador"] is False
    assert resumo["forum_mensagens"] == 2


def test_ca13_forum_vazio_grava_lista_vazia():
    sb, resumo, _ = _coletar([])
    assert sb.licitacoes[0]["esclarecimentos"] == [] and resumo["erros"] == 0


def test_ca13_falha_do_forum_conta_erro_e_nao_apaga_o_ja_coletado():
    sb, resumo, _ = _coletar(requests.ConnectionError("portal fora"))
    assert resumo["erros"] == 1
    assert "esclarecimentos" not in sb.licitacoes[0]          # o upsert não sobrescreve o fórum já gravado
    assert sb.licitacoes[0]["id_externo"] is not None          # o processo continua gravado


def test_ca13_resposta_que_nao_e_lista_e_erro_e_nao_vira_sem_mensagens():
    sb, resumo, _ = _coletar({"erro": "x"})
    assert resumo["erros"] == 1 and "esclarecimentos" not in sb.licitacoes[0]


def test_ca13_dry_run_nao_chama_o_forum():
    p, chamadas = _portal(FORUM)
    P.coletar(p, None, [], 1, True, False, None, None, [(38191, 19)], origem="manual")
    assert not any(c[0] == "PesquisarProcessoDetalheForum" for c in chamadas)
