"""Spec 0009 (preços históricos): coleta agendada de Pesquisa de Preço (CA-5) e detalhe só para completar (CA-9).

Nenhum teste chama a API real: a sessão HTTP do cliente é trocada por uma falsa que responde por endpoint e recusa
qualquer outra URL, e o banco é um Supabase falso em memória.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from coletor import compras_precos
from coletor import main as M

BASE = compras_precos.BASE_URL
URL_MATERIAL = BASE + compras_precos.ENDPOINT_MATERIAL
URL_DETALHE = BASE + compras_precos.ENDPOINT_DETALHE


def _preco(id_compra: str, id_item: int, item: int = 480144, desc: str | None = "Descrição do 1_", **extra) -> dict:
    return {
        "idCompra": id_compra,
        "idItemCompra": id_item,
        "idCompraItem": f"{id_compra}{id_item:05d}",
        "numeroItemCompra": id_item,
        "codigoItemCatalogo": item,
        "codigoPdm": "2640",
        "precoUnitario": 1000.0,
        "dataResultado": "2026-09-18",
        "niFornecedor": "04372852000160",
        "nomeFornecedor": "W.E.V COMERCIAL LTDA",
        "marca": "FORTIX",
        "estado": "PR",
        "descricaoDetalhadaItem": desc,
        **extra,
    }


def _resp(status: int, corpo: dict | None = None, headers: dict | None = None):
    r = MagicMock()
    r.status_code = status
    r.headers = headers or {}
    r.text = ""
    r.json.return_value = corpo if corpo is not None else {"resultado": [], "totalRegistros": 0}
    return r


class SessaoFalsa:
    """Responde por endpoint; qualquer URL fora da Pesquisa de Preço é erro de teste (nunca rede real)."""

    def __init__(self, material=None, detalhe=None):
        self.headers: dict = {}
        self.chamadas: list[tuple[str, dict, object]] = []
        self.material = material or (lambda params: _resp(200, {"resultado": [], "totalRegistros": 0}))
        self.detalhe = detalhe or (lambda params: _resp(200, {"resultado": [], "totalRegistros": 0}))

    def get(self, url, params=None, timeout=None):
        self.chamadas.append((url, dict(params or {}), timeout))
        assert timeout, "toda requisição tem timeout explícito"
        if url == URL_MATERIAL:
            return self.material(params)
        if url == URL_DETALHE:
            return self.detalhe(params)
        raise AssertionError(f"URL inesperada no teste: {url}")


class SupabaseFalso:
    def __init__(self, pdms=(2640,), pendentes=None, falhar_update=None):
        self.pdms = list(pdms)
        self.pendentes = list(pendentes or [])
        self.falhar_update = falhar_update or (lambda filtros: False)
        self.upserts: list[tuple[str, list, str]] = []
        self.selecoes: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, dict, dict]] = []
        self.rpcs: list[str] = []

    def rpc(self, funcao, params):
        self.rpcs.append(funcao)
        if funcao == "catalogo_catmat_pdms_efetivos":
            return [{"codigo_pdm": p} for p in self.pdms]
        return 0

    def drenar_licitacao_match(self, *a, **k):
        return 0

    def upsert(self, tabela, linhas, conflito):
        self.upserts.append((tabela, [dict(x) for x in linhas], conflito))
        return linhas

    def selecionar(self, tabela, **filtros):
        self.selecoes.append((tabela, dict(filtros)))
        return [dict(p) for p in self.pendentes]

    def atualizar_onde(self, tabela, filtros, campos):
        self.updates.append((tabela, dict(filtros), dict(campos)))
        if self.falhar_update(filtros):
            raise RuntimeError("Supabase precos_praticados_itens: 500")
        return 1


@pytest.fixture
def sem_espera(monkeypatch):
    esperas: list[float] = []
    monkeypatch.setattr(compras_precos.time, "sleep", esperas.append)
    return esperas


def _cliente(sessao: SessaoFalsa) -> compras_precos.ClienteComprasPrecos:
    return compras_precos.ClienteComprasPrecos(delay=1.0, sessao=sessao)


def _main_com(monkeypatch, sessao: SessaoFalsa, sb: SupabaseFalso | None, sestsenat=None):
    """main() com sessão HTTP e Supabase falsos. sestsenat: resultado de coletar_processo (None = não pode rodar)."""
    monkeypatch.setattr(compras_precos.requests, "Session", lambda: sessao)
    monkeypatch.setattr(M, "Supabase", lambda *a, **k: sb)
    monkeypatch.setattr(M, "env", lambda nome, padrao=None, obrigatorio=False: padrao if padrao else "x")
    monkeypatch.setattr(M, "Armazenamento", SimpleNamespace(do_ambiente=lambda: object()))
    chamados: list[int] = []

    def portal(**_k):
        if sestsenat is None:
            raise AssertionError("SEST SENAT não deveria rodar")
        return object()

    def coletar_processo(*a, **k):
        chamados.append(1)
        return sestsenat

    monkeypatch.setattr(M, "PortalSestSenat", portal)
    monkeypatch.setattr(M, "coletar_processo", coletar_processo)
    return chamados


# ---------------------------------------------------------------------------------------------------------------------
# CA-5: o Cloud Run Job (coletor.main) roda compras_precos em modo catálogo
# ---------------------------------------------------------------------------------------------------------------------
def test_ca5_main_coleta_precos_em_modo_catalogo(monkeypatch, sem_espera):
    sessao = SessaoFalsa(material=lambda p: _resp(200, {"resultado": [_preco("16021105900032024", 1)],
                                                         "totalRegistros": 1, "totalPaginas": 1}))
    sb = SupabaseFalso(pdms=[2640])
    _main_com(monkeypatch, sessao, sb)

    assert M.main(["--coleta", "precos"]) == 0

    assert "catalogo_catmat_pdms_efetivos" in sb.rpcs  # modo catálogo: PDMs da empresa, não lista fixa
    materiais = [c for c in sessao.chamadas if c[0] == URL_MATERIAL]
    assert materiais and all(c[1]["tipo"] == "codigoPdm" and c[1]["codigo"] == 2640 for c in materiais)
    assert [u[0] for u in sb.upserts] == ["precos_praticados_itens"]
    assert sb.upserts[0][2] == "id_compra,id_item_compra"
    assert all(e >= 1.0 for e in sem_espera)  # delay >= 1 s antes de cada GET


def test_ca5_main_padrao_roda_sestsenat_e_precos(monkeypatch, sem_espera):
    sessao = SessaoFalsa()
    sb = SupabaseFalso(pdms=[2640])
    chamados = _main_com(monkeypatch, sessao, sb, sestsenat={"status": "ok", "erros": 0})

    assert M.main(["--ids", "1"]) == 0
    assert chamados == [1]
    assert any(c[0] == URL_MATERIAL for c in sessao.chamadas)


def test_ca5_main_so_sestsenat_nao_chama_precos(monkeypatch, sem_espera):
    sessao = SessaoFalsa()
    sb = SupabaseFalso()
    _main_com(monkeypatch, sessao, sb, sestsenat={"status": "ok", "erros": 0})

    assert M.main(["--ids", "1", "--coleta", "sestsenat"]) == 0
    assert sessao.chamadas == []
    assert sb.rpcs == []


def test_ca5_main_falha_na_api_de_precos_sai_com_1(monkeypatch, sem_espera):
    sessao = SessaoFalsa(material=lambda p: _resp(503))
    sb = SupabaseFalso(pdms=[2640])
    _main_com(monkeypatch, sessao, sb)

    assert M.main(["--coleta", "precos"]) == 1
    assert sb.upserts == []


def test_ca5_main_falha_do_catalogo_sai_com_1_sem_lista_fixa(monkeypatch, sem_espera):
    sessao = SessaoFalsa()
    sb = SupabaseFalso()
    sb.rpc = MagicMock(side_effect=RuntimeError("Supabase rpc: 500"))
    _main_com(monkeypatch, sessao, sb)

    assert M.main(["--coleta", "precos"]) == 1
    assert sessao.chamadas == []


def test_ca5_main_dry_run_de_precos_nao_grava_nem_completa_detalhe(monkeypatch, sem_espera):
    sessao = SessaoFalsa()
    criados: list[int] = []
    _main_com(monkeypatch, sessao, None)
    monkeypatch.setattr(M, "Supabase", lambda *a, **k: criados.append(1))

    assert M.main(["--coleta", "precos", "--dry-run"]) == 0
    assert criados == []
    assert all(c[0] == URL_MATERIAL for c in sessao.chamadas)


def test_ca5_upsert_nao_apaga_descricao_detalhada_ja_completada(sem_espera):
    """Linha sem descrição no 1_ vai no upsert SEM a coluna: o detalhe gravado antes pelo 2_ não volta a vazio."""
    itens = [_preco("16021105900032024", 1, desc="Com descrição"), _preco("16021105900032024", 2, desc="  "),
             _preco("16021105900032024", 3, desc=None)]
    sessao = SessaoFalsa(material=lambda p: _resp(200, {"resultado": itens, "totalRegistros": 3, "totalPaginas": 1}))
    sb = SupabaseFalso()

    res = compras_precos.coletar(_cliente(sessao), sb, pdms=[2640])

    assert res["sucesso"] is True
    assert res["total_gravados"] == 3
    com = [ln for _, lote, _ in sb.upserts for ln in lote if "descricao_detalhada_item" in ln]
    sem = [ln for _, lote, _ in sb.upserts for ln in lote if "descricao_detalhada_item" not in ln]
    assert [ln["id_item_compra"] for ln in com] == [1]
    assert com[0]["descricao_detalhada_item"] == "Com descrição"
    assert sorted(ln["id_item_compra"] for ln in sem) == [2, 3]
    # cada lote do PostgREST tem as mesmas chaves em todas as linhas
    for _, lote, _ in sb.upserts:
        assert len({tuple(sorted(ln)) for ln in lote}) == 1


# ---------------------------------------------------------------------------------------------------------------------
# CA-9: 2_consultarMaterialDetalhe só nas linhas sem descrição detalhada
# ---------------------------------------------------------------------------------------------------------------------
PENDENTES = [
    {"id_compra": "16021105900032024", "id_item_compra": 1, "codigo_item_catalogo": 480144},
    {"id_compra": "16021105900032024", "id_item_compra": 2, "codigo_item_catalogo": 480144},
    {"id_compra": "09018105900012025", "id_item_compra": 7, "codigo_item_catalogo": 480144},
    {"id_compra": "15851705900012026", "id_item_compra": 3, "codigo_item_catalogo": 233523},
]


def _detalhe_por_item(mapa: dict[int, object]):
    def responder(params):
        valor = mapa[params["codigoItemCatalogo"]]
        if isinstance(valor, int):
            return _resp(valor)
        return _resp(200, {"resultado": valor, "totalRegistros": len(valor), "totalPaginas": 1})
    return responder


def test_ca9_completa_so_as_linhas_sem_descricao(sem_espera):
    detalhe = _detalhe_por_item({
        480144: [
            _preco("16021105900032024", 1, desc="  Esteira com 12 programas  "),
            _preco("16021105900032024", 2, desc=""),          # o detalhe também não traz: marca sem gravar texto
            _preco("16021105900032024", 9, desc="não pedida"),  # linha que já tem descrição: não é tocada
            # 09018105900012025/7 não volta no detalhe: não é marcada
        ],
        233523: [_preco("15851705900012026", 3, item=233523, desc="Anilha 10 kg")],
    })
    sessao = SessaoFalsa(detalhe=detalhe)
    sb = SupabaseFalso(pendentes=PENDENTES)

    res = compras_precos.completar_detalhes(_cliente(sessao), sb)

    # leitura: só linhas sem descrição (nula ou em branco) e ainda não sincronizadas
    assert len(sb.selecoes) == 1
    tabela, filtros = sb.selecoes[0]
    assert tabela == "precos_praticados_itens"
    assert filtros["or"] == "(descricao_detalhada_item.is.null,descricao_detalhada_item.eq.)"
    assert filtros["detalhe_sincronizado_em"] == "is.null"
    # uma consulta por item de catálogo, com os parâmetros documentados (contract-matrix: codigoItemCatalogo)
    det = [c for c in sessao.chamadas if c[0] == URL_DETALHE]
    assert sorted(c[1]["codigoItemCatalogo"] for c in det) == [233523, 480144]
    assert all(c[1]["pagina"] == 1 and 10 <= c[1]["tamanhoPagina"] <= 100 for c in det)

    feitos = {(f["id_compra"], f["id_item_compra"]): c for _, f, c in sb.updates}
    assert feitos[("eq.16021105900032024", "eq.1")]["descricao_detalhada_item"] == "Esteira com 12 programas"
    assert feitos[("eq.15851705900012026", "eq.3")]["descricao_detalhada_item"] == "Anilha 10 kg"
    assert "descricao_detalhada_item" not in feitos[("eq.16021105900032024", "eq.2")]
    assert all(c.get("detalhe_sincronizado_em") for c in feitos.values())
    assert ("eq.09018105900012025", "eq.7") not in feitos
    assert ("eq.16021105900032024", "eq.9") not in feitos

    assert res["sucesso"] is True
    assert res["linhas_pendentes"] == 4
    assert res["completadas"] == 2
    assert res["sem_descricao_no_detalhe"] == 1
    assert res["nao_encontradas"] == 1
    assert res["falhas"] == 0


def test_ca9_erro_num_item_nao_derruba_a_coleta_e_conta_como_falha(sem_espera):
    sessao = SessaoFalsa(detalhe=_detalhe_por_item({
        480144: 400,
        233523: [_preco("15851705900012026", 3, item=233523, desc="Anilha 10 kg")],
    }))
    sb = SupabaseFalso(pendentes=PENDENTES)

    res = compras_precos.completar_detalhes(_cliente(sessao), sb)

    assert res["sucesso"] is False
    assert res["falhas"] == 3  # as três linhas do item 480144
    assert res["completadas"] == 1
    assert [f["id_item_compra"] for _, f, _ in sb.updates] == ["eq.3"]


def test_ca9_falha_ao_gravar_uma_linha_conta_como_falha(sem_espera):
    sessao = SessaoFalsa(detalhe=_detalhe_por_item({
        480144: [_preco("16021105900032024", 1, desc="A"), _preco("16021105900032024", 2, desc="B"),
                 _preco("09018105900012025", 7, desc="C")],
        233523: [_preco("15851705900012026", 3, item=233523, desc="D")],
    }))
    sb = SupabaseFalso(pendentes=PENDENTES, falhar_update=lambda f: f["id_item_compra"] == "eq.2")

    res = compras_precos.completar_detalhes(_cliente(sessao), sb)

    assert res["sucesso"] is False
    assert res["falhas"] == 1
    assert res["completadas"] == 3


def test_ca9_detalhe_sem_chave_reconhecivel_e_falha_nao_sucesso_silencioso(sem_espera):
    sessao = SessaoFalsa(detalhe=_detalhe_por_item({
        480144: [{"descricaoDetalhadaItem": "sem idCompra nem idItemCompra"}],
        233523: [],
    }))
    sb = SupabaseFalso(pendentes=PENDENTES)

    res = compras_precos.completar_detalhes(_cliente(sessao), sb)

    assert res["sucesso"] is False
    assert res["falhas"] >= 1
    assert sb.updates == []


def test_ca9_sem_pendencia_nao_chama_a_api(sem_espera):
    sessao = SessaoFalsa()
    sb = SupabaseFalso(pendentes=[])

    res = compras_precos.completar_detalhes(_cliente(sessao), sb)

    assert res["sucesso"] is True
    assert res["linhas_pendentes"] == 0
    assert sessao.chamadas == []


def test_ca9_detalhe_respeita_retry_after(sem_espera):
    fila = [_resp(429, headers={"Retry-After": "7"}), _resp(200, {"resultado": [], "totalRegistros": 0})]
    sessao = SessaoFalsa(detalhe=lambda p: fila.pop(0))

    assert _cliente(sessao).consultar_detalhe(480144) == {"resultado": [], "totalRegistros": 0}
    assert sem_espera == [1.0, 7.0, 1.0]


def test_ca9_main_falha_no_detalhe_sai_com_1(monkeypatch, sem_espera):
    sessao = SessaoFalsa(
        material=lambda p: _resp(200, {"resultado": [], "totalRegistros": 0}),
        detalhe=lambda p: _resp(500),
    )
    sb = SupabaseFalso(pdms=[2640], pendentes=PENDENTES[:1])
    _main_com(monkeypatch, sessao, sb)

    assert M.main(["--coleta", "precos"]) == 1
    assert any(c[0] == URL_DETALHE for c in sessao.chamadas)


def test_ca9_main_completa_detalhe_depois_do_1(monkeypatch, sem_espera):
    sessao = SessaoFalsa(detalhe=_detalhe_por_item({480144: [_preco("16021105900032024", 1, desc="X")]}))
    sb = SupabaseFalso(pdms=[2640], pendentes=PENDENTES[:1])
    _main_com(monkeypatch, sessao, sb)

    assert M.main(["--coleta", "precos"]) == 0
    urls = [c[0] for c in sessao.chamadas]
    assert urls.index(URL_DETALHE) > urls.index(URL_MATERIAL)
    assert len(sb.updates) == 1


def test_ca9_supabase_atualizar_onde_filtra_pela_chave_e_conta_linhas(monkeypatch):
    from coletor import destino

    chamadas = []

    def patch(url, params=None, json=None, headers=None, timeout=None):
        chamadas.append((url, params, json, headers, timeout))
        return _resp(200, [{"id_compra": "X", "id_item_compra": 1}])

    monkeypatch.setattr(destino.requests, "patch", patch)
    sb = destino.Supabase("https://exemplo.supabase.co", "chave-de-teste")
    n = sb.atualizar_onde("precos_praticados_itens", {"id_compra": "eq.X", "id_item_compra": "eq.1"},
                          {"detalhe_sincronizado_em": "2026-10-09T00:00:00+00:00"})

    assert n == 1
    url, params, _corpo, headers, timeout = chamadas[0]
    assert url.endswith("/rest/v1/precos_praticados_itens")
    assert params == {"id_compra": "eq.X", "id_item_compra": "eq.1", "select": "id_compra,id_item_compra"}
    assert headers["Prefer"] == "return=representation"
    assert timeout

    with pytest.raises(ValueError):
        sb.atualizar_onde("precos_praticados_itens", {}, {"x": 1})
    monkeypatch.setattr(destino.requests, "patch", lambda *a, **k: _resp(500))
    with pytest.raises(RuntimeError):
        sb.atualizar_onde("precos_praticados_itens", {"id_compra": "eq.X"}, {"x": 1})


def test_ca9_supabase_selecionar_precos_usa_offset_e_order_pedido(monkeypatch):
    """precos_praticados_itens não tem coluna id: a leitura não pode cair no keyset por id."""
    from coletor import destino

    pedidos = []

    def get(url, params=None, headers=None, timeout=None):
        pedidos.append(dict(params))
        r = _resp(200, [])
        r.raise_for_status = lambda: None
        return r

    monkeypatch.setattr(destino.requests, "get", get)
    sb = destino.Supabase("https://exemplo.supabase.co", "chave-de-teste")
    assert sb.selecionar("precos_praticados_itens", order="codigo_item_catalogo.asc,id_compra.asc,id_item_compra.asc",
                         **{"or": compras_precos.FILTRO_SEM_DESCRICAO}) == []
    assert pedidos[0]["order"] == "codigo_item_catalogo.asc,id_compra.asc,id_item_compra.asc"
    assert pedidos[0]["offset"] == "0"
    assert "id" not in pedidos[0]
