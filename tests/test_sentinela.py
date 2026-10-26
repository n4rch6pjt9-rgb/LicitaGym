from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def modulo(nome):
    spec = importlib.util.spec_from_file_location(nome, ROOT / "scripts" / f"{nome}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


contrato = modulo("saude_validar")
observador = modulo("sentinela_observar")
AGORA = datetime(2026, 10, 26, 12, tzinfo=timezone.utc)


def resumo():
    return {"action": "resumo", "gerado_em": AGORA.isoformat(), "status_geral": "ok",
            "contagem": {"ok": 1, "atencao": 0, "critico": 0},
            "verificacoes": [{"verificacao": "fixture", "status": "ok", "mensagem": "Tudo certo",
                              "detalhe": {"privado": "nao_exportar"}}]}


class ContratoTest(unittest.TestCase):
    def test_valido_projeta_sem_detalhe(self):
        result = contrato.validar(resumo(), AGORA, esperadas=["fixture"])
        self.assertEqual(result["status_geral"], "ok")
        self.assertNotIn("nao_exportar", json.dumps(result))

    def test_vazio_invalido_e_cobertura_incompleta(self):
        invalidos = [None, [], {}, {**resumo(), "verificacoes": []},
                     {**resumo(), "status_geral": "critico"},
                     {**resumo(), "contagem": {"ok": 0, "atencao": 0, "critico": 0}}]
        for payload in invalidos:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                contrato.validar(payload, AGORA)
        with self.assertRaises(ValueError):
            contrato.validar(resumo(), AGORA, esperadas=["ausente"])

    def test_datas_e_limite(self):
        for data in ["ontem", None, "2026-10-26T12:00:00", (AGORA - timedelta(minutes=91)).isoformat(),
                     (AGORA + timedelta(minutes=6)).isoformat()]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                contrato.validar({**resumo(), "gerado_em": data}, AGORA)
        self.assertEqual(contrato.validar({**resumo(), "gerado_em": (AGORA - timedelta(minutes=90)).isoformat()}, AGORA)["status_geral"], "ok")

    def test_identificadores_e_estados(self):
        for field, value in [("status", "desconhecido"), ("verificacao", "a\nb"), ("status", [])]:
            payload = resumo()
            payload["verificacoes"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                contrato.validar(payload, AGORA)
        payload = resumo()
        payload["verificacoes"] *= 2
        with self.assertRaises(ValueError):
            contrato.validar(payload, AGORA)

    def test_critico_preservado_e_mensagem_segura(self):
        payload = resumo()
        payload["verificacoes"][0].update(status="critico", mensagem="linha | outra\nlinha")
        payload.update(status_geral="critico", contagem={"ok": 0, "atencao": 0, "critico": 1})
        result = contrato.validar(payload, AGORA)
        self.assertEqual(result["status_geral"], "critico")
        self.assertEqual(result["verificacoes"][0]["mensagem"], "linha / outra linha")


class ObservadorTest(unittest.TestCase):
    def github(self, **kwargs):
        return {"workflow_runs": [{"id": 42, "created_at": AGORA.isoformat(), "event": "schedule",
                                  "head_branch": "main", "status": "completed", "conclusion": "success", **kwargs}]}

    def cloud(self, **kwargs):
        return {"executions": [{"name": "projects/p/locations/r/jobs/j/executions/e", "createTime": AGORA.isoformat(),
                                "completionTime": AGORA.isoformat(), "taskCount": 1, "succeededCount": 1, **kwargs}]}

    def test_github_sucesso_e_falha(self):
        self.assertEqual(observador.github_execucao(self.github(), AGORA)["status"], "ok")
        self.assertEqual(observador.github_execucao(self.github(conclusion="failure"), AGORA)["status"], "critico")
        self.assertEqual(observador.github_execucao(self.github(status="in_progress", conclusion=None), AGORA)["status"], "atencao")

    def test_monitor_ausente_e_atraso(self):
        self.assertEqual(observador.github_execucao({}, AGORA)["status"], "atencao")
        self.assertEqual(observador.github_execucao(self.github(created_at=(AGORA - timedelta(hours=3)).isoformat()), AGORA)["status"], "critico")
        self.assertEqual(observador.github_execucao(self.github(event="workflow_dispatch"), AGORA)["status"], "atencao")

    def test_cloud_execucao_nao_prova_dados(self):
        result = observador.cloud_execucao("preparar-triagem", self.cloud(), AGORA, 90)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["evidencia"]["completude_dados"], "nao_verificada")
        self.assertEqual(observador.cloud_execucao("j", self.cloud(failedCount=1), AGORA)["status"], "critico")
        self.assertEqual(observador.cloud_execucao("j", self.cloud(reconciling=True), AGORA)["status"], "atencao")
        self.assertEqual(observador.cloud_execucao("j", self.cloud(taskCount=2), AGORA)["status"], "atencao")

    def test_precos_sem_agenda_nao_inventa_atraso(self):
        payload = self.cloud(createTime=(AGORA - timedelta(days=10)).isoformat())
        self.assertEqual(observador.cloud_execucao("coletor-precos", payload, AGORA)["status"], "ok")
        self.assertEqual(observador.cloud_execucao("preparar-triagem", payload, AGORA, 90)["status"], "critico")

    def test_pncp_200_html_204_e_422(self):
        self.assertEqual(observador.pncp_consulta(200, b'{"data":[]}')["status"], "ok")
        self.assertEqual(observador.pncp_consulta(204, b"")["status"], "ok")
        self.assertEqual(observador.pncp_consulta(422, b"")["status"], "atencao")
        for body in [b"<html></html>", b"{}", b'[]']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                observador.pncp_consulta(200, body)

    def test_erro_nao_expoe_corpo_ou_credencial(self):
        def falhar():
            raise ValueError("credencial_sintetica_nao_exportar")
        result = observador.seguro("fixture", falhar)
        self.assertEqual(result["status"], "atencao")
        self.assertNotIn("credencial_sintetica", json.dumps(result))


class AlertaShellTest(unittest.TestCase):
    def executar(self, payload, incidente=""):
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
        jq = shutil.which("jq.exe" if os.name == "nt" else "jq")
        if not bash or not jq:
            self.skipTest("bash e jq são necessários ao workflow")
        with tempfile.TemporaryDirectory() as tmp:
            arquivo = Path(tmp) / "resumo.json"
            arquivo.write_text(json.dumps(payload), encoding="utf-8")
            env = {**os.environ, "SAUDE_JSON": arquivo.as_posix(), "DRY_RUN": "1",
                   "DRY_ISSUE": incidente, "PYTHON_BIN": Path(sys.executable).as_posix()}
            return subprocess.run([bash, "scripts/saude-alerta.sh"], cwd=ROOT, env=env,
                                  capture_output=True, text=True, timeout=20)

    def atual(self, critico=False):
        payload = resumo()
        payload["gerado_em"] = datetime.now(timezone.utc).isoformat()
        if critico:
            payload["status_geral"] = "critico"
            payload["contagem"] = {"ok": 0, "atencao": 0, "critico": 1}
            payload["verificacoes"][0]["status"] = "critico"
        return payload

    def test_critico_registra_antes_de_sair_com_falha(self):
        result = self.executar(self.atual(True))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("DRY_RUN gh issue create", result.stdout)

    def test_vazio_nao_fecha_incidente(self):
        result = self.executar({}, "245\t<!-- fp:fixture -->")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("api_saude_contrato", result.stdout)
        self.assertNotIn("issue close", result.stdout)

    def test_recuperacao_valida_fecha_incidente(self):
        result = self.executar(self.atual(), "245\t<!-- fp:fixture -->")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY_RUN gh issue close", result.stdout)

    def test_mesmo_conjunto_nao_comenta_novamente(self):
        result = self.executar(self.atual(True), "245\t<!-- fp:fixture -->")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("issue edit", result.stdout)
        self.assertNotIn("issue comment", result.stdout)


if __name__ == "__main__":
    unittest.main()
