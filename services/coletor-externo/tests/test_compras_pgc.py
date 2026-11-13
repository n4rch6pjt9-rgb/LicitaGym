"""Spec specs/0057-pgc-no-radar-pca.md: coletor PGC no Job (K-1), CA-1 e CA-2.

A API real não é chamada: a sessão HTTP e o Supabase são falsos.
"""
from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import pytest

from coletor import compras_pgc
from coletor import main as coletor_main


def _item(**kw):
    base = {
        "codigoUasg": "158886",
        "nomeUasg": "IFES - CAMPUS EXEMPLO",
        "orgao": "10838653000106",
        "numeroArtefato": 25,
        "anoArtefato": 2026,
        "descricaoArtefato": "25/2026",
        "ordemDfd": 1,
        "descricaoObjetoDfd": "Piso sintético",
        "codigoClasseMaterial": 7220,
        "nomeClasseMaterial": "REVESTIMENTOS PARA PISOS",
        "codigoPdmMaterial": 10779,
        "nomePdmMaterial": "PISO SINTÉTICO",
        "codigoItemCatalogo": "458179",
        "descricaoItemCatalogo": "PISO SINTÉTICO, MATERIAL: LINÓLEO",
        "siglaUnidadeFornecimento": "M2",
        "quantidadeItem": 20.0,
        "valorUnitarioItem": 41.0,
        "valorTotalItem": 820.0,
        "tituloProjetoCompra": "Aquisição de Piso Sintético",
        "anoPcaProjetoCompra": 2026,
        "numeroItemPncp": 136,
        "statusContratacaoExecucao": 11,
        "dataHoraAtualizacaoArtefato": "2026-05-09T10:11:00",
        "dataHoraAtualizacaoItem": "2026-05-09T10:08:00",
    }
    base.update(kw)
    return base


class _Cliente:
    """Cliente PGC falso: devolve uma página por (classe, ano) e registra as consultas."""

    def __init__(self, paginas):
        self.paginas = paginas
        self.consultas = []

    def consultar_classe(self, classe, ano, pagina=1, tamanho_pagina=100):
        self.consultas.append((classe, ano, pagina))
        return self.paginas.get((classe, ano, pagina), {"resultado": [], "totalRegistros": 0, "totalPaginas": 0})


def test_ca1_deduplica_chave_repetida_antes_do_upsert():
    """CA-1: 3 linhas com a mesma chave + 1 única → 2 linhas no upsert; fica a de artefato mais novo."""
    velha = _item(dataHoraAtualizacaoItem="2026-05-09T10:08:00", statusContratacaoExecucao=1)
    nova = _item(dataHoraAtualizacaoItem="2026-06-12T09:00:00", dataHoraAtualizacaoArtefato="2026-06-01T08:00:00",
                 statusContratacaoExecucao=4)
    nova_artefato_mais_novo = _item(dataHoraAtualizacaoItem="2026-06-12T09:00:00",
                                    dataHoraAtualizacaoArtefato="2026-06-20T08:00:00", statusContratacaoExecucao=11)
    unica = _item(numeroItemPncp=137, codigoItemCatalogo="458180")
    pagina = [velha, nova_artefato_mais_novo, nova, unica]
    cliente = _Cliente({(7220, 2026, 1): {"resultado": pagina, "totalRegistros": 4, "totalPaginas": 1}})
    sb = MagicMock()

    res = compras_pgc.coletar(cliente, sb, classes=[7220], anos=[2026])

    assert sb.upsert.call_count == 1
    linhas = sb.upsert.call_args[0][1]
    assert len(linhas) == 2
    chave = {(l["numero_item_pncp"], l["codigo_item_catalogo"]): l for l in linhas}
    escolhida = chave[(136, 458179)]
    assert escolhida["status_contratacao_execucao"] == "11"
    assert res["total_gravados"] == 2
    assert res["repetidos_descartados"] == 2
    assert res["sucesso"] is True


def test_ca1_status_e_guardado_como_texto_bruto():
    """CA-1 (P-2): o status é código opaco, gravado como texto, nunca convertido em booleano."""
    norm = compras_pgc.normalizar_registro_pgc(_item(statusContratacaoExecucao=21))
    assert norm["status_contratacao_execucao"] == "21"
    assert compras_pgc.normalizar_registro_pgc(_item(statusContratacaoExecucao=None))["status_contratacao_execucao"] is None


class _Resp:
    def __init__(self, status, corpo):
        self.status_code = status
        self._corpo = corpo
        self.headers = {}
        self.text = str(corpo)
        self.content = self.text.encode()

    def json(self):
        return self._corpo

    def raise_for_status(self):
        import requests
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)


class _Sessao:
    def __init__(self, falhar_classe=None):
        self.headers = {}
        self.chamadas = []
        self.falhar_classe = falhar_classe

    def get(self, url, params=None, timeout=None):
        self.chamadas.append(dict(params))
        if params["codigo"] == self.falhar_classe:
            return _Resp(400, {"title": "Parâmetro inválido", "status": 400})
        return _Resp(200, {"resultado": [], "totalRegistros": 0, "totalPaginas": 0})


def test_ca2_anos_padrao_e_tipo_material(monkeypatch):
    """CA-2: sem --anos em 11/11/2026, consulta 2026 e 2027 nas classes 7830 e 7220 com tipo=Material."""
    monkeypatch.setattr(compras_pgc.time, "sleep", lambda *_: None)
    sessao = _Sessao()
    codigo = compras_pgc.executar(["--dry-run"], hoje=date(2026, 11, 11), sessao=sessao)
    assert codigo == 0
    vistos = {(c["anoPcaProjetoCompra"], c["codigo"]) for c in sessao.chamadas}
    assert vistos == {(2026, 7830), (2026, 7220), (2027, 7830), (2027, 7220)}
    assert {c["tipo"] for c in sessao.chamadas} == {"Material"}


def test_ca2_http_400_falha_a_classe_sem_repetir_e_sai_com_1(monkeypatch):
    """CA-2: 400 de uma classe não é repetido (erro do pedido), conta como erro e o Job sai com código 1."""
    monkeypatch.setattr(compras_pgc.time, "sleep", lambda *_: None)
    sessao = _Sessao(falhar_classe=7220)
    codigo = compras_pgc.executar(["--dry-run", "--anos", "2026"], hoje=date(2026, 11, 11), sessao=sessao)
    assert codigo == 1
    assert sum(1 for c in sessao.chamadas if c["codigo"] == 7220) == 1


def test_ca2_job_despacha_coleta_pgc(monkeypatch):
    """CA-2: o Job (coletor.main) aceita --coleta pgc e devolve o código do coletor PGC."""
    chamado = {}

    def falso(argv):
        chamado["argv"] = argv
        return 1

    monkeypatch.setattr(compras_pgc, "executar", falso)
    assert coletor_main.main(["--coleta", "pgc", "--dry-run"]) == 1
    assert "--dry-run" in chamado["argv"]


@pytest.mark.parametrize("valor", [None, ""])
def test_ca1_item_sem_chave_completa_nao_entra_no_upsert(valor):
    """CA-1: linha sem número do item no PNCP não tem chave de upsert e não é gravada (nem inventada)."""
    cliente = _Cliente({(7830, 2026, 1): {"resultado": [_item(numeroItemPncp=valor)], "totalRegistros": 1,
                                         "totalPaginas": 1}})
    sb = MagicMock()
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026])
    assert sb.upsert.call_count == 0
    assert res["total_gravados"] == 0
    assert res["sem_chave"] == 1


def test_ca1_mesma_chave_em_paginas_diferentes_vira_uma_linha():
    """CA-1: a deduplicação é por (ano, classe) inteiro: chave repetida em outra página não regrava a linha mais velha."""
    nova = _item(dataHoraAtualizacaoItem="2026-06-12T09:00:00", statusContratacaoExecucao=4)
    velha = _item(dataHoraAtualizacaoItem="2026-05-09T10:08:00", statusContratacaoExecucao=1)
    pag1 = [nova] + [_item(numeroItemPncp=200 + i, codigoItemCatalogo=str(500000 + i)) for i in range(99)]
    cliente = _Cliente({
        (7830, 2026, 1): {"resultado": pag1, "totalRegistros": 101, "totalPaginas": 2},
        (7830, 2026, 2): {"resultado": [velha], "totalRegistros": 101, "totalPaginas": 2},
    })
    sb = MagicMock()
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026])
    gravadas = [ln for c in sb.upsert.call_args_list for ln in c[0][1]]
    alvo = [ln for ln in gravadas if ln["numero_item_pncp"] == 136]
    assert len(alvo) == 1 and alvo[0]["status_contratacao_execucao"] == "4"
    assert res["repetidos_descartados"] == 1
    assert res["total_gravados"] == 100


def test_ca2_leitura_parcial_da_classe_nao_grava_nada():
    """CA-2: página 1 ok e página 2 com erro → nada da classe é gravado e a execução conta 1 erro."""
    pag1 = [_item(numeroItemPncp=300 + i, codigoItemCatalogo=str(600000 + i)) for i in range(100)]

    class _ClienteFalha(_Cliente):
        def consultar_classe(self, classe, ano, pagina=1, tamanho_pagina=100):
            if pagina == 2:
                raise RuntimeError("HTTP 503 esgotado em PGC classe 7830")
            return super().consultar_classe(classe, ano, pagina, tamanho_pagina)

    cliente = _ClienteFalha({(7830, 2026, 1): {"resultado": pag1, "totalRegistros": 150, "totalPaginas": 2}})
    sb = MagicMock()
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026])
    assert sb.upsert.call_count == 0
    assert res["erros"] == 1 and res["sucesso"] is False


def test_ca2_job_repassa_anos_e_classes_ao_coletor_pgc(monkeypatch):
    """CA-2: --coleta pgc --anos 2027 pelo Job chega ao coletor PGC (reprocessar um ano)."""
    chamado = {}
    monkeypatch.setattr(compras_pgc, "executar", lambda argv: chamado.setdefault("argv", argv) and 0)
    coletor_main.main(["--coleta", "pgc", "--anos", "2027", "--classes", "7220"])
    assert chamado["argv"] == ["--anos", "2027", "--classes", "7220"]


def test_ca2_argumento_desconhecido_em_outra_coleta_continua_erro():
    """Regressão: fora do PGC, argumento desconhecido segue rejeitado."""
    with pytest.raises(SystemExit):
        coletor_main.main(["--coleta", "precos", "--anos", "2027"])
