"""Código CATMAT antes do texto em pncp.avaliar (coletor/catmat_codigo.py; 03/10/2026)."""
import pytest

from coletor import catmat_codigo as C
from coletor import pncp as P
from coletor import reclassificar_escopo_pncp as R

COMPRAS_GOV = {"id": 1, "nome": "Catálogo do Compras.gov.br"}
OUTROS = {"id": 2, "nome": "Outros"}
# 230525 = CESTO (PDM 121, fora do catálogo da empresa); 480144 = item de PDM do catálogo (2640)
MAPA = C.MapaCatmat(item_pdm={230525: 121, 480144: 2640, 93882: 762}, pdms_catalogo=frozenset({2640}))
COMPRA = {"description": "Aquisição de materiais diversos para a secretaria"}  # objeto neutro (não classifica)


def _it(n, desc, codigo=None, catalogo=None, ms="M"):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms, "catalogoCodigoItem": codigo,
            "catalogo": catalogo}


@pytest.mark.parametrize("it,esperado", [
    (_it(1, "x", 480144, COMPRAS_GOV), 480144),
    (_it(1, "x", "480144", COMPRAS_GOV), 480144),
    (_it(1, "x", 480144, OUTROS), None),          # código do órgão não é CATMAT
    (_it(1, "x", 480144, None), None),            # sem catálogo (ex.: 449/2026: catalogo = null)
    (_it(1, "x", 25151, COMPRAS_GOV, "S"), None),  # CATSER: mesmo espaço numérico, não é CATMAT
    (_it(1, "x", "AI0300075", COMPRAS_GOV), None),
    (_it(1, "x", "1" * 16, COMPRAS_GOV), None),
    (_it(1, "x", True, COMPRAS_GOV), None),
])
def test_codigo_catmat_so_compras_gov_em_material(it, esperado):
    assert C.codigo_catmat(it, P.material_ou_servico(it)) == esperado


def test_catalogo_id_do_pncp_e_do_banco():
    assert C.catalogo_id({"catalogo": {"id": 1}}) == 1
    assert C.catalogo_id({"catalogo": {"id": "2"}}) == 2
    assert C.catalogo_id({"catalogoId": 1}) == 1
    assert C.catalogo_id({"catalogo_id": 2}) == 2
    assert C.catalogo_id({"catalogo": None}) is None
    assert C.catalogo_id({}) is None


def test_codigo_do_catalogo_no_mapa_decide_catmat():
    # texto neutro ("item 7") não classificaria; o código do Compras.gov.br em PDM do catálogo classifica
    cat, _, por_item = P.avaliar(COMPRA, [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)], MAPA)
    assert cat == "catmat" and por_item[1][0] == "catmat"


def test_codigo_do_catalogo_fora_do_escopo_vence_o_texto():
    # código CATMAT de CESTO (PDM 121, fora do catálogo): o texto "bola de basquete" não reabre
    cat, _, por_item = P.avaliar(COMPRA, [_it(1, "BOLA DE BASQUETE OFICIAL", 230525, COMPRAS_GOV)], MAPA)
    assert por_item[1][0] is None and cat is None


def test_codigo_outros_cai_no_texto_como_antes():
    # licitação 92 item 7: 230525 do catálogo Outros = falso positivo CESTO. Fica o texto (sem o mapa: igual)
    itens = [_it(7, "BOLAS DE BASQUETE INFANTIL PLAYOFF MIRIM", "230525", OUTROS)]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)
    assert P.avaliar(COMPRA, itens, MAPA)[2][7][0] == P.avaliar(COMPRA, [_it(7, itens[0]["descricao"])])[2][7][0]


def test_codigo_fora_do_mapa_cai_no_texto():
    # 19 dos 41 PDMs do catálogo não têm itens nas tabelas CATMAT: código desconhecido não tira o item do escopo
    itens = [_it(1, "Esteira ergométrica profissional", 999999, COMPRAS_GOV)]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)
    assert P.avaliar(COMPRA, itens, MAPA)[0] == "forte"


def test_servico_com_codigo_catser_cai_no_texto():
    itens = [_it(1, "Manutenção de esteira ergométrica", 480144, COMPRAS_GOV, "S")]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)


def test_sem_mapa_e_so_texto():
    itens = [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)]
    assert P.avaliar(COMPRA, itens)[0] is None
    assert C.categoria_por_codigo(itens[0], None, "M") == (False, None)


def test_travas_do_objeto_valem_para_o_codigo():
    # obra no objeto: categoria só de material não conta, nem quando vem do código
    obra = {"description": "Contratação de empresa para execução de obra de construção de quadra"}
    assert P.avaliar(obra, [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)], MAPA)[2][1][0] is None


class _SB:
    def __init__(self, mapa=None, pdms=None, erro=None, regras_item=None, erro_regras=None):
        self.mapa, self.pdms, self.erro, self.chamadas = mapa, pdms, erro, []
        self.regras_item = [] if regras_item is None else regras_item
        self.erro_regras = erro_regras

    def selecionar(self, tabela, **filtros):
        self.chamadas.append((tabela, filtros))
        if self.erro:
            raise self.erro
        if tabela == "catalogo_empresa_catmat":
            if self.erro_regras:
                raise self.erro_regras
            return self.regras_item
        return self.mapa

    def rpc(self, funcao, params):
        self.chamadas.append((funcao, params))
        return self.pdms


# --- regras do catálogo no nível de item (catalogo_empresa_catmat nivel 'item'), como licitacoes_ids_por_catmat ---
# PDM 2640 incluído; 480145 (PDM 2640) excluído do PDM herdado; 230525 (PDM 121, fora) incluído avulso;
# 999001 avulso de PDM fora e ausente das tabelas CATMAT (o SQL também aceita: itens_avulsos não passa pelo mapa)
MAPA_ITEM = C.MapaCatmat(item_pdm={230525: 121, 480144: 2640, 480145: 2640, 93882: 762},
                         pdms_catalogo=frozenset({2640}), itens_avulsos={230525: 121, 999001: 555},
                         itens_excluidos=frozenset({480145}))


@pytest.mark.parametrize("codigo,esperado", [
    (480144, (True, "catmat")),   # herdado do PDM incluído
    (480145, (True, None)),       # excluído no nível de item: o PDM incluído não reabre
    (230525, (True, "catmat")),   # avulso incluído com PDM fora do catálogo
    (999001, (True, "catmat")),   # avulso fora do mapa CATMAT
    (93882, (True, None)),        # PDM fora, sem regra de item
    (777777, (False, None)),      # fora do mapa e sem regra: o texto decide
])
def test_regras_de_item_do_catalogo(codigo, esperado):
    it = _it(1, "x", codigo, COMPRAS_GOV)
    assert C.categoria_por_codigo(it, MAPA_ITEM, P.material_ou_servico(it)) == esperado


def test_regras_de_item_so_valem_para_codigo_catmat_valido():
    # catálogo Outros e CATSER não são CATMAT: avulso/excluído não se aplicam e o texto decide
    for it in (_it(1, "x", 230525, OUTROS), _it(1, "x", 480145, OUTROS), _it(1, "x", 230525, COMPRAS_GOV, "S")):
        assert C.categoria_por_codigo(it, MAPA_ITEM, P.material_ou_servico(it)) == (False, None)


def test_avaliar_respeita_item_excluido_e_avulso():
    excluido = P.avaliar(COMPRA, [_it(1, "Aparelho de musculação cross over", 480145, COMPRAS_GOV)], MAPA_ITEM)
    avulso = P.avaliar(COMPRA, [_it(1, "Cesto de roupa", 230525, COMPRAS_GOV)], MAPA_ITEM)
    assert excluido[0] != "catmat" and avulso[0] == "catmat"


def test_carregar_mapa_le_regras_de_item():
    sb = _SB(mapa=[{"codigo_item": 480145, "codigo_pdm": 2640}], pdms=[{"codigo_pdm": 2640}],
             regras_item=[{"codigo_item": 230525, "codigo_pdm": 121, "incluido": True},
                          {"codigo_item": "480145", "codigo_pdm": "2640", "incluido": False}])
    m = C.carregar_mapa_catmat(sb)
    assert m.itens_avulsos == {230525: 121} and m.itens_excluidos == {480145}


@pytest.mark.parametrize("sb", [
    _SB(mapa=[], pdms=[], erro_regras=RuntimeError("503")),
    _SB(mapa=[], pdms=[], regras_item={"erro": "fora do contrato"}),
    _SB(mapa=[], pdms=[], regras_item=[{"codigo_item": None, "codigo_pdm": 1, "incluido": True}]),
    _SB(mapa=[], pdms=[], regras_item=[{"codigo_item": 1, "codigo_pdm": 1, "incluido": None}]),
])
def test_regras_de_item_indisponiveis_levantam(sb):
    with pytest.raises(C.MapaCatmatIndisponivel):
        C.carregar_mapa_catmat_se_houver_banco(sb)


def test_carregar_mapa_le_as_duas_rpcs():
    sb = _SB(mapa=[{"codigo_item": 230525, "codigo_pdm": 121}, {"codigo_item": "480144", "codigo_pdm": "2640"}],
             pdms=[{"codigo_pdm": 2640}])
    m = C.carregar_mapa_catmat(sb)
    assert m.item_pdm == {230525: 121, 480144: 2640} and m.pdms_catalogo == {2640}
    assert sb.chamadas[0] == ("rpc/catmat_itens_mapa", {"select": "codigo_item,codigo_pdm", "order": "codigo_item.asc"})
    assert sb.chamadas[2] == ("catalogo_empresa_catmat", {"select": "codigo_item,codigo_pdm,incluido",
                                                          "nivel": "eq.item", "order": "codigo_item.asc"})
    assert m.itens_avulsos == {} and m.itens_excluidos == frozenset()


MAPA_RPC = [{"codigo_item": 230525, "codigo_pdm": 121}, {"codigo_item": 480144, "codigo_pdm": 2640}]
PDMS_RPC = [{"codigo_pdm": 2640}]


def test_sem_banco_so_texto_com_banco_falha_levanta():
    # só sem banco nenhum a classificação fica no texto; com banco, falha do mapa não vira "só texto" em silêncio
    assert C.carregar_mapa_catmat_se_houver_banco(None) is None
    with pytest.raises(C.MapaCatmatIndisponivel):
        C.carregar_mapa_catmat_se_houver_banco(_SB(erro=RuntimeError("503")))
    with pytest.raises(C.MapaCatmatIndisponivel):
        C.carregar_mapa_catmat_se_houver_banco(_SB(mapa=MAPA_RPC, pdms={"erro": "fora do contrato"}))
    with pytest.raises(C.MapaCatmatIndisponivel):
        C.carregar_mapa_catmat(_SB(mapa=[{"codigo_item": None, "codigo_pdm": 1}], pdms=[]))
    assert C.carregar_mapa_catmat_se_houver_banco(_SB(mapa=MAPA_RPC, pdms=PDMS_RPC)).pdms_catalogo == {2640}


def test_leitura_mapa_catmat_so_le():
    sb = _SB(mapa=MAPA_RPC, pdms=PDMS_RPC)
    leitor = C.LeituraMapaCatmat(sb)
    m = C.carregar_mapa_catmat(leitor)
    assert m.item_pdm == {230525: 121, 480144: 2640} and m.pdms_catalogo == {2640}
    with pytest.raises(PermissionError):
        leitor.rpc("drenar_licitacao_match", {})
    for escrita in ("upsert", "atualizar", "inserir", "drenar_licitacao_match"):
        with pytest.raises(PermissionError):
            getattr(leitor, escrita)
    assert [c[0] for c in sb.chamadas] == ["rpc/catmat_itens_mapa", "catalogo_catmat_pdms_efetivos",
                                           "catalogo_empresa_catmat"]


# --- main: o mapa é carregado antes de gravar; dry-run usa a mesma regra; falha com banco aborta ---

def _env_banco(monkeypatch, url="https://x.supabase.co", chave="k"):
    for nome, valor in (("SUPABASE_URL", url), ("SUPABASE_SERVICE_ROLE_KEY", chave)):
        if valor is None:
            monkeypatch.delenv(nome, raising=False)
        else:
            monkeypatch.setenv(nome, valor)


def _coletor_capturando(monkeypatch, sb_fake, argv):
    criados, visto = [], {}

    def fabrica(url, chave):
        criados.append((url, chave))
        return sb_fake

    def falso_coletar(pncp, sb, arm, termos, *a, **kw):
        visto.update(sb=sb, arm=arm, mapa=kw["mapa_catmat"], dry_run=a[-1])
        return {"encontradas": 0}
    monkeypatch.setattr(P, "Supabase", fabrica)
    monkeypatch.setattr(P, "coletar", falso_coletar)
    monkeypatch.setattr(P, "drenar_licitacao_match", lambda sb: None)
    monkeypatch.setattr(P.Armazenamento, "do_ambiente", classmethod(lambda cls: "arm"))
    return P.main(argv + ["--termos", "x"]), criados, visto


def test_coletor_dry_run_le_o_mapa_por_cliente_so_leitura(monkeypatch):
    _env_banco(monkeypatch)
    sb = _SB(mapa=MAPA_RPC, pdms=PDMS_RPC)
    rc, criados, visto = _coletor_capturando(monkeypatch, sb, ["--dry-run"])
    assert rc == 0 and criados == [("https://x.supabase.co", "k")]
    assert visto["sb"] is None and visto["arm"] is None  # coletar continua sem cliente de escrita
    assert visto["mapa"].item_pdm == {230525: 121, 480144: 2640} and visto["mapa"].pdms_catalogo == {2640}


def test_coletor_dry_run_sem_banco_fica_so_no_texto(monkeypatch):
    _env_banco(monkeypatch, None, None)
    rc, criados, visto = _coletor_capturando(monkeypatch, _SB(), ["--dry-run"])
    assert rc == 0 and criados == [] and visto["mapa"] is None


@pytest.mark.parametrize("argv", [["--dry-run"], []])
def test_coletor_aborta_antes_de_gravar_se_o_mapa_falha(monkeypatch, argv):
    _env_banco(monkeypatch)
    rc, _, visto = _coletor_capturando(monkeypatch, _SB(erro=RuntimeError("503")), argv)
    assert rc == 1 and visto == {}


def test_coletor_dry_run_com_banco_pela_metade_aborta(monkeypatch):
    _env_banco(monkeypatch, chave=None)
    rc, criados, visto = _coletor_capturando(monkeypatch, _SB(), ["--dry-run"])
    assert rc == 1 and criados == [] and visto == {}


def test_coletor_real_passa_o_mapa_para_coletar(monkeypatch):
    _env_banco(monkeypatch)
    sb = _SB(mapa=MAPA_RPC, pdms=PDMS_RPC)
    rc, _, visto = _coletor_capturando(monkeypatch, sb, [])
    assert rc == 0 and visto["sb"] is sb and visto["mapa"].pdms_catalogo == {2640}


def test_recoleta_aborta_se_o_mapa_falha_e_passa_o_mapa_se_carrega(monkeypatch):
    _env_banco(monkeypatch)
    visto = {}

    def falso_recoletar(pncp, sb, arm, **kw):
        visto.update(kw)
        return {}
    monkeypatch.setattr(P, "recoletar_atualizadas", falso_recoletar)
    monkeypatch.setattr(P, "drenar_licitacao_match", lambda sb: None)
    monkeypatch.setattr(P, "Supabase", lambda url, chave: _SB(erro=RuntimeError("503")))
    assert P.main(["--recoletar-atualizadas"]) == 1 and visto == {}
    monkeypatch.setattr(P, "Supabase", lambda url, chave: _SB(mapa=MAPA_RPC, pdms=PDMS_RPC))
    assert P.main(["--recoletar-atualizadas", "--dry-run"]) == 0 and visto["mapa_catmat"].pdms_catalogo == {2640}


def _reclassificador_capturando(monkeypatch, sb_fake, argv):
    _env_banco(monkeypatch)
    visto = {}

    def falso_reclassificar(sb, pncp, **kw):
        visto.update(sb=sb, mapa=kw["mapa_catmat"], aplicar=kw["aplicar"])
        return {"linhas": [], "amostra": {}, "transicoes_categoria": {}}
    monkeypatch.setattr(R, "Supabase", lambda url, chave: sb_fake)
    monkeypatch.setattr(R, "reclassificar", falso_reclassificar)
    return R.main(argv), visto


def test_reclassificador_dry_run_le_o_mapa_antes_de_embrulhar(monkeypatch):
    rc, visto = _reclassificador_capturando(monkeypatch, _SB(mapa=MAPA_RPC, pdms=PDMS_RPC), [])
    assert rc == 0 and visto["aplicar"] is False
    assert isinstance(visto["sb"], R.SomenteLeitura)  # o dry-run segue só leitura...
    assert visto["mapa"].item_pdm == {230525: 121, 480144: 2640}  # ...mas com o mesmo mapa do --apply
    rc, visto = _reclassificador_capturando(monkeypatch, _SB(mapa=MAPA_RPC, pdms=PDMS_RPC), ["--apply"])
    assert rc == 0 and visto["aplicar"] is True and visto["mapa"].pdms_catalogo == {2640}


@pytest.mark.parametrize("argv", [[], ["--apply"]])
def test_reclassificador_aborta_se_o_mapa_falha(monkeypatch, argv):
    rc, visto = _reclassificador_capturando(monkeypatch, _SB(erro=RuntimeError("503")), argv)
    assert rc == 1 and visto == {}


def test_coletor_grava_catalogo_id():
    sb = type("SB", (), {})()
    gravado = {}

    def upsert(tabela, linhas, conflito):
        gravado[tabela] = linhas
        return [{"id": 1}] if tabela == "licitacoes_externas" else []
    sb.upsert, sb.selecionar, sb.atualizar = upsert, lambda *a, **k: [], lambda *a, **k: None
    pncp = type("PN", (), {})()
    itens = [_it(1, "Borracha granulada para gramado sintético", "480144", COMPRAS_GOV),
             _it(2, "Borracha granulada G2", "77", OUTROS), _it(3, "Borracha granulada G3")]
    pncp.itens = lambda c: itens
    pncp.resultados = lambda c, n: []
    pncp.arquivos = lambda c: []
    pncp.compra = lambda c: {"processo": "1/2026"}
    c = {"numero_controle_pncp": "44892693000140-1-000157/2026", "orgao_cnpj": "44892693000140", "ano": 2026,
         "numero_sequencial": 157, "description": "Aquisição de borracha granulada"}
    P._processar(pncp, sb, None, c, "borracha", False, False, 1, False, {}, mapa_catmat=MAPA)
    assert [i["catalogo_id"] for i in gravado["licitacao_itens"]] == [1, 2, None]


def test_reclassificador_le_codigo_e_catalogo_gravados():
    assert "catalogo_codigo_item" in R.SELECT_ITENS and "catalogo_id" in R.SELECT_ITENS
    ln = {"licitacao_itens": [{"numero_item": 1, "descricao": "ZZ", "material_ou_servico": "M",
                               "catalogo_codigo_item": "480144", "catalogo_id": 1}]}
    it = R._itens_gravados(ln)[0]
    assert C.codigo_catmat(it, P.material_ou_servico(it)) == 480144
