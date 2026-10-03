"""Regra do forte ancorado no modo núcleo (Marcelo, 03/10/2026 19:00 BRT): forte só com item que casa âncora de PDM
ou de item incluído no catálogo; listas fixas só rebaixam para fraco; piso/borracha/obra_piso como estão."""
import csv
import os

import pytest

from coletor import catmat_ancoras as A
from coletor import catmat_codigo as C
from coletor import escopo as E
from coletor import pncp as P
from coletor import reclassificar_escopo_pncp as R
from coletor.entrada_arquivos import ClienteArquivos

# itens CATMAT de mentira, no formato de catmat_item_pdm (descrições no padrão do Compras.gov.br)
ITENS = [
    {"codigo_item": 1, "codigo_pdm": 4405, "descricao": "CANELEIRA, MATERIAL: NYLON, PESO: 2 KG"},
    {"codigo_item": 2, "codigo_pdm": 1400, "descricao": "CORDA DE PULAR, MATERIAL: PVC"},
    {"codigo_item": 3, "codigo_pdm": 2640, "descricao": "APARELHO / EQUIPAMENTO GINÁSTICA, TIPO: CADEIRA EXTENSORA"},
    {"codigo_item": 4, "codigo_pdm": 2640, "descricao": "APARELHO / EQUIPAMENTO GINÁSTICA, TIPO: ELÉTRICA"},
    {"codigo_item": 5, "codigo_pdm": 2640, "descricao": "APARELHO / EQUIPAMENTO GINÁSTICA, NOME: GANGORRA"},
    {"codigo_item": 6, "codigo_pdm": 7000, "descricao": "ANILHA, MATERIAL: FERRO FUNDIDO, PESO: 5 KG"},
    {"codigo_item": 7, "codigo_pdm": 9999, "descricao": "PISO, MATERIAL: BORRACHA SINTÉTICA, ESPESSURA: 20 MM"},
    {"codigo_item": 8, "codigo_pdm": 9999, "descricao": "PISO, MATERIAL: CERÂMICA"},
    {"codigo_item": 9, "codigo_pdm": 4405, "descricao": "TORNOZELEIRA, MATERIAL: NEOPRENE"},
    {"codigo_item": 10, "codigo_pdm": 8000, "descricao": "BICICLETA ERGOMÉTRICA, TIPO: HORIZONTAL"},
    {"codigo_item": 11, "codigo_pdm": 8100, "descricao": "SIMULADOR DE CAMINHADA, MATERIAL: AÇO"},
]
PDMS = {4405, 1400, 2640, 7000, 8000, 8100}
AVULSOS = {7: 9999}        # item incluído avulso de PDM fora do catálogo
EXCLUIDOS = {9}            # excluído do PDM herdado


def _ancoras(modo="nucleo"):
    return A.AncorasCatalogo.de(A.gerar_ancoras(ITENS, PDMS, AVULSOS, EXCLUIDOS), modo)


def _mapa(modo="nucleo", **kw):
    return C.MapaCatmat(item_pdm={}, pdms_catalogo=frozenset(PDMS), itens_avulsos=AVULSOS,
                        itens_excluidos=frozenset(EXCLUIDOS), ancoras=_ancoras(modo), **kw)


def _it(n, desc, ms="M"):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms}


NEUTRA = {"description": "Aquisição de materiais diversos para a secretaria"}


# --- geração e casamento das âncoras ---

def test_quebra_descricao_em_nome_e_atributos():
    assert A.quebrar_descricao("ANILHA, MATERIAL: FERRO , COR: PRETA") == (
        "ANILHA", [("MATERIAL", "FERRO"), ("COR", "PRETA")])
    assert A.quebrar_descricao("BOLA DE BASQUETE, OFICIAL") == ("BOLA DE BASQUETE, OFICIAL", [])


def test_gerar_ancoras_origens_e_regras_de_item():
    anc = {(a.codigo_pdm, a.ancora): a for a in A.gerar_ancoras(ITENS, PDMS, AVULSOS, EXCLUIDOS)}
    assert anc[(4405, "caneleira")].origem == "cabeca" and anc[(4405, "caneleira")].nucleo_basta
    assert anc[(2640, "cadeira extensora")].origem == "atributo_tipo"
    assert (2640, "eletrica") not in anc                      # TIPO fraco não vira âncora
    assert anc[(2640, "gangorra")].origem == "atributo_nome"
    assert anc[(9999, "piso borracha sintetica")].origem == "item_avulso"
    assert not any(a.codigo_item_origem == 8 for a in anc.values())   # PDM fora e item não incluído
    assert not any(a.codigo_item_origem == 9 for a in anc.values())   # item excluído
    assert not anc[(2640, "cadeira extensora")].nucleo_basta  # núcleo genérico (cadeira) precisa da âncora inteira


@pytest.mark.parametrize("desc,nucleo,estrito", [
    ("CANELEIRA 2 KG PAR", True, True),
    ("CANELEIRAS DE NYLON 2 KG", True, True),               # plural no núcleo
    ("ITEM 1 - KIT CANELEIRA 1 KG", True, True),            # enchimento inicial (ITEM n, KIT) sai
    ("Corda de pular em PVC 2,5 m", True, True),
    ("CORDA NAVAL 10 MM", False, False),                    # núcleo genérico: precisa casar a âncora inteira
    ("CORDA PULAR PROFISSIONAL", True, True),               # conectivo 'de' não conta
    ("Cadeira extensora com 80 kg", True, True),
    ("Cadeira giratória de escritório", False, False),
    ("Gangorra infantil cavalinho", True, True),
    ("Fita adesiva caneleira", False, False),               # âncora tem de abrir a descrição
])
def test_casamento_nucleo_e_estrito(desc, nucleo, estrito):
    assert bool(_ancoras("nucleo").casar(desc)) is nucleo
    assert bool(_ancoras("estrito").casar(desc)) is estrito


def test_nucleo_basta_so_no_modo_nucleo():
    itens = [{"codigo_item": 20, "codigo_pdm": 4405, "descricao": "CANELEIRA ACADEMIA, MATERIAL: NYLON"}]
    nuc = A.AncorasCatalogo.de(A.gerar_ancoras(itens, {4405}), "nucleo")
    est = A.AncorasCatalogo.de(A.gerar_ancoras(itens, {4405}), "estrito")
    assert nuc.casar("CANELEIRA 3 KG") and not est.casar("CANELEIRA 3 KG")
    assert est.casar("CANELEIRA PARA ACADEMIA 3 KG")
    with pytest.raises(ValueError):
        A.AncorasCatalogo.de([], "frouxo")


# --- leitura de catmat_item_pdm: 100 por página, fail-closed ---

class _SBItens:
    def __init__(self, linhas, erro=None):
        self.linhas, self.erro, self.chamadas = linhas, erro, []

    def selecionar(self, tabela, **f):
        self.chamadas.append((tabela, f))
        if self.erro:
            raise self.erro
        if "codigo_pdm" in f:
            alvo = {int(x) for x in f["codigo_pdm"][4:-1].split(",")}
            sel = [ln for ln in self.linhas if ln["codigo_pdm"] in alvo]
        else:
            alvo = {int(x) for x in f["codigo_item"][4:-1].split(",")}
            sel = [ln for ln in self.linhas if ln["codigo_item"] in alvo]
        o, n = int(f["offset"]), int(f["limit"])
        return sel[o:o + n]


def test_le_itens_100_por_pagina_e_pdms_em_blocos_de_50():
    linhas = [{"codigo_item": i, "codigo_pdm": 1 + i % 60, "descricao": f"CANELEIRA {i}"} for i in range(1, 251)]
    sb = _SBItens(linhas)
    out = A.ler_itens_catalogo(sb, range(1, 61))
    assert len(out) == 250
    assert all(f["limit"] == "100" for _, f in sb.chamadas)
    # 1º bloco (PDMs 1-50, 210 itens): 3 páginas + a vazia; 2º bloco (PDMs 51-60, 40 itens): 1 + a vazia
    assert [f["offset"] for _, f in sb.chamadas] == ["0", "100", "200", "210", "0", "40"]
    assert all(t == "catmat_item_pdm" for t, _ in sb.chamadas)


def test_pagina_maior_que_100_ou_sem_fim_falha_fechado(monkeypatch):
    class _Cheio:
        def selecionar(self, tabela, **f):
            return [{"codigo_item": i, "codigo_pdm": 1, "descricao": "X"} for i in range(int(f["limit"]) + 1)]

    class _SemFim:
        def selecionar(self, tabela, **f):
            o = int(f["offset"])
            return [{"codigo_item": o + i + 1, "codigo_pdm": 1, "descricao": "X"} for i in range(100)]
    with pytest.raises(A.AncorasIndisponiveis, match="máximo 100"):
        A.ler_itens_catalogo(_Cheio(), [1])
    monkeypatch.setattr(A, "MAX_PAGINAS", 3)
    with pytest.raises(A.AncorasIndisponiveis, match="sem página vazia"):
        A.ler_itens_catalogo(_SemFim(), [1])


def test_pdm_efetivo_sem_itens_falha_fechado():
    sb = _SBItens([{"codigo_item": 1, "codigo_pdm": 4405, "descricao": "CANELEIRA"}])
    with pytest.raises(A.AncorasIndisponiveis, match="1 PDM"):
        A.carregar_ancoras(sb, {4405, 1400})
    with pytest.raises(A.AncorasIndisponiveis):
        A.carregar_ancoras(_SBItens([], erro=RuntimeError("503")), {4405})
    with pytest.raises(A.AncorasIndisponiveis, match="linha inválida"):
        A.carregar_ancoras(_SBItens([{"codigo_item": None, "codigo_pdm": 4405}]), {4405})
    assert A.carregar_ancoras(sb, {4405}).casar("CANELEIRA 1 KG")


class _SBMapa(_SBItens):
    def __init__(self, linhas, pdms, erro_itens=None):
        super().__init__(linhas)
        self.pdms, self.erro_itens = pdms, erro_itens

    def selecionar(self, tabela, **f):
        if tabela == "rpc/catmat_itens_mapa":
            return [{"codigo_item": 1, "codigo_pdm": 4405}]
        if tabela == "catalogo_empresa_catmat":
            return []
        if self.erro_itens:
            raise self.erro_itens
        return super().selecionar(tabela, **f)

    def rpc(self, funcao, params):
        return [{"codigo_pdm": p} for p in self.pdms]


def test_mapa_traz_ancoras_e_modo_pela_env(monkeypatch):
    sb = _SBMapa([{"codigo_item": 1, "codigo_pdm": 4405, "descricao": "CANELEIRA, PESO: 1 KG"}], [4405])
    monkeypatch.delenv(C.ENV_FORTE_ANCORADO, raising=False)
    m = C.carregar_mapa_catmat(sb)
    assert m.ancoras is not None and m.ancoras.modo == "nucleo" and m.ancoras.casar("CANELEIRA 2 KG")
    monkeypatch.setenv(C.ENV_FORTE_ANCORADO, "estrito")
    assert C.carregar_mapa_catmat(sb).ancoras.modo == "estrito"
    monkeypatch.setenv(C.ENV_FORTE_ANCORADO, "desligado")
    assert C.carregar_mapa_catmat(sb).ancoras is None
    monkeypatch.setenv(C.ENV_FORTE_ANCORADO, "talvez")
    with pytest.raises(C.MapaCatmatIndisponivel, match="inválido"):
        C.carregar_mapa_catmat(sb)


def test_mapa_aborta_sem_os_itens_do_catalogo(monkeypatch):
    monkeypatch.delenv(C.ENV_FORTE_ANCORADO, raising=False)
    with pytest.raises(C.MapaCatmatIndisponivel, match="sem itens"):
        C.carregar_mapa_catmat(_SBMapa([], [4405]))
    with pytest.raises(C.MapaCatmatIndisponivel, match="âncoras"):
        C.carregar_mapa_catmat(_SBMapa([], [4405], erro_itens=RuntimeError("503")))
    monkeypatch.setenv(C.ENV_FORTE_ANCORADO, "desligado")   # emergência: regra antiga, sem ler os itens
    assert C.carregar_mapa_catmat(_SBMapa([], [4405])).ancoras is None


# --- regra em pncp.avaliar ---

def test_item_com_ancora_vira_forte_e_lista_fixa_sem_ancora_so_fraco():
    assert E.classificar("Esteira ergométrica elétrica 12 km/h") == "forte"   # lista fixa
    mot = {}
    cat, _, por_item = P.avaliar(NEUTRA, [_it(1, "Esteira ergométrica elétrica 12 km/h"),
                                          _it(2, "CANELEIRA 2 KG PAR")], _mapa(), motivos=mot)
    assert cat == "forte" and por_item[1][0] == "fraco" and por_item[2][0] == "forte"
    assert mot[2]["ancora"] == "caneleira" and mot[2]["pdm"] == 4405 and mot[2]["veto"] is None
    assert mot[1]["ancora"] is None
    # sem âncora nenhuma: a compra fica fraco (antes: forte)
    itens = [_it(1, "Esteira ergométrica elétrica 12 km/h")]
    assert P.avaliar(NEUTRA, itens)[0] == "forte"
    assert P.avaliar(NEUTRA, itens, _mapa())[0] == "fraco"


def test_ancora_promove_item_que_as_listas_nao_conheciam():
    for desc in ("CANELEIRA 2 KG", "Cadeira extensora com 80 kg"):
        assert E.classificar(desc) is None
        assert P.avaliar(NEUTRA, [_it(1, desc)])[0] is None
        assert P.avaliar(NEUTRA, [_it(1, desc)], _mapa())[0] == "forte"


def test_piso_borracha_obra_piso_ficam_como_estao():
    for desc in ("Piso emborrachado para academia 20 mm", "Granulado de borracha SBR para grama sintética"):
        antes = P.avaliar(NEUTRA, [_it(1, desc)])
        assert antes[0] in ("piso", "borracha", "obra_piso")
        assert P.avaliar(NEUTRA, [_it(1, desc)], _mapa()) == antes
    # item de piso que também casa âncora avulsa continua piso (piso vence)
    assert P.avaliar(NEUTRA, [_it(1, "Piso de borracha sintética 20 mm para academia")], _mapa())[0] == "piso"


def test_objeto_forte_sem_ancora_vira_fraco():
    compra = {"description": "Aquisição de esteira ergométrica e bicicleta ergométrica"}
    assert P.avaliar(compra, [])[0] == "forte"
    assert P.avaliar(compra, [], _mapa())[0] == "fraco"


@pytest.mark.parametrize("desc,veto", [
    ("ANILHA DE VEDAÇÃO 2 POLEGADAS", "ITEM_FORA"),
    ("ANILHA 5 KG FERRO FUNDIDO", None),
    ("Bicicleta ergométrica horizontal display com cronômetro e calorias", None),   # cronômetro é da bike
    ("Simulador de caminhada para academia ao ar livre", "ACADEMIA_AR_LIVRE"),
    # listas de OBJETO não vetam item (construção/transporte/uniforme/aulas são características do produto)
    ("Caneleira 2 kg enchimento uniforme, costura reforçada", None),
    ("Cadeira extensora construção robusta em aço, rodas para transporte", None),
])
def test_veto_das_listas_fixas_rebaixa_para_fraco(desc, veto):
    mot = {}
    cat = P.avaliar(NEUTRA, [_it(1, desc)], _mapa(), motivos=mot)[0]
    assert mot[1]["ancora"] is not None and mot[1]["veto"] == veto
    assert cat == ("fraco" if veto else "forte")


def test_travas_continuam_valendo_para_o_item_ancorado():
    # item de serviço sem fornecimento
    assert P.avaliar(NEUTRA, [_it(1, "Caneleira manutenção e reparo", "S")], _mapa())[0] is None
    # compra de passagem (móveis) sem item core: âncora não é core, forte cai para fraco
    moveis = {"description": "Aquisição de mobiliário escolar"}
    assert P.avaliar(moveis, [_it(1, "CANELEIRA 2 KG"), _it(2, "Mesa escolar")], _mapa())[0] == "fraco"
    # obra no objeto: categoria só de material não conta
    obra = {"description": "Contratação de empresa para execução de obra de construção de quadra"}
    assert P.avaliar(obra, [_it(1, "CANELEIRA 2 KG")], _mapa())[0] is None


def test_codigo_catmat_continua_antes_da_ancora():
    mapa = _mapa()
    mapa = C.MapaCatmat(item_pdm={480144: 2640}, pdms_catalogo=mapa.pdms_catalogo, ancoras=mapa.ancoras)
    it = {"numeroItem": 1, "descricao": "ZZ ITEM 7", "materialOuServico": "M", "catalogoCodigoItem": 480144,
          "catalogo": {"id": 1}}
    mot = {}
    assert P.avaliar(NEUTRA, [it], mapa, motivos=mot)[0] == "catmat" and mot == {}


def test_sem_ancoras_regra_antiga():
    itens = [_it(1, "Esteira ergométrica elétrica 12 km/h")]
    sem = C.MapaCatmat(item_pdm={}, pdms_catalogo=frozenset(PDMS))   # FORTE_ANCORADO=desligado
    assert P.avaliar(NEUTRA, itens, sem) == P.avaliar(NEUTRA, itens) and P.avaliar(NEUTRA, itens)[0] == "forte"


# --- reclassificador: dry-run offline gera backup SQL e mudanças, sem gravar ---

def _csv(caminho, cab, linhas):
    with open(caminho, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cab)
        w.writerows(linhas)


def _entrada(tmp_path):
    d = tmp_path / "export"
    d.mkdir()
    _csv(d / "compras.csv", ["id", "codigo_externo", "fonte", "objeto", "title", "categoria_escopo",
                             "interesse_borracha", "prioridade", "fase", "situacao", "prioridade_efetiva"], [
        [10, "11-1-2026", "pncp", NEUTRA["description"], "", "forte", "f", "leads", "", "", "leads"],
        [11, "11-2-2026", "pncp", NEUTRA["description"], "", "fraco", "f", "monitorar", "", "", "monitorar"],
        [12, "11-3-2026", "pncp", NEUTRA["description"], "", "piso", "t", "leads", "", "", "leads"],
    ])
    _csv(d / "itens.csv", ["id", "licitacao_id", "numero_item", "descricao", "material_ou_servico", "situacao",
                           "tem_resultado", "categoria_escopo", "interesse_borracha", "catalogo_codigo_item",
                           "catalogo_id"], [
        [100, 10, 1, "Esteira ergométrica elétrica 12 km/h", "M", "", "f", "forte", "f", "", ""],
        [110, 11, 1, "Gangorra infantil cavalinho", "M", "", "f", "fraco", "f", "", ""],
        [120, 12, 1, "Piso emborrachado para academia 20 mm", "M", "", "f", "piso", "t", "", ""],
    ])
    _csv(d / "mapa.csv", ["codigo_item", "codigo_pdm"], [])
    _csv(d / "pdms_efetivos.csv", ["codigo_pdm"], [[p] for p in sorted(PDMS)])
    _csv(d / "regras_item.csv", ["nivel", "codigo_item", "codigo_pdm", "incluido"],
         [["item", 7, 9999, "t"], ["item", 9, 4405, "f"]])
    _csv(d / "itens_catalogo.csv", ["codigo_item", "codigo_pdm", "descricao"],
         [[it["codigo_item"], it["codigo_pdm"], it["descricao"]] for it in ITENS])
    return d


def test_cliente_arquivos_so_le(tmp_path):
    cli = ClienteArquivos(str(_entrada(tmp_path)))
    sel = cli.selecionar("licitacoes_externas", fonte="eq.pncp", **{"and": "(id.gte.11,id.lte.12)"})
    assert [ln["id"] for ln in sel] == [11, 12]
    assert cli.selecionar("licitacao_itens", licitacao_id="in.(10,12)")[1]["interesse_borracha"] is True
    assert len(cli.selecionar("catmat_item_pdm", codigo_pdm="in.(2640)", limit="2", offset="1")) == 2
    for escrita in ("atualizar", "upsert", "inserir"):
        with pytest.raises(PermissionError):
            getattr(cli, escrita)
    with pytest.raises(PermissionError):
        cli.rpc("drenar_licitacao_match", {})


def test_reclassificador_dry_run_offline_gera_backup_e_mudancas(tmp_path, monkeypatch):
    monkeypatch.delenv(C.ENV_FORTE_ANCORADO, raising=False)
    monkeypatch.setattr(R, "Supabase", lambda *a, **k: pytest.fail("dry-run offline não abre o Supabase"))
    d = _entrada(tmp_path)
    bkp, mud, js = tmp_path / "b.sql", tmp_path / "m.csv", tmp_path / "l.json"
    assert R.main(["--entrada-dir", str(d), "--sql-backup", str(bkp), "--mudancas-csv", str(mud),
                   "--json", str(js)]) == 0
    sql = bkp.read_text(encoding="utf-8")
    assert "begin read only;" in sql and "rollback;" in sql
    assert "where id in (\n    10, 11\n )" in sql
    assert "-- update public.licitacoes_externas set categoria_escopo = 'forte' where id = 10;" in sql
    assert "-- update public.licitacao_itens set categoria_escopo = 'forte' where id = 100;" in sql
    assert "-- update public.licitacao_itens set categoria_escopo = 'fraco' where id = 110;" in sql
    linhas_sql = [ln for ln in sql.splitlines() if ln.strip() and not ln.startswith("--")]
    assert not any(ln.lstrip().lower().startswith(("update", "insert", "delete")) for ln in linhas_sql)
    with open(mud, encoding="utf-8") as fh:
        mud_ = list(csv.DictReader(fh))
    chave = {(m["tipo"], m["licitacao_id"], m["campo"]): m for m in mud_}
    assert chave[("compra", "10", "categoria_escopo")]["depois"] == "fraco"
    assert chave[("compra", "11", "categoria_escopo")]["depois"] == "forte"
    assert chave[("compra", "11", "categoria_escopo")]["ancoras"] == "2640:gangorra"
    assert chave[("item", "11", "categoria_escopo")]["ancoras"] == "2640:gangorra"
    assert not any(m["licitacao_id"] == "12" for m in mud_)            # piso fica
    assert not any(m["campo"] in ("prioridade", "fase") for m in mud_)  # só escopo


def test_reclassificador_offline_recusa_apply(tmp_path):
    assert R.main(["--entrada-dir", str(_entrada(tmp_path)), "--apply"]) == 2


def test_reclassificador_offline_aborta_sem_itens_do_catalogo(tmp_path, monkeypatch):
    monkeypatch.delenv(C.ENV_FORTE_ANCORADO, raising=False)
    d = _entrada(tmp_path)
    _csv(d / "itens_catalogo.csv", ["codigo_item", "codigo_pdm", "descricao"], [[1, 4405, "CANELEIRA"]])
    bkp = tmp_path / "b.sql"
    assert R.main(["--entrada-dir", str(d), "--sql-backup", str(bkp)]) == 1 and not os.path.exists(bkp)


def test_so_escopo_nao_recalcula_prioridade():
    ln = {"id": 1, "codigo_externo": "1-1-2026", "objeto": NEUTRA["description"], "categoria_escopo": "forte",
          "interesse_borracha": False, "prioridade": "leads", "fase": None, "raw": {},
          "licitacao_itens": [{"id": 9, "numero_item": 1, "descricao": "CANELEIRA 2 KG", "material_ou_servico": "M",
                               "categoria_escopo": "forte", "interesse_borracha": False}], "_documentos": []}
    from datetime import datetime, timezone
    res = R.reavaliar(ln, None, datetime.now(timezone.utc), mapa_catmat=_mapa(), so_escopo=True)
    assert res["status"] == "sem_mudanca" and res["ancoras"] == ["4405:caneleira"]
    assert "prioridade" not in res["campos"] and "fase" not in res["campos"]


def test_compra_sem_itens_com_forte_so_do_objeto_cai_para_fraco():
    from datetime import datetime, timezone
    ln = {"id": 2, "codigo_externo": "1-2-2026", "objeto": "Aquisição de esteira ergométrica e bicicleta ergométrica",
          "categoria_escopo": "forte", "interesse_borracha": False, "prioridade": "monitorar", "fase": None, "raw": {},
          "licitacao_itens": [], "_documentos": []}
    agora = datetime.now(timezone.utc)
    res = R.reavaliar(ln, None, agora, mapa_catmat=_mapa(), so_escopo=True)
    assert res["fonte_itens"] == "objeto" and res["campos"] == {"categoria_escopo": "fraco"}
    sem = C.MapaCatmat(item_pdm={}, pdms_catalogo=frozenset(PDMS))   # regra antiga: objeto mantém o forte
    assert R.reavaliar(ln, None, agora, mapa_catmat=sem, so_escopo=True)["status"] == "sem_mudanca"
