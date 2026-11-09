"""Coletor do catálogo Compras MG: sem rede (sessão falsa)."""
import csv

import pytest

from coletor import compras_mg_catalogo as mg
from coletor.proveniencia import hash_payload

INICIAIS = {"grupos": [
    {"id": 66, "codigo": 72, "descricao": "72 - ARTIGOS DOMESTICOS E COMERCIAIS"},
    {"id": 72, "codigo": 78, "descricao": "78 - MATERIAIS E EQUIPAMENTOS PARA RECREACAO E DESPORTO"},
]}


def _item(i):
    return {
        "id": i, "codigo": f"{i:09d}", "versao": 1, "situacao": {"id": "ATIVO", "descricao": "Ativo"},
        "ehMaterialOuServico": {"id": "MATERIAL"}, "especificacaoCompleta": f"ITEM {i}",
        "especificacaoComplementar": "LINHA A\r\nLINHA B", "sinonimos": "BOLA/ALCA   ;10KG",
        "materialOuServico": {"codigoFormatado": "78300835", "nome": "KETTLEBELL -",
                              "classe": {"codigoGrupoFormatado": "78 - X", "codigoNomeFormatado": "7830 - Y"},
                              "naturezaDespesa": {"nome": "MATERIAL PERMANENTE"}},
        "sustentavel": False, "ehGenerico": None,
    }


class Resp:
    def __init__(self, status, corpo=None, headers=None):
        self.status_code, self._corpo, self.headers, self.text = status, corpo, headers or {}, str(corpo)

    def json(self):
        return self._corpo


class Sessao:
    """Responde `pesquisar` a partir de uma lista de itens, paginada pelo corpo enviado."""

    def __init__(self, itens, total=None, falhas=None, ignora_pagina=False):
        self.itens, self.total = itens, len(itens) if total is None else total
        self.falhas = list(falhas or [])
        self.ignora_pagina = ignora_pagina
        self.corpos = []

    def request(self, metodo, url, json=None, headers=None, timeout=None):
        assert timeout is not None
        if self.falhas:
            return self.falhas.pop(0)
        if url == mg.URL_INICIAIS:
            return Resp(200, INICIAIS)
        self.corpos.append(json)
        n, p = json["sizePerPage"], 1 if self.ignora_pagina else json["page"]
        return Resp(200, {"resultado": {"total": self.total, "dados": self.itens[(p - 1) * n:p * n]}})


def test_resolve_codigo_para_id_interno():
    # o grupo 78 tem id 72: mandar o código como idGrupo traz outro grupo
    assert mg.resolver_grupos(INICIAIS, [78])[0]["id"] == 72
    with pytest.raises(mg.ErroColeta):
        mg.resolver_grupos(INICIAIS, [99])
    with pytest.raises(mg.ErroColeta):
        mg.resolver_grupos({}, [78])


def test_corpo_da_tela_com_ordenacao_estavel():
    # a tela manda ordenacoes=[]; sem ordem a paginação do servidor repete e perde itens
    assert mg.montar_corpo(72, ["ATIVO"], 1, 100) == {
        "reqId": 2, "ordenacoes": [{"sortName": "id", "sortOrder": "asc"}], "sizePerPage": 100, "page": 1,
        "filtros": {"situacoes": ["ATIVO"], "tiposGrupo": "MATERIAL", "idGrupo": "72"},
    }


def test_pagina_ate_o_total():
    s = Sessao([_item(i) for i in range(1, 251)])
    esperas = []
    itens, total = mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], tamanho=100, delay=0,
                                    dormir=esperas.append)
    assert (len(itens), total) == (250, 250)
    assert [c["page"] for c in s.corpos] == [1, 2, 3]
    assert all(c["filtros"]["idGrupo"] == "72" for c in s.corpos)
    assert esperas == [1.0, 1.0]  # delay nunca abaixo de 1 s


def test_grupo_vazio_e_valido():
    itens, total = mg.coletar_grupo(Sessao([]), {"id": 1, "codigo": 1}, ["ATIVO"], dormir=lambda _: None)
    assert (itens, total) == ([], 0)


def test_total_que_nao_fecha_e_erro():
    s = Sessao([_item(i) for i in range(1, 51)], total=60)
    with pytest.raises(mg.ErroColeta, match="coletados 50 de total 60"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], tamanho=100, dormir=lambda _: None)


def test_pagina_repetida_e_erro():
    s = Sessao([_item(i) for i in range(1, 251)], ignora_pagina=True)
    with pytest.raises(mg.ErroColeta, match="repetiu"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], tamanho=100, dormir=lambda _: None)


def test_retry_em_503_e_429_e_para_em_4xx():
    s = Sessao([_item(1)], falhas=[Resp(503), Resp(429, headers={"Retry-After": "3"})])
    esperas = []
    itens, _ = mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], dormir=esperas.append)
    assert len(itens) == 1 and esperas[1] == 3.0

    s = Sessao([_item(1)], falhas=[Resp(400, "Unrecognized field")])
    with pytest.raises(mg.ErroColeta, match="HTTP 400"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], dormir=lambda _: None)


def test_resposta_sem_envelope_e_erro():
    class S(Sessao):
        def request(self, *a, **k):
            return Resp(200, {"mensagem": "Ocorreu uma exceção"})
    with pytest.raises(mg.ErroColeta, match="resultado.dados"):
        mg.coletar_grupo(S([]), {"id": 72, "codigo": 78}, ["ATIVO"], dormir=lambda _: None)


def test_executar_gera_json_e_csv(tmp_path):
    itens = [_item(1), _item(2)]
    itens[1]["especificacaoCompleta"] = "=HYPERLINK(1)"
    resumo = mg.executar([78, 78], ["ATIVO"], tmp_path, tamanho=100, delay=1, sessao=Sessao(itens),
                         dormir=lambda _: None)
    assert len(resumo["grupos"]) == 1  # grupo repetido coletado uma vez
    assert resumo["linhas_csv"] == 2 and resumo["grupos"][0]["total_api"] == 2
    with open(resumo["csv"], encoding="utf-8-sig", newline="") as f:
        linhas = list(csv.DictReader(f, delimiter=";"))
    l0 = linhas[0]
    assert l0["codigo_item"] == "000000001"
    assert l0["grupo_id_filtro"] == "72" and l0["grupo_codigo_filtro"] == "78"
    assert l0["especificacao_complementar"] == "LINHA A\r\nLINHA B"  # texto da fonte intacto
    assert l0["sinonimos"] == "BOLA/ALCA; 10KG"
    assert l0["eh_generico"] == ""  # None não vira "nao"
    assert l0["payload_hash"] == hash_payload(_item(1))  # mesmo hash da proveniência do resto do coletor
    assert linhas[1]["especificacao"] == "'=HYPERLINK(1)"  # sem fórmula no Excel
    import json
    bruto = json.loads(open(resumo["grupos"][0]["json"], encoding="utf-8").read())
    assert bruto["itens"][1]["especificacaoCompleta"] == "=HYPERLINK(1)"  # JSON bruto intacto


def test_erro_de_rede_esgota_tentativas_e_json_invalido():
    class Rede(Sessao):
        def request(self, *a, **k):
            raise mg.requests.Timeout("lento")
    esperas = []
    with pytest.raises(mg.ErroColeta, match="desistiu após 5 tentativas"):
        mg.coletar_grupo(Rede([]), {"id": 72, "codigo": 78}, ["ATIVO"], dormir=esperas.append)
    assert len(esperas) == mg.TENTATIVAS - 1

    class NaoJson(Resp):
        def json(self):
            raise ValueError("html")
    s = Sessao([], falhas=[NaoJson(200)])
    with pytest.raises(mg.ErroColeta, match="não é JSON"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], dormir=lambda _: None)


def test_total_ausente_ou_invalido_e_erro():
    for corpo in ({"resultado": {"dados": []}}, {"resultado": {"total": "abc", "dados": []}}):
        class S(Sessao):
            def request(self, *a, _c=corpo, **k):
                return Resp(200, _c)
        with pytest.raises(mg.ErroColeta, match="total ausente ou inválido"):
            mg.coletar_grupo(S([]), {"id": 72, "codigo": 78}, ["ATIVO"], dormir=lambda _: None)


def test_erro_na_pagina_intermediaria_nao_e_fim():
    class S(Sessao):
        def request(self, metodo, url, json=None, **k):
            if json["page"] == 2:
                return Resp(400, "falhou")
            return super().request(metodo, url, json=json, **k)
    s = S([_item(i) for i in range(1, 251)])
    with pytest.raises(mg.ErroColeta, match=r"grupo 78 pág 2\]: HTTP 400"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], tamanho=100, dormir=lambda _: None)


def test_repeticao_parcial_faz_contagem_nao_fechar():
    class S(Sessao):
        def request(self, metodo, url, json=None, **k):
            # página 2 devolve metade da página 1 + metade nova; a página 3 vem vazia
            p = json["page"]
            dados = {1: self.itens[0:4], 2: self.itens[2:6]}.get(p, [])
            return Resp(200, {"resultado": {"total": 8, "dados": dados}})
    s = S([_item(i) for i in range(1, 9)])
    with pytest.raises(mg.ErroColeta, match="coletados 6 de total 8"):
        mg.coletar_grupo(s, {"id": 72, "codigo": 78}, ["ATIVO"], tamanho=4, dormir=lambda _: None)


def test_grupo_sem_codigo_numerico_e_ignorado():
    iniciais = {"grupos": [{"id": 9, "codigo": "7A"}, *INICIAIS["grupos"]]}
    assert mg.resolver_grupos(iniciais, [78, 78]) == [INICIAIS["grupos"][1]]
