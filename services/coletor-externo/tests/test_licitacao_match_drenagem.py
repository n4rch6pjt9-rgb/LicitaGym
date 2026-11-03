"""Drenagem de public.licitacao_match pelo coletor (destino.Supabase). Sem rede: requests.post é substituído."""
import coletor.destino as Destino
from coletor.destino import Supabase, drenar_licitacao_match

# PostgREST local do Supabase CLI; nenhuma requisição sai (requests.post é substituído), e não há chave.
URL_LOCAL = "http://127.0.0.1:54321"


class Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = str(payload)

    def json(self):
        return self._payload


def instalar(monkeypatch, respostas_rpc):
    """Responde licitacao_match_atualizar com a sequência dada; upserts respondem []. Devolve o log de chamadas."""
    chamadas = []
    fila = list(respostas_rpc)

    def fake_post(url, json=None, headers=None, timeout=None, params=None):
        chamadas.append((url.rsplit("/rest/v1/", 1)[1], json))
        if url.endswith("/rpc/licitacao_match_atualizar"):
            r = fila.pop(0)
            return r if isinstance(r, Resp) else Resp(r)
        return Resp([])

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        chamadas.append(("patch:" + url.rsplit("/rest/v1/", 1)[1], json))
        return Resp(None, 204)

    monkeypatch.setattr("coletor.destino.requests.post", fake_post)
    monkeypatch.setattr("coletor.destino.requests.patch", fake_patch)
    return chamadas


def rpcs(chamadas):
    return [c for c in chamadas if c[0] == "rpc/licitacao_match_atualizar"]


def test_drenar_chama_em_lotes_ate_zerar(monkeypatch):
    chamadas = instalar(monkeypatch, [600, 300, 0])
    sb = Supabase(URL_LOCAL, "")
    assert sb.drenar_licitacao_match() == 0
    assert [c[1] for c in rpcs(chamadas)] == [{"p_limite": 300}] * 3


def test_drenar_respeita_max_lotes(monkeypatch):
    chamadas = instalar(monkeypatch, [900, 600, 300])
    sb = Supabase(URL_LOCAL, "")
    assert sb.drenar_licitacao_match(limite=100, max_lotes=2) == 600
    assert [c[1] for c in rpcs(chamadas)] == [{"p_limite": 100}] * 2


def test_falha_na_drenagem_nao_interrompe_a_coleta(monkeypatch):
    instalar(monkeypatch, [Resp({"message": "canceling statement due to statement timeout"}, 500)])
    sb = Supabase(URL_LOCAL, "")
    assert sb.drenar_licitacao_match() is None


def test_upsert_de_texto_drena_a_cada_lote(monkeypatch):
    monkeypatch.setattr(Destino, "LICITACAO_MATCH_LOTE", 300)
    chamadas = instalar(monkeypatch, [0, 0])
    sb = Supabase(URL_LOCAL, "")
    itens = [{"licitacao_id": 1, "numero_item": i, "descricao": "x"} for i in range(299)]
    sb.upsert("licitacao_itens", itens, "licitacao_id,numero_item")
    assert rpcs(chamadas) == []
    sb.upsert("licitacoes_externas", {"fonte": "pncp", "codigo_externo": "1", "objeto": "y"}, "fonte,codigo_externo")
    assert len(rpcs(chamadas)) == 1  # 299 itens + 1 licitação
    sb.upsert("licitacao_documentos", [{"x": 1}] * 500, "id")  # tabela sem texto CATMAT não conta
    assert len(rpcs(chamadas)) == 1
    sb.upsert("licitacao_itens", itens + itens, "licitacao_id,numero_item")
    assert len(rpcs(chamadas)) == 2


def test_atualizar_so_conta_campos_de_texto(monkeypatch):
    monkeypatch.setattr(Destino, "LICITACAO_MATCH_LOTE", 1)
    chamadas = instalar(monkeypatch, [0])
    sb = Supabase(URL_LOCAL, "")
    sb.atualizar("licitacoes_externas", 10, {"prioridade": "leads"})
    sb.atualizar("licitacao_itens", 11, {"escopo_estado": "OUT_OF_SCOPE"})
    assert rpcs(chamadas) == []
    sb.atualizar("licitacoes_externas", 10, {"objeto": "novo objeto"})
    assert len(rpcs(chamadas)) == 1


def test_drenar_no_fim_da_execucao_ignora_dry_run(monkeypatch):
    chamadas = instalar(monkeypatch, [0])
    assert drenar_licitacao_match(None) is None
    assert drenar_licitacao_match(object()) is None
    assert drenar_licitacao_match(Supabase(URL_LOCAL, "")) == 0
    assert len(rpcs(chamadas)) == 1


def test_falha_na_drenagem_zera_o_contador_e_nao_repete_a_cada_upsert(monkeypatch, caplog):
    monkeypatch.setattr(Destino, "LICITACAO_MATCH_LOTE", 300)
    falha = Resp({"message": "canceling statement due to statement timeout"}, 500)
    chamadas = instalar(monkeypatch, [falha, 0])
    sb = Supabase(URL_LOCAL, "")
    itens = [{"licitacao_id": 1, "numero_item": i, "descricao": "x"} for i in range(300)]
    with caplog.at_level("WARNING", logger="coletor.destino"):
        sb.upsert("licitacao_itens", itens, "licitacao_id,numero_item")  # chega ao lote: drena e falha
    assert len(rpcs(chamadas)) == 1
    assert "drenagem falhou" in caplog.text
    assert sb._textos_sem_drenar == 0
    for i in range(299):  # abaixo de outro lote: não tenta de novo
        sb.upsert("licitacao_itens", [itens[i]], "licitacao_id,numero_item")
    assert len(rpcs(chamadas)) == 1
    sb.upsert("licitacao_itens", [itens[0]], "licitacao_id,numero_item")  # 300 de novo: tenta (e agora zera)
    assert len(rpcs(chamadas)) == 2
