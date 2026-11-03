"""Spec 0023: proveniência por linha em licitacoes_externas (payload_hash, ingestao_origem, ingestao_em).
Offline: nenhum teste chama API real."""
import hashlib
import json
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from coletor import main as M
from coletor import paradigma as PA
from coletor import pncp as P
from coletor import portal as PO
from coletor.proveniencia import ORIGENS, campos_proveniencia, hash_payload
from tests.test_paradigma import DETALHE_7752
from tests.test_pncp import COMPRA, _pncp, _sb
from tests.test_pncp_meta_versao_anexos import _cenario

A1 = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
A2 = datetime(2026, 10, 14, 15, 30, tzinfo=timezone.utc)


def _sha(raw: dict) -> str:
    return hashlib.sha256(
        json.dumps(raw, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()


def _linha_gravada(sb: MagicMock) -> dict:
    return {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]


def test_ca2_coletor_pncp_grava_hash_origem_e_hora():
    """CA-2: compra coletada com --origem cron leva sha256 do raw estável, origem e hora UTC da passagem."""
    sb = _sb()
    P.coletar(_pncp([COMPRA]), sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=A1, origem="cron")
    lic = _linha_gravada(sb)
    assert lic["payload_hash"] == _sha(lic["raw"])
    assert lic["ingestao_origem"] == "cron"
    assert lic["ingestao_em"] == A1.isoformat()


def test_ca2_origem_padrao_e_manual_e_cli_aceita_so_cron_ou_manual():
    """CA-2: sem --origem, manual; o parser só aceita cron ou manual."""
    sb = _sb()
    P.coletar(_pncp([COMPRA]), sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=A1)
    assert _linha_gravada(sb)["ingestao_origem"] == "manual"
    parser = P.criar_parser()
    assert parser.parse_args([]).origem == "manual"
    assert parser.parse_args(["--origem", "cron"]).origem == "cron"
    with pytest.raises(SystemExit):
        parser.parse_args(["--origem", "robo"])


def test_ca3_recoleta_mesmo_raw_mantem_hash_e_troca_passagem():
    """CA-3: raw idêntico -> mesmo hash; origem/hora passam a ser da passagem nova; created_at/first_seen_at
    não vão no upsert (o banco preserva)."""
    sb1, sb2 = _sb(), _sb()
    P.coletar(_pncp([COMPRA]), sb1, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=A1, origem="manual")
    P.coletar(_pncp([COMPRA]), sb2, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=A2, origem="cron")
    l1, l2 = _linha_gravada(sb1), _linha_gravada(sb2)
    assert l1["payload_hash"] == l2["payload_hash"]
    assert (l1["ingestao_origem"], l1["ingestao_em"]) == ("manual", A1.isoformat())
    assert (l2["ingestao_origem"], l2["ingestao_em"]) == ("cron", A2.isoformat())
    for chave in ("created_at", "first_seen_at", "last_synced_at", "updated_at"):
        assert chave not in l2


def test_ca4_sem_raw_hash_nulo_mas_passagem_registrada():
    """CA-4: raw ausente ou vazio -> payload_hash nulo (nada inventado); origem e hora ainda gravadas."""
    for raw in (None, {}, ""):
        c = campos_proveniencia(raw, "manual", A1)
        assert c["payload_hash"] is None
        assert c["ingestao_origem"] == "manual" and c["ingestao_em"] == A1.isoformat()
    assert hash_payload({"b": 1, "a": "é"}) == _sha({"a": "é", "b": 1})
    assert ORIGENS == ("cron", "manual")
    with pytest.raises(ValueError):
        campos_proveniencia({"x": 1}, "robo", A1)


def test_ca3_recoleta_propaga_origem_cron():
    """CA-3/CA-9: recoletar_atualizadas grava a passagem nova com a origem informada."""
    sb, p = _cenario()
    P.recoletar_atualizadas(p, sb, agora=A2, origem="cron")
    lics = [ln for t, ln in sb.upserts if t == "licitacoes_externas"]
    assert lics, "a recoleta não regravou nenhuma compra"
    assert all(ln["ingestao_origem"] == "cron" and ln["ingestao_em"] == A2.isoformat() for ln in lics)
    assert all(ln["payload_hash"] == _sha(ln["raw"]) for ln in lics)


def test_ca9_paradigma_coletar_propaga_origem_ate_o_upsert():
    """CA-9: paradigma.coletar -> processar_processo -> linha_licitacao levam a origem até o upsert."""
    portal = MagicMock()
    portal.fonte = PA.FONTES["sfiec"]
    d = {"nCdProcesso": 103, "nCdModulo": 18, "sNrEdital": "PE000192023", "sDsSituacao": "Homologado",
         "sDsObjeto": "Aquisição de Equipamentos de Crossfit", "tDtFinal": None}
    portal.detalhes.return_value = d
    portal.itens.return_value = []
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 7}] if t == "licitacoes_externas" else l
    PA.coletar(portal, sb, [], None, False, com_resultados=False, processos=[(103, 18)], origem="cron")
    lic = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]
    assert lic["ingestao_origem"] == "cron" and lic["payload_hash"] == _sha(lic["raw"])


def test_ca9_parsers_de_paradigma_e_sestsenat_aceitam_origem(monkeypatch):
    """CA-9: --origem existe nos três CLIs e recusa valor fora de cron|manual."""
    import argparse
    capturado = {}
    original = argparse.ArgumentParser.parse_args

    def parse_e_para(self, args=None, namespace=None):
        ns = original(self, args, namespace)
        capturado["origem"] = ns.origem
        raise SystemExit(0)  # interrompe antes de qualquer rede

    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", parse_e_para)
    with pytest.raises(SystemExit):
        PA.main(["--fonte", "sfiec", "--origem", "cron"])
    assert capturado["origem"] == "cron"
    with pytest.raises(SystemExit):
        M.main(["--origem", "manual"])
    assert capturado["origem"] == "manual"
    with pytest.raises(SystemExit):
        M.main(["--origem", "robo"])


def test_ca9_paradigma_e_sestsenat_tambem_gravam_proveniencia():
    """CA-9: todo escritor de licitacoes_externas grava os três campos."""
    li = PA.linha_licitacao(PA.FONTES["fiesc"], DETALHE_7752, "forte", False, agora=A1, origem="cron")
    assert li["payload_hash"] == _sha(li["raw"])
    assert li["ingestao_origem"] == "cron" and li["ingestao_em"] == A1.isoformat()
    d = {"nCdProcesso": 7752, "sNrProcesso": "1/2026", "sNrEdital": "E1", "sDsObjeto": "x"}
    ln = PO.processo_para_linha(d, 59, origem="manual", agora=A2)
    assert ln["payload_hash"] == _sha(ln["raw"]) and ln["ingestao_origem"] == "manual"
    assert ln["ingestao_em"] == A2.isoformat()
