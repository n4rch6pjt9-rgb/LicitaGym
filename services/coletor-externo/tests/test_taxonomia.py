from coletor.taxonomia import (
    achatar,
    bloco_da_caracteristica,
    calcular_taxonomia,
    decompor_catmat,
    decompor_texto,
)


def test_bloco_da_caracteristica():
    assert bloco_da_caracteristica("COR BARRA") == "cor"
    assert bloco_da_caracteristica("FORMA") == "formato"
    assert bloco_da_caracteristica("FORMA FORNECIMENTO") == "unidade"
    assert bloco_da_caracteristica("PESO") == "peso"
    assert bloco_da_caracteristica("PESO IMERSÃO ÁGUA") == "adicionais"
    assert bloco_da_caracteristica("MATERIAL ANILHAS") == "caracteristica"
    assert bloco_da_caracteristica("DIÂMETRO BARRA") == "adicionais"


def test_catmat_estruturado():
    a = achatar(decompor_catmat([["MATERIAL", "FERRO", None], ["PESO", "20,4", "KG"], ["COR", "AZUL", None],
                                 ["FORMA", "BOLAS NAS LATERAIS", None], ["COLUNA PESO", "36,6", "KG"]],
                                ["P|PAR|0|", "UN|UNIDADE|0|"]))
    assert a["peso"] == 20.4 and a["cor"] == "AZUL" and a["formato"] == "BOLAS NAS LATERAIS"
    assert a["unidade_fornecimento"] == "PAR, UNIDADE" and "COLUNA PESO" in a["adicionais"]


def test_texto_livre_anilha():
    texto = ("ANILHA 25KG – Anilha Emborrachada 25 Kg, em ferro fundido e revestida com PVC; "
             "diâmetro externo aprox. 380 mm; diâmetro do furo aprox. 33 mm; cor preta")
    a = achatar(decompor_texto(texto))
    assert a["tipo_produto"] == "acessorio" and a["peso"] == 25 and a["material"] == "FERRO FUNDIDO"
    assert a["revestimento"] == "PVC" and a["cor"] == "PRETA" and "FURO=33 mm" in a["adicionais"]
    tax = calcular_taxonomia(texto)
    assert tax["plano"]["tipo_produto"] == "acessorio"
    assert tax["no_taxonomia"] == "anilha"
    assert tax["metodo"] == "regra"


def test_texto_livre_barra_e_peso_de_carga():
    a = achatar(decompor_texto("BARRA MONTADA RETA 20 KG – comprimento interno 100 cm, diâmetro da pegada 28 mm"))
    assert a["tipo_produto"] == "acessorio" and a["formato"] == "BARRA RETA" and a["peso"] == 20
    tax = calcular_taxonomia("BARRA MONTADA RETA 20 KG – comprimento interno 100 cm, diâmetro da pegada 28 mm")
    assert tax["no_taxonomia"] == "barra_livre"
    s = achatar(decompor_texto("SUPORTE DE BARRA – aço preto, deve suportar barras montadas de até 50kg"))
    assert s["tipo_produto"] == "acessorio" and s["peso"] is None


def test_texto_livre_sextavado_par_decimal():
    a = achatar(decompor_texto("PAR DE DUMBELLS REVESTIDO 14KG – Injetado monobloco 14,0 kg, formato redondo, revestimento PVC"))
    assert a["unidade_fornecimento"] == "PAR" and a["formato"] == "REDONDA" and a["peso"] == 14
    assert a["tipo_produto"] == "acessorio"
    h = achatar(decompor_texto("HALTER EMBORRACHADO 0,5KG"))
    assert h["peso"] == 0.5 and h["material"] is None  # "emborrachado" é revestimento, não material
    tax = calcular_taxonomia("HALTER EMBORRACHADO 0,5KG")
    assert tax["no_taxonomia"] == "haltere"


def test_acessorio_step_e_colchonete():
    step = calcular_taxonomia("Step profissional ajustável para aeróbico")
    assert step["plano"]["tipo_produto"] == "acessorio"
    assert step["no_taxonomia"] == "step"
    col = calcular_taxonomia("Colchonete de exercícios em espuma, 1,80m")
    assert col["plano"]["tipo_produto"] == "acessorio"
    assert col["no_taxonomia"] == "colchonete"
    assert col["aparelho"]["escopo"] == "OUT"

def test_aparelho_extensora_alta_confianca():
    tax = calcular_taxonomia(
        "Aparelho de musculação cadeira extensora com sistema de carga por placas, uso profissional"
    )
    assert tax["plano"]["tipo_produto"] == "aparelho_ou_fora"
    assert tax["no_taxonomia"] == "cadeira_extensora"
    assert tax["metodo"] == "regra"
    assert tax["confianca"] == "alta"
    assert tax["versao_taxonomia"] == "0.3"
    assert tax["plano"]["no_taxonomia"] == "cadeira_extensora"
    assert tax["aparelho"]["escopo"] == "IN"


def test_aparelho_tipo_catmat_esteira():
    tax = calcular_taxonomia(
        "Aparelho de academia TIPO: ELÉTRICA, manta 33 cm",
        tipo_catmat="ELÉTRICA",
        codigo_pdm=2640,
    )
    assert tax["no_taxonomia"] == "esteira_eletrica"
    assert tax["confianca"] == "alta"
    assert tax["aparelho"]["termo"] == "TIPO:ELÉTRICA"


def test_aparelho_codigo_item_vence_tipo():
    # 250339 é stepper mesmo com TIPO ELÉTRICA no PDM 2640
    tax = calcular_taxonomia(
        "Aparelho TIPO: ELÉTRICA",
        tipo_catmat="ELÉTRICA",
        codigo_pdm=2640,
        codigo_item=250339,
    )
    assert tax["no_taxonomia"] == "simulador_escada"
    assert tax["aparelho"]["termo"] == "ITEM:250339"


def test_aparelho_ape_vira_ar_livre_out():
    tax = calcular_taxonomia("Aparelho de musculação supino APE para academia ao ar livre terceira idade")
    assert tax["plano"]["tipo_produto"] == "aparelho_ou_fora"
    assert tax["no_taxonomia"] == "academia_ar_livre"
    assert tax["aparelho"]["escopo"] == "OUT"


def test_aparelho_ambiguo_baixa():
    tax = calcular_taxonomia("Aparelho estofado TIPO: flexora")
    assert tax["plano"]["tipo_produto"] == "aparelho_ou_fora"
    assert tax["no_taxonomia"] is None
    assert tax["confianca"] == "baixa"
    assert tax["metodo"] == "regra"
    assert "cadeira_flexora" in tax["aparelho"]["candidatos"] or tax["aparelho"]["candidatos"]
