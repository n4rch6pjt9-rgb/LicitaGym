"""Ficha do produto a partir da página do fabricante (HTML sintético no formato dos sites reais)."""
from coletor.catalogos import extrair_ficha, specs_da_ficha

TH = """<html><head><meta property="og:title" content="Triceps Press Machine (Máquina Triceps)  - Total Health"/></head>
<body><h1>Triceps Press Machine (Máquina Triceps)</h1><p>Código</p><p>505RRF</p><p>DIMENSÕES</p><p>143 x 116 x 145 cm</p>
<p>PESO</p><p>225 kg</p><p>CARGA</p><p>105 kg</p></body></html>"""

MAC = """<html><head><meta property="og:title" content="Macsport - Equipamentos Profissionais para Academias"/></head>
<body><h1>Flexora Deitada (a partir de 60 KG)</h1><span>Código</span><span>SG-0960</span></body></html>"""

MOV = """<html><head><meta property="og:title" content="Triceps Press New Idea | Movement Fitness"/>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"item":{"name":"Início"}},
{"item":{"name":"Musculação"}},{"item":{"name":"Estações de Musculação"}},{"item":{"name":"Triceps Press New Idea"}}]}</script>
</head><body><p>PESO DO EQUIPAMENTO (kg)</p><p>223,7</p><p>PESO UNITÁRIO DA PLACA (KG)</p><p> 6,8</p>
<p>CARGA INICIAL (KG)</p><p> 5</p><p>CARGA MÁXIMA (KG)</p><p>79,8</p></body></html>"""


def test_total_health_codigo_linha_e_carga():
    f = extrair_ficha(TH, "https://totalhealth.com.br/triceps-press-machine-maquina-triceps", "TOTAL HEALTH")
    assert (f["codigo"], f["linha"]) == ("505RRF", "RRF")
    assert f["carga_maxima_kg"] == 105 and f["peso_equipamento_kg"] == 225
    assert (f["comprimento_cm"], f["largura_cm"], f["altura_cm"]) == (143, 116, 145)
    assert f["no_taxonomia"] == "triceps_maquina"


def test_macsport_titulo_do_h1_linha_da_url_e_carga_fora_do_nome():
    f = extrair_ficha(MAC, "https://macsport.com.br/produto/sigma/flexora-deitada-a-partir-de-60-kg", "MACSPORT")
    assert (f["nome"], f["linha"], f["codigo"], f["carga_maxima_kg"]) == ("Flexora Deitada", "SIGMA", "SG-0960", 60.0)


def test_movement_ficha_new_idea():
    f = extrair_ficha(MOV, "https://www.movement.com.br/produto/triceps-press-new-idea/", "MOVEMENT")
    assert (f["linha"], f["nome"]) == ("NEW IDEA", "Triceps Press")
    assert (f["carga_inicial_kg"], f["carga_maxima_kg"], f["peso_placa_kg"]) == (5, 79.8, 6.8)
    assert f["categorias"] == ["Musculação", "Estações de Musculação"]


def test_spec_nao_confunde_carga_inicial_com_maxima():
    s = specs_da_ficha("CARGA INICIAL (KG)\n5\nCARGA MÁXIMA (KG)\n80")
    assert s == {"carga_inicial_kg": 5, "carga_maxima_kg": 80}
