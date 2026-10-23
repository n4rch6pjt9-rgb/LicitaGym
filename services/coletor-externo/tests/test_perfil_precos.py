"""Spec 0037, fase 0: rotulador de "fora do perfil" (só dry-run). Modelo falso; nenhum acesso ao Vertex."""
from __future__ import annotations

import json
from datetime import date
from unittest.mock import MagicMock

import pytest

from coletor import perfil_precos as P
from coletor import main as M

HOJE = date(2026, 10, 22)
ANCORA = "93099205000052026"


def linha(id_compra, id_item, numero, preco, pdm="7115", **kw):
    base = {
        "id_compra": id_compra, "id_item_compra": id_item, "numero_item_compra": numero, "codigo_pdm": pdm,
        "nome_pdm": "ESTEIRA ERGOMÉTRICA", "codigo_item_catalogo": 486803,
        "descricao_item": "ESTEIRA ELÉTRICA, CAPACIDADE MÁXIMA: 120 KG, VELOCIDADE MÁXIMA: 20 KM/H",
        "descricao_detalhada_item": None, "marca": "TCMAQ", "fabricante": None, "modelo": "ESTEIRA 6M",
        "sigla_unidade_fornecimento": "UN", "preco_unitario": preco, "data_resultado": "2026-09-18",
        "objeto_compra": "Registro de Preços para aquisição de máquinas, implementos e tratores para as Centrais "
                         "Municipais de Resíduos do Consórcio Público de Manejo dos Resíduos Sólidos",
        "nome_uasg": "ECE-CONSÓRCIO PUB.M.RES.SOL.S.I.DE S.BENEDITO", "nome_orgao": None,
        # O fornecedor nunca deve chegar ao prompt, mesmo que venha na linha (CA-7).
        "nome_fornecedor": "NOME CIVIL FICTICIO", "ni_fornecedor": "12345678901",
    }
    base.update(kw)
    return base


def base_fake():
    academia = [linha(f"1000000000000000{i}", 100 + i, 1, 10000 + i * 1000, marca="MOVEMENT", modelo="LX 160",
                      objeto_compra="Aquisição de equipamentos para academia", nome_uasg="25º BPM/M")
                for i in range(5)]
    outro_pdm = [linha("20000000000000001", 300, 1, 150.0, pdm="2640", nome_pdm="BICICLETA ERGOMÉTRICA",
                       objeto_compra="Aquisição de material esportivo")]
    return academia + outro_pdm + [linha(ANCORA, 10, 10, 39000.0), linha(ANCORA, 11, 11, 52000.0)]


def sb_fake(linhas):
    sb = MagicMock()
    sb.selecionar.return_value = linhas
    return sb


def modelo_fake(rotulo_por_compra=None, resposta=None):
    chamadas = []

    def chamar(prompt):
        chamadas.append(prompt)
        if resposta is not None:
            return resposta, {"entrada": 1000, "saida": 50, "pensamento": 10}
        entrada = json.loads(prompt.split("Compra:\n", 1)[1])
        rot = (rotulo_por_compra or {}).get(entrada["id_compra"], "no_perfil")
        itens = [{"id": i["id"], "rotulo": rot, "motivo": "objeto fala de resíduos; modelo ESTEIRA 6M",
                  "sinais": ["objeto", "marca"]} for i in entrada["itens"]]
        return json.dumps({"itens": itens}), {"entrada": 1000, "saida": 50, "pensamento": 10}

    chamar.chamadas = chamadas
    return chamar


def test_ca3_ancora_fora_do_perfil_numa_chamada_por_compra():
    modelo = modelo_fake({ANCORA: "fora_do_perfil"})
    res = P.executar(sb_fake(base_fake()), modelo, dry_run=True, compras=[ANCORA], hoje=HOJE)
    assert res["sucesso"] is True
    assert res["rotulos"]["fora_do_perfil"] == 2 and res["itens"] == 2
    assert len(modelo.chamadas) == 1           # uma chamada para a compra, com os dois itens
    entrada = json.loads(modelo.chamadas[0].split("Compra:\n", 1)[1])
    assert [i["id"] for i in entrada["itens"]] == [10, 11]
    # mediana do PDM 7115 + UN nos 12 meses (5 de academia + 2 da âncora) chega ao prompt como sinal
    assert entrada["itens"][0]["mediana_pdm_unidade_12m"] == {"valor": 13000.0, "n": 7}
    # a regra de escopo não reconhece o objeto de resíduos, mas reconhece a esteira no texto do item
    assert entrada["regra_escopo_objeto"] is None
    assert entrada["itens"][0]["regra_escopo_item"] == "forte"


def test_ca7_prompt_sem_fornecedor():
    modelo = modelo_fake()
    P.executar(sb_fake(base_fake()), modelo, dry_run=True, compras=[ANCORA], hoje=HOJE)
    prompt = modelo.chamadas[0]
    assert "NOME CIVIL FICTICIO" not in prompt and "12345678901" not in prompt
    assert "fornecedor" not in P.COLUNAS


def test_ca5_json_invalido_em_todas_as_tentativas_conta_erro_sem_inventar_rotulo(monkeypatch):
    monkeypatch.setattr(P, "TENTATIVAS_JSON", 3)
    modelo = modelo_fake(resposta="isto não é json")
    res = P.executar(sb_fake(base_fake()), modelo, dry_run=True, compras=[ANCORA], hoje=HOJE)
    assert res["sucesso"] is False and res["erros"] == 1
    assert res["itens"] == 0 and sum(res["rotulos"].values()) == 0
    assert len(modelo.chamadas) == 3


@pytest.mark.parametrize("resposta", [
    {"itens": [{"id": 10, "rotulo": "talvez", "motivo": "x", "sinais": []}, {"id": 11, "rotulo": "no_perfil", "motivo": "x"}]},
    {"itens": [{"id": 10, "rotulo": "no_perfil", "motivo": " ", "sinais": []}, {"id": 11, "rotulo": "no_perfil", "motivo": "x"}]},
    {"itens": [{"id": 10, "rotulo": "no_perfil", "motivo": "x", "sinais": ["cor"]}, {"id": 11, "rotulo": "no_perfil", "motivo": "x"}]},
    {"itens": [{"id": 10, "rotulo": "no_perfil", "motivo": "x"}]},   # item 11 sem resposta
    {"rotulos": []},
])
def test_resposta_fora_do_contrato_e_invalida(resposta):
    with pytest.raises(P.RespostaInvalida):
        P.validar_resposta(json.dumps(resposta), {10, 11})


def test_ca5_id_que_nao_estava_na_entrada_e_descartado():
    texto = json.dumps({"itens": [{"id": 10, "rotulo": "no_perfil", "motivo": "ok", "sinais": ["descricao"]},
                                  {"id": 11, "rotulo": "incerto", "motivo": "pouco dado", "sinais": []},
                                  {"id": 999, "rotulo": "fora_do_perfil", "motivo": "x", "sinais": []}]})
    rotulos, descartados = P.validar_resposta(texto, {10, 11})
    assert set(rotulos) == {10, 11} and descartados == [999]


def test_ca4_hash_muda_com_a_entrada_e_com_a_versao_do_prompt(monkeypatch):
    por = P.agrupar_por_compra(base_fake())
    meds = P.medianas(base_fake(), HOJE)
    e1 = P.montar_entrada(por[ANCORA], meds)
    assert P.hash_entrada(e1) == P.hash_entrada(P.montar_entrada(por[ANCORA], meds))
    por[ANCORA][0]["marca"] = "LIPPEL"
    assert P.hash_entrada(P.montar_entrada(por[ANCORA], meds)) != P.hash_entrada(e1)
    h_antes = P.hash_entrada(e1)
    monkeypatch.setattr(P, "VERSAO_PROMPT", "0037.99")
    assert P.hash_entrada(e1) != h_antes


def test_ca8_dry_run_resume_tokens_e_projeta_a_base_por_item(monkeypatch):
    monkeypatch.setenv("PRECO_ENTRADA_USD_MTOK", "0.5")
    monkeypatch.setenv("PRECO_SAIDA_USD_MTOK", "3")
    sb = sb_fake(base_fake())
    res = P.executar(sb, modelo_fake(), dry_run=True, limite=2, hoje=HOJE)
    # a âncora entra sempre na amostra (2 itens) + 1 compra de outro PDM (1 item)
    assert res["compras_rotuladas"] == 2 and res["itens"] == 3 and res["chamadas"] == 2
    assert res["recorte"] == "base"
    assert res["tokens"]["por_chamada"] == {"entrada": 1000, "saida": 50, "pensamento": 10}
    proj = res["projecao_base"]
    # 2.120 tokens válidos / 3 itens = 707 por item; 8 itens na base
    assert proj["itens_na_base"] == 8 and proj["compras_na_base"] == 7 and proj["tokens_por_item"] == 707
    total = round(2120 / 3 * 8)
    assert proj["tokens_entrada"] + proj["tokens_saida_mais_pensamento"] == total
    assert proj["custo_usd"] == round(proj["tokens_entrada"] / 1e6 * 0.5 + proj["tokens_saida_mais_pensamento"] / 1e6 * 3, 2)
    # só leitura: uma consulta, ordenada pela PK inteira (offset estável), sem filtro de compra
    assert sb.selecionar.call_count == 1
    tabela, filtros = sb.selecionar.call_args.args[0], sb.selecionar.call_args.kwargs
    assert tabela == "precos_praticados_itens" and "id_compra" not in filtros and filtros["preco_unitario"] == "gt.0"
    assert filtros["order"] == "id_compra.asc,id_item_compra.asc"


def test_sem_projecao_fora_do_recorte_base():
    res = P.executar(sb_fake(base_fake()), modelo_fake(), dry_run=True, compras=[ANCORA], hoje=HOJE)
    assert res["recorte"] == "compras" and res["projecao_base"] is None


def test_compra_pedida_que_nao_existe_e_falha():
    res = P.executar(sb_fake(base_fake()), modelo_fake(), dry_run=True, compras=["99999999999999999"], hoje=HOJE)
    assert res["sucesso"] is False and res["compras_nao_encontradas"] == ["99999999999999999"]


def test_compra_grande_vai_em_lotes_com_o_contexto(monkeypatch):
    monkeypatch.setattr(P, "ITENS_POR_CHAMADA", 2)
    grande = [linha(ANCORA, 10 + k, 10 + k, 39000.0) for k in range(5)]
    modelo = modelo_fake({ANCORA: "fora_do_perfil"})
    res = P.executar(sb_fake(grande), modelo, dry_run=True, compras=[ANCORA], hoje=HOJE)
    assert res["itens"] == 5 and res["rotulos"]["fora_do_perfil"] == 5
    assert len(modelo.chamadas) == 3
    for prompt in modelo.chamadas:
        entrada = json.loads(prompt.split("Compra:\n", 1)[1])
        assert "Resíduos" in entrada["objeto"] and len(entrada["itens"]) <= 2


def test_resposta_cortada_nao_repete_e_conta_erro():
    chamadas = []

    def cortado(prompt):
        chamadas.append(prompt)
        return '{"itens": [{"id": 10, "rot', {"entrada": 900, "saida": 8000, "pensamento": 0, "cortada": True}

    res = P.executar(sb_fake(base_fake()), cortado, dry_run=True, compras=[ANCORA], hoje=HOJE)
    assert len(chamadas) == 1 and res["erros"] == 1 and res["sucesso"] is False
    assert res["chamadas_perdidas"] == 1 and res["tokens"]["perdidos"] == 8900


def test_ca7_cpf_e_cnpj_no_texto_livre_viram_doc():
    l = linha(ANCORA, 10, 10, 39000.0, marca="59.126.048 FULANA 123.456.789-01",
              descricao_detalhada_item="fornecido por 12.345.678/0001-90")
    entrada = P.montar_entrada([l], {})
    texto = json.dumps(entrada, ensure_ascii=False)
    assert "123.456.789-01" not in texto and "12.345.678/0001-90" not in texto and "[doc]" in texto


def test_id_repetido_na_resposta_e_invalido():
    texto = json.dumps({"itens": [{"id": 10, "rotulo": "no_perfil", "motivo": "a", "sinais": []},
                                  {"id": 10, "rotulo": "fora_do_perfil", "motivo": "b", "sinais": []}]})
    with pytest.raises(P.RespostaInvalida):
        P.validar_resposta(texto, {10})


def test_sem_dry_run_nao_grava_nada():
    with pytest.raises(NotImplementedError):
        P.executar(sb_fake(base_fake()), modelo_fake(), dry_run=False, hoje=HOJE)


def test_amostra_estratificada_cobre_os_pdms_e_e_estavel():
    por = P.agrupar_por_compra(base_fake())
    a1 = P.amostra_estratificada(por, 3, fixas=[ANCORA])
    assert a1[0] == ANCORA
    assert {str(por[c][0]["codigo_pdm"]) for c in a1} == {"7115", "2640"}
    assert a1 == P.amostra_estratificada(por, 3, fixas=[ANCORA])


def test_so_leitura_bloqueia_escrita():
    sl = P.SoLeitura(MagicMock())
    sl.selecionar("precos_praticados_itens")
    with pytest.raises(PermissionError):
        sl.upsert("precos_rotulo_perfil", [])


def test_main_perfil_precos_como_o_gcloud_manda(monkeypatch):
    chamadas = []
    monkeypatch.setattr(M, "coletar_perfil_precos", lambda args: chamadas.append(
        (args.dry_run, args.limite, args.compras, args.pdms)) or True)
    assert M.main("--coleta,perfil-precos,--dry-run,--limite,50".split(",")) == 0
    assert M.main(["--coleta", "perfil-precos", "--dry-run", "--compras", ANCORA]) == 0
    assert chamadas == [(True, 50, None, None), (True, None, [ANCORA], None)]


@pytest.mark.parametrize("argv", [
    ["--coleta", "precos", "--compras", ANCORA],
    ["--coleta", "precos", "--limite", "5"],
    ["--coleta", "precos", "--limite=5"],
    ["--coleta", "perfil-precos", "--compras", "123"],
    ["--coleta", "perfil-precos", "--limite", "0"],
    ["--coleta", "sestsenat", "--pdms", "7115"],
])
def test_main_argumentos_invalidos(monkeypatch, argv):
    monkeypatch.setattr(M, "coletar_perfil_precos", lambda args: pytest.fail("não devia rodar"))
    with pytest.raises(SystemExit) as exc:
        M.main(argv + ["--dry-run"])
    assert exc.value.code == 2


def test_main_perfil_precos_sem_dry_run_falha_sem_tocar_no_banco(monkeypatch):
    monkeypatch.setattr(M, "Supabase", lambda *a, **k: pytest.fail("não devia conectar"))
    assert M.main(["--coleta", "perfil-precos"]) == 1


def test_pdm_que_so_aparece_no_segundo_item_tambem_entra_na_amostra():
    linhas = [linha(f"3000000000000{i:04d}", i, 1, 100.0, pdm="A") for i in range(100)]
    linhas.append(linha("30000000000000001", 999, 2, 50.0, pdm="B"))   # compra 1 tem A no 1º item e B no 2º
    por = P.agrupar_por_compra(linhas)
    amostra = P.amostra_estratificada(por, 5)
    pdms = set().union(*({str(l["codigo_pdm"]) for l in por[c]} for c in amostra))
    assert pdms == {"A", "B"} and len(amostra) == len(set(amostra)) == 5


def test_tokens_da_compra_descartada_saem_da_projecao(monkeypatch):
    monkeypatch.setattr(P, "ITENS_POR_CHAMADA", 15)
    monkeypatch.setattr(P, "TENTATIVAS_JSON", 1)
    grande = [linha("40000000000000001", 100 + k, k, 100.0) for k in range(16)]   # 2 lotes: 15 + 1
    pequena = [linha("40000000000000002", 500, 1, 100.0)]

    def modelo(prompt):
        entrada = json.loads(prompt.split("Compra:\n", 1)[1])
        if entrada["id_compra"] == "40000000000000001" and len(entrada["itens"]) == 1:
            return "quebrado", {"entrada": 100, "saida": 0, "pensamento": 0}   # 2º lote da compra grande falha
        itens = [{"id": i["id"], "rotulo": "no_perfil", "motivo": "ok", "sinais": []} for i in entrada["itens"]]
        return json.dumps({"itens": itens}), {"entrada": 100, "saida": 0, "pensamento": 0}

    res = P.executar(sb_fake(grande + pequena), modelo, dry_run=True, limite=2, hoje=HOJE)
    assert res["erros"] == 1 and res["itens"] == 1
    assert res["tokens"]["perdidos"] == 200            # os 2 lotes da compra descartada
    assert res["projecao_base"]["tokens_por_item"] == 100


def test_falha_do_vertex_numa_compra_nao_derruba_a_rodada():
    def modelo(prompt):
        entrada = json.loads(prompt.split("Compra:\n", 1)[1])
        if entrada["id_compra"] == ANCORA:
            raise RuntimeError("500 INTERNAL. Internal error encountered.")
        itens = [{"id": i["id"], "rotulo": "no_perfil", "motivo": "ok", "sinais": []} for i in entrada["itens"]]
        return json.dumps({"itens": itens}), {"entrada": 10, "saida": 1, "pensamento": 0}

    res = P.executar(sb_fake(base_fake()), modelo, dry_run=True, limite=3, hoje=HOJE)
    assert res["erros"] == 1 and res["compras_rotuladas"] == 2 and res["sucesso"] is False


def test_muitas_falhas_seguidas_param_a_rodada(monkeypatch):
    monkeypatch.setattr(P, "MAX_FALHAS_SEGUIDAS", 2)
    chamadas = []

    def modelo(prompt):
        chamadas.append(1)
        raise RuntimeError("500 INTERNAL")

    res = P.executar(sb_fake(base_fake()), modelo, dry_run=True, limite=5, hoje=HOJE)
    assert res["erros"] == 2 and len(chamadas) == 2
