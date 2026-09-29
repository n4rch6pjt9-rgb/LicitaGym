"""Gate de marca: fabricante (marca própria) × revenda (N marcas) e referência do edital estruturada."""
from coletor import marcas as M


def L(**k):
    base = {"ranking": "1", "processo": "PE000652022", "item": "5"}
    return {**base, **k}


def test_gate_fabricante_revenda_e_referencia():
    linhas = [
        L(cnpj="06165288000130", empresa="PROMED SERVICOS", tipo_empresa="fabricante", marca="PROMED"),
        L(cnpj="06165288000130", empresa="PROMED SERVICOS", tipo_empresa="fabricante", marca="MOVEMENT", item="6"),
        L(cnpj="08973569000145", empresa="JULIO CESAR GASPARINI JUNIOR", tipo_empresa="fabricante", marca="FLEX EQUIPMENT"),
        L(cnpj="01548177000190", empresa="SPRINT", tipo_empresa="comércio/revenda", marca="PROMED"),
        L(cnpj="01548177000190", empresa="SPRINT", tipo_empresa="comércio/revenda", marca="ARKTUS", item="6"),
        L(cnpj="24473719000108", empresa="MARCOS", tipo_empresa="comércio/revenda", marca="Movement", item="6"),
    ]
    M.enriquecer(linhas)
    promed, promed_mov, julio, sprint, _, marcos = linhas
    assert promed["perfil_comercial"] == "fabricante + revenda" and promed["marca_propria"] == "PROMED"
    assert promed["marca_propria_metodo"] == "nome" and promed["relacao_marca"] == "marca própria"
    assert promed_mov["relacao_marca"] == "revenda"                        # fabricante revendendo MOVEMENT
    assert julio["perfil_comercial"] == "fabricante — marca própria" and julio["marca_propria_metodo"] == "curado"
    assert sprint["perfil_comercial"] == "revenda multimarca" and sprint["relacao_marca"] == "revenda"
    assert marcos["perfil_comercial"] == "revenda monomarca"
    # item 5 do edital: PROMED, LION, TOTAL HEALTH; item 6: LION, MOVEMENT, TOTAL HEALTH
    assert (promed["ref_marca_1"], promed["ref_marca_2"], promed["ref_marca_3"]) == ("PROMED", "LION", "TOTAL HEALTH")
    assert promed["marca_ofertada_na_referencia"] == "SIM" and promed["posicao_na_referencia"] == 1
    assert julio["marca_ofertada_na_referencia"] == "NÃO"
    assert marcos["marca_ofertada_na_referencia"] == "SIM" and marcos["posicao_na_referencia"] == 2
    assert marcos["ref_modelo_2"] == "Cadeira Tríceps" and marcos["ref_linha_2"] == "EDGE"
    fora = M.enriquecer([L(processo="OUTRO", cnpj="1", marca="X")])[0]
    assert fora["marca_ofertada_na_referencia"] == "SEM REFERÊNCIA"


def test_fabricante_curado_flex():
    from coletor.marcas import gate_fornecedores
    linhas = [{"cnpj": "08973569000145", "ranking": 1, "marca": "FLEX", "tipo_empresa": "fabricante",
               "empresa": "JULIO CESAR GASPARINI"},
              {"cnpj": "08973569000145", "ranking": 2, "marca": "LION", "tipo_empresa": "fabricante",
               "empresa": "JULIO CESAR GASPARINI"}]
    g = gate_fornecedores(linhas)["08973569000145"]
    assert g["marca_propria"] == "FLEX EQUIPMENT" and g["marca_propria_metodo"] == "curado"
    assert g["perfil_comercial"] == "fabricante + revenda"


def test_uma_coluna_de_modelo_e_marcas_em_colunas():
    linhas = [L(cnpj="1", empresa="REV", tipo_empresa="comércio/revenda", marca="LION", modelo="08450 Tríceps Paralelo PRO"),
              L(cnpj="1", empresa="REV", tipo_empresa="comércio/revenda", marca="MOVEMENT", modelo="Cadeira Tríceps Edge"),
              L(cnpj="1", empresa="REV", tipo_empresa="comércio/revenda", marca="MOVEMENT", modelo="EDGE+ Flexora")]
    M.enriquecer(linhas)
    a = linhas[0]
    assert (a["modelo"], a["modelo_linha"], a["modelo_codigo"]) == ("Tríceps Paralelo", "PRO", "08450")
    assert a["modelo_original"] == "08450 Tríceps Paralelo PRO" and "modelo_nome" not in a
    assert (a["marca_fornecedor_1"], a["marca_fornecedor_2"], a["marca_fornecedor_3"]) == ("MOVEMENT", "LION", None)
    longo = M.marcas_por_fornecedor(linhas)
    assert [(x["marca"], x["qtd_propostas"]) for x in longo] == [("MOVEMENT", 2), ("LION", 1)]


def test_perfil_e_carga_do_edital():
    assert M.perfil_taxonomia("Musculação — placas (bateria de peso)") == "Musculação"
    assert M.fonte_e_carga("placas (113,5 kg)") == ("placas", 113.5)
    assert M.fonte_e_carga("placas (80–110 kg)") == ("placas", 80.0)
    assert M.fonte_e_carga("anilhas (articulado)") == ("anilhas", None)
    assert M.fonte_e_carga("-") == (None, None)
