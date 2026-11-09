"""Spec 0044, K-3: script que apaga do Storage os arquivos dos documentos-lixo (sem rede: sessão falsa)."""
import importlib.util
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("legislacao_apagar_arquivos", RAIZ / "scripts/ops/legislacao_apagar_arquivos.py")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

LIXO = "6b1914a7-013d-4514-a183-fbadef62a3a0"
NORMA = "978c942f-d777-4a3b-93c7-4bdc7e2b13e0"


class Resp:
    def __init__(self, dados, status=200):
        self.status_code, self._dados, self.text = status, dados, ""

    def json(self):
        return self._dados


class Sessao:
    def __init__(self, arvore):
        self.arvore = arvore
        self.apagados: list[str] = []

    def post(self, url, headers, timeout, json):
        assert url.endswith("/object/list/pncp-legislation") and timeout
        return Resp(self.arvore.get(json["prefix"], [])[json["offset"]:json["offset"] + json["limit"]])

    def delete(self, url, headers, timeout, json):
        self.apagados += json["prefixes"]
        return Resp({})


def test_ids_vem_da_migration_e_sao_os_21_documentos_lixo():
    ids = mod.ids_da_migration()
    assert len(ids) == 21 and len(set(ids)) == 21
    assert LIXO in ids and NORMA not in ids


def test_planeja_so_os_arquivos_dos_ids_e_executa_em_lote():
    arvore = {
        "": [{"name": LIXO, "id": None}, {"name": NORMA, "id": None}],
        LIXO: [{"name": "abcd1234abcd1234", "id": None}],
        f"{LIXO}/abcd1234abcd1234": [{"name": "original.pdf", "id": "o1"}],
        NORMA: [{"name": "ffff", "id": None}],
        f"{NORMA}/ffff": [{"name": "original.pdf", "id": "o2"}],
    }
    sessao = Sessao(arvore)
    st = mod.Storage("https://x.supabase.co", "chave", sessao)
    apagar, fora = mod.planejar(st, [LIXO])
    assert apagar == [f"{LIXO}/abcd1234abcd1234/original.pdf"]
    assert fora == [f"{NORMA}/ffff/original.pdf"]
    assert sessao.apagados == []  # planejar não apaga
    st.apagar(apagar)
    assert sessao.apagados == apagar
