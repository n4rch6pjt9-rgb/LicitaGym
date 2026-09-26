from coletor.taxonomia import decompor_catmat, decompor_texto, achatar, bloco_da_caracteristica


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
    a = achatar(decompor_texto("ANILHA 25KG – Anilha Emborrachada 25 Kg, em ferro fundido e revestida com PVC; "
                               "diâmetro externo aprox. 380 mm; diâmetro do furo aprox. 33 mm; cor preta"))
    assert a["tipo_produto"] == "acessorio" and a["peso"] == 25 and a["material"] == "FERRO FUNDIDO"
    assert a["revestimento"] == "PVC" and a["cor"] == "PRETA" and "FURO=33 mm" in a["adicionais"]


def test_texto_livre_barra_e_peso_de_carga():
    a = achatar(decompor_texto("BARRA MONTADA RETA 20 KG – comprimento interno 100 cm, diâmetro da pegada 28 mm"))
    assert a["tipo_produto"] == "acessorio" and a["formato"] == "BARRA RETA" and a["peso"] == 20
    s = achatar(decompor_texto("SUPORTE DE BARRA – aço preto, deve suportar barras montadas de até 50kg"))
    assert s["tipo_produto"] == "acessorio" and s["peso"] is None


def test_texto_livre_sextavado_par_decimal():
    a = achatar(decompor_texto("PAR DE DUMBELLS REVESTIDO 14KG – Injetado monobloco 14,0 kg, formato redondo, revestimento PVC"))
    assert a["unidade_fornecimento"] == "PAR" and a["formato"] == "REDONDA" and a["peso"] == 14
    h = achatar(decompor_texto("HALTER EMBORRACHADO 0,5KG"))
    assert h["peso"] == 0.5 and h["material"] is None  # "emborrachado" é revestimento, não material
