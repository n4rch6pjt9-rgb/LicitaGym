"""Testes offline do cadastro de fornecedores (resposta real da BrasilAPI, reduzida, 26/09/2026)."""
from unittest.mock import MagicMock

import pytest

from coletor import fornecedores as F

BRASILAPI_JA = {
    "cnpj": "24608949000137", "razao_social": "J & A E-COMMERCE LTDA", "nome_fantasia": "",
    "descricao_identificador_matriz_filial": "MATRIZ", "descricao_situacao_cadastral": "ATIVA",
    "data_situacao_cadastral": "2016-04-15", "data_inicio_atividade": "2016-04-15",
    "natureza_juridica": "Sociedade Empresária Limitada", "porte": "EMPRESA DE PEQUENO PORTE",
    "opcao_pelo_simples": True, "opcao_pelo_mei": False, "capital_social": 120000,
    "cnae_fiscal": 4789099, "cnae_fiscal_descricao": "Comércio varejista de outros produtos não especificados",
    "cnaes_secundarios": [{"codigo": 4763602, "descricao": "Comércio varejista de artigos esportivos"}],
    "uf": "BA", "municipio": "SALVADOR", "codigo_municipio_ibge": 2927408, "cep": "41194115",
    "descricao_tipo_de_logradouro": "RUA", "logradouro": "CLEDENOR SOARES", "numero": "04", "complemento": "",
    "bairro": "DORON", "email": None, "ddd_telefone_1": "7133333333", "ddd_telefone_2": "",
    "qsa": [{"nome_socio": "PESSOA FISICA", "cnpj_cpf_do_socio": "***575605**"}],
}


def test_cnpj_valido():
    assert F.cnpj_valido("24.608.949/0001-37") == "24608949000137"
    assert F.cnpj_valido("24.608.949/0001-38") is None
    assert F.cnpj_valido("11111111111111") is None
    assert F.cnpj_valido("123") is None


def test_linha_sem_qsa_e_com_cnae_fitness():
    l = F.linha_fornecedor("24608949000137", BRASILAPI_JA, "brasilapi")
    assert l["razao_social"] == "J & A E-COMMERCE LTDA" and l["porte"] == "EMPRESA DE PEQUENO PORTE"
    assert l["uf"] == "BA" and l["cnae_principal"] == 4789099 and l["cnae_fitness"] is True
    assert l["nome_fantasia"] is None and l["complemento"] is None and l["telefones"] == ["7133333333"]
    assert "qsa" not in l["raw"] and "PESSOA FISICA" not in str(l)  # LGPD: sócio PF não é gravado
    assert l["consulta_status"] == "ok" and l["cnpj_raiz"] == "24608949"


def _consulta(respostas):
    s = MagicMock()
    s.headers = {}
    s.get.side_effect = respostas
    return F.ConsultaCNPJ(delay=0, sessao=s), s


def _r(code, body=None):
    m = MagicMock(status_code=code)
    m.json.return_value = body
    return m


def test_fallback_de_provedor_e_nao_encontrado(monkeypatch):
    monkeypatch.setattr(F.time, "sleep", lambda *_: None)
    c, s = _consulta([_r(500), _r(500), _r(500), _r(200, BRASILAPI_JA)])
    dados, prov, st = c.consultar("24608949000137")
    assert prov == "minhareceita" and st == "ok"
    c, _ = _consulta([_r(404)])
    assert c.consultar("24608949000137") == (None, "brasilapi", "nao_encontrado")


def test_erro_em_todos_os_provedores_nao_vira_vazio(monkeypatch):
    monkeypatch.setattr(F.time, "sleep", lambda *_: None)
    c, _ = _consulta([_r(503)] * 6)
    with pytest.raises(RuntimeError):
        c.consultar("24608949000137")
    cad = F.CadastroFornecedores(sb=None, consulta=c, dry_run=True)
    c.s.get.side_effect = [_r(503)] * 6
    r = cad.cadastrar(["24.608.949/0001-37"])
    assert r["erros"] == 1 and r["consultados"] == 0 and r["linhas"] == []


def test_cadastrar_dedup_cache_e_upsert():
    consulta = MagicMock()
    consulta.consultar.return_value = (BRASILAPI_JA, "brasilapi", "ok")
    sb = MagicMock()
    sb.selecionar.return_value = [{"cnpj": "06165288000130"}]  # já consultado há menos de 30 dias
    cad = F.CadastroFornecedores(sb=sb, consulta=consulta)
    r = cad.cadastrar(["24.608.949/0001-37", "24608949000137", "06.165.288/0001-30", "999"])
    assert r["recebidos"] == 4 and r["invalidos"] == 1 and r["em_cache"] == 1 and r["consultados"] == 1
    consulta.consultar.assert_called_once_with("24608949000137")
    tabela, linha, conflito = sb.upsert.call_args.args
    assert tabela == "fornecedores" and conflito == "cnpj" and linha["cnpj"] == "24608949000137"
    cad.cadastrar(["24608949000137"])                     # mesma execução: não consulta de novo
    assert consulta.consultar.call_count == 1


def test_mei_mascara_cpf_e_nao_guarda_contato():
    mei = dict(BRASILAPI_JA, cnpj="32068708000170", razao_social="GABRIEL MOTA LIMA 00982645325",
               natureza_juridica="Empresário (Individual)", codigo_natureza_juridica=2135, opcao_pelo_mei=True,
               email="pessoa@exemplo.com")
    l = F.linha_fornecedor("32068708000170", mei, "brasilapi")
    assert l["razao_social"] == "GABRIEL MOTA LIMA ***826453**"
    assert "00982645325" not in str(l)
    assert l["titular_pessoa_fisica"] is True
    assert l["email"] is None and l["telefones"] == [] and l["logradouro"] is None and l["numero"] is None
    assert l["uf"] == "BA" and l["cnpj"] == "32068708000170"      # CNPJ não é mascarado
    pj = F.linha_fornecedor("24608949000137", BRASILAPI_JA, "brasilapi")
    assert pj["titular_pessoa_fisica"] is False and pj["telefones"] == ["7133333333"]


def test_cnpjs_de_precos_le_por_offset_na_pk_e_deduplica():
    sb = MagicMock()
    sb.selecionar.return_value = [{"ni_fornecedor": "24608949000137"}, {"ni_fornecedor": "06165288000130"},
                                  {"ni_fornecedor": "24608949000137"}]
    assert F.cnpjs_de_precos(sb) == ["06165288000130", "24608949000137"]
    tabela = sb.selecionar.call_args.args[0]
    kw = sb.selecionar.call_args.kwargs
    assert tabela == "precos_praticados_itens"
    assert kw["select"] == "ni_fornecedor" and kw["ni_fornecedor"] == "not.is.null"
    assert kw["order"] == "id_compra.asc,id_item_compra.asc"


def test_main_de_precos_junta_os_vencedores(monkeypatch):
    sb = MagicMock()
    monkeypatch.setattr(F, "cnpjs_de_precos", lambda _sb: ["24608949000137", "ESTRANGEIRO"])
    import coletor.destino as D
    monkeypatch.setattr(D, "Supabase", lambda *_a, **_k: sb)
    monkeypatch.setattr(D, "env", lambda *_a, **_k: "x")
    recebidos = []
    monkeypatch.setattr(F.CadastroFornecedores, "cadastrar",
                        lambda self, cnpjs: recebidos.extend(cnpjs) or {"erros": 0, "consultados": 0, "linhas": []})
    assert F.main(["--de-precos", "--dry-run"]) == 0
    assert recebidos == ["24608949000137", "ESTRANGEIRO"]


def test_main_limite_corta_a_lista(monkeypatch):
    monkeypatch.setattr(F, "cnpjs_de_precos", lambda _sb: ["24608949000137", "06165288000130", "11222333000181"])
    import coletor.destino as D
    monkeypatch.setattr(D, "Supabase", lambda *_a, **_k: MagicMock())
    monkeypatch.setattr(D, "env", lambda *_a, **_k: "x")
    recebidos = []
    monkeypatch.setattr(F.CadastroFornecedores, "cadastrar",
                        lambda self, cnpjs: recebidos.extend(cnpjs) or {"erros": 0, "consultados": 0, "linhas": []})
    assert F.main(["--de-precos", "--limite", "2", "--dry-run"]) == 0
    assert recebidos == ["24608949000137", "06165288000130"]
