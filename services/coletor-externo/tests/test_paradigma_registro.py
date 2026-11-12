"""Registro da execução do coletor Paradigma em private.coleta_externa_run (issue #245).

A saúde operacional (coleta_externa_dias_sem_sucesso) lê essa tabela; sem registro o alerta fica crítico para
sempre. O coletor registra pelas RPCs coleta_externa_iniciar/finalizar. Nenhum teste chama API real.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from coletor import paradigma as P


class SupabaseFalso:
    def __init__(self, falhar_rpc: bool = False):
        self.rpcs: list[tuple[str, dict]] = []
        self.falhar_rpc = falhar_rpc

    def rpc(self, funcao, params, timeout=60):
        self.rpcs.append((funcao, params))
        if self.falhar_rpc:
            raise RuntimeError("Supabase rpc fora do ar")
        if funcao == "coleta_externa_iniciar":
            return 42
        return True


ARGS_BASE = [
    "--fonte",
    "fiesc",
    "--origem",
    "cron",
    "--sem-catalogo",
    "--sem-documentos",
    "--sem-resultados",
    "--sem-fornecedores",
]


@pytest.fixture
def sb(monkeypatch):
    falso = SupabaseFalso()
    monkeypatch.setenv("SUPABASE_URL", "https://exemplo.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-teste")
    import coletor.destino as destino

    monkeypatch.setattr(destino, "Supabase", lambda *a, **k: falso)
    monkeypatch.setattr(P, "PortalParadigma", lambda *a, **k: MagicMock())
    return falso


def _finalizacao(sb: SupabaseFalso) -> dict:
    fim = [p for f, p in sb.rpcs if f == "coleta_externa_finalizar"]
    assert len(fim) == 1, sb.rpcs
    return fim[0]


def test_coleta_concluida_abre_e_fecha_registro(sb, monkeypatch):
    monkeypatch.setattr(
        P,
        "coletar",
        lambda *a, **k: {
            "listados": 12,
            "processos": 5,
            "no_escopo": 2,
            "itens_escopo": 9,
            "erros": 0,
            "paginacao_avisos": [],
        },
    )
    assert P.main(ARGS_BASE) == 0
    assert sb.rpcs[0] == (
        "coleta_externa_iniciar",
        {"p_fonte": "fiesc", "p_modo": "leads", "p_termos": P.TERMOS_SISTEMA_S},
    )
    fim = _finalizacao(sb)
    assert fim["p_id"] == 42 and fim["p_status"] == "concluida"
    assert (
        fim["p_listados"],
        fim["p_processos"],
        fim["p_no_escopo"],
        fim["p_itens_escopo"],
        fim["p_erros"],
    ) == (12, 5, 2, 9, 0)
    assert fim["p_detalhe_erros"] is None


def test_erro_com_escopo_fecha_concluida_com_erros(sb, monkeypatch):
    monkeypatch.setattr(
        P,
        "coletar",
        lambda *a, **k: {
            "listados": 3,
            "processos": 3,
            "no_escopo": 1,
            "itens_escopo": 1,
            "erros": 1,
            "paginacao_avisos": ["pagina 2 repetida"],
        },
    )
    assert P.main(ARGS_BASE) == 0
    fim = _finalizacao(sb)
    assert fim["p_status"] == "concluida_com_erros"
    assert fim["p_detalhe_erros"] == {"paginacao_avisos": ["pagina 2 repetida"]}


def test_erro_sem_escopo_fecha_falhou_e_sai_com_1(sb, monkeypatch):
    monkeypatch.setattr(
        P,
        "coletar",
        lambda *a, **k: {
            "listados": 0,
            "processos": 0,
            "no_escopo": 0,
            "itens_escopo": 0,
            "erros": 2,
            "paginacao_avisos": [],
        },
    )
    assert P.main(ARGS_BASE) == 1
    assert _finalizacao(sb)["p_status"] == "falhou"


def test_host_bloqueado_fecha_falhou_e_propaga(sb, monkeypatch):
    def bloqueado(*a, **k):
        raise PermissionError(
            "fiergs: o host recusou o acesso (HTTP 403); bloqueio não se contorna."
        )

    monkeypatch.setattr(P, "coletar", bloqueado)
    with pytest.raises(PermissionError):
        P.main(ARGS_BASE)
    fim = _finalizacao(sb)
    assert fim["p_status"] == "falhou" and fim["p_erros"] == 1
    assert "HTTP 403" in fim["p_detalhe_erros"]["erro"]


def test_falha_no_registro_nao_derruba_a_coleta(monkeypatch, sb):
    sb.falhar_rpc = True
    monkeypatch.setattr(
        P,
        "coletar",
        lambda *a, **k: {
            "listados": 1,
            "processos": 1,
            "no_escopo": 1,
            "itens_escopo": 1,
            "erros": 0,
            "paginacao_avisos": [],
        },
    )
    assert P.main(ARGS_BASE) == 0
    assert [f for f, _ in sb.rpcs] == [
        "coleta_externa_iniciar"
    ]  # sem id, não tenta fechar


def test_dry_run_nao_registra(monkeypatch):
    monkeypatch.setattr(P, "PortalParadigma", lambda *a, **k: MagicMock())
    monkeypatch.setattr(P, "coletar", lambda *a, **k: {"erros": 0, "no_escopo": 0})
    registros = []
    monkeypatch.setattr(
        P, "RegistroColeta", lambda *a, **k: registros.append(a) or MagicMock()
    )
    assert P.main([*ARGS_BASE, "--dry-run"]) == 0
    assert (
        registros and registros[0][0] is None
    )  # cliente nulo: RegistroColeta não grava


def test_registro_sem_cliente_nao_chama_nada():
    reg = P.RegistroColeta(None, "fiesc", "leads", ["academia"])
    reg.finalizar("concluida", {"erros": 0})
    assert reg.id is None


def test_disparo_manual_nao_registra(sb, monkeypatch):
    """Só a coleta agendada entra na saúde: fonte fora do lote rodada à mão não pode virar alerta eterno."""
    monkeypatch.setattr(
        P, "coletar", lambda *a, **k: {"erros": 0, "no_escopo": 1, "listados": 1}
    )
    argv = [a for a in ARGS_BASE if a not in ("--origem", "cron")]
    assert P.main([*argv, "--origem", "manual"]) == 0
    assert sb.rpcs == []


def test_paginacao_cortada_sem_erro_fecha_concluida_com_erros(sb, monkeypatch):
    monkeypatch.setattr(
        P,
        "coletar",
        lambda *a, **k: {
            "listados": 300,
            "processos": 3,
            "no_escopo": 1,
            "itens_escopo": 1,
            "erros": 0,
            "paginacao_avisos": ["teto de segurança atingido"],
        },
    )
    assert P.main(ARGS_BASE) == 0
    assert _finalizacao(sb)["p_status"] == "concluida_com_erros"


def test_bucket_ausente_fecha_falhou_e_propaga_system_exit(sb, monkeypatch):
    import coletor.destino as destino

    arm = MagicMock(dentro_do_saas=False)
    monkeypatch.setattr(destino.Armazenamento, "do_ambiente", staticmethod(lambda: arm))
    argv = [a for a in ARGS_BASE if a != "--sem-documentos"]
    with pytest.raises(SystemExit):
        P.main(argv)
    fim = _finalizacao(sb)
    assert fim["p_status"] == "falhou" and fim["p_erros"] == 1
    assert "SUPABASE_STORAGE_BUCKET" in fim["p_detalhe_erros"]["erro"]


def test_interrupcao_fecha_cancelada(sb, monkeypatch):
    def interrompe(*a, **k):
        raise KeyboardInterrupt

    monkeypatch.setattr(P, "coletar", interrompe)
    with pytest.raises(KeyboardInterrupt):
        P.main(ARGS_BASE)
    assert _finalizacao(sb)["p_status"] == "cancelada"


@pytest.mark.parametrize(
    ("anos", "processos", "esperado"),
    [
        (None, None, "leads"),
        ([2024], None, "historico"),
        (None, [(32, 18)], "monitorar"),
    ],
)
def test_modo_registro(anos, processos, esperado):
    assert P.modo_registro(anos, processos) == esperado


@pytest.mark.parametrize(
    ("texto", "esperado"),
    [
        (
            "Authorization: Bearer abc.def-123 falhou",
            "Authorization: Bearer *** falhou",
        ),
        ("chave eyJhbGciOi.eyJzdWIi.assinatura no erro", "chave *** no erro"),
        (
            "GET https://x.invalid/a?apikey=segredo&b=1",
            "GET https://x.invalid/a?apikey=***&b=1",
        ),
        ("fiergs: HTTP 403", "fiergs: HTTP 403"),
    ],
)
def test_mascarar_segredos(texto, esperado):
    assert P.mascarar_segredos(texto) == esperado


def test_sigterm_no_meio_da_coleta_fecha_incompleta_com_o_parcial(sb, monkeypatch):
    """12/11/2026: no limite da etapa (timeout interno do workflow) o coletor recebe SIGTERM. O que já foi gravado
    conta: o registro fecha como `incompleta`, com os contadores até ali, e não como `falhou` zerado."""
    import signal as sinal

    def coleta_cortada(*a, resumo=None, **k):
        resumo.update({"listados": 40, "processos": 12, "no_escopo": 5, "erros": 0})
        sinal.raise_signal(sinal.SIGTERM)  # no Windows, os.kill(SIGTERM) mataria o pytest
        raise AssertionError("o SIGTERM devia ter interrompido a coleta")

    monkeypatch.setattr(P, "coletar", coleta_cortada)
    anterior = sinal.getsignal(sinal.SIGTERM)
    with pytest.raises(SystemExit) as saida:
        P.main(ARGS_BASE)
    assert saida.value.code == 143
    fim = _finalizacao(sb)
    assert fim["p_status"] == "incompleta"
    assert (fim["p_listados"], fim["p_processos"], fim["p_no_escopo"]) == (40, 12, 5)
    assert "SIGTERM" in fim["p_detalhe_erros"]["erro"]
    assert sinal.getsignal(sinal.SIGTERM) is anterior
