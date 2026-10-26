#!/usr/bin/env python3
"""Observador somente leitura. Não executa jobs, não altera dados e não envia mensagens."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

REPO = "n4rch6pjt9-rgb/LicitaGym"
PROJECT = "licitagym"
REGION = "southamerica-east1"


def instante(value):
    if not isinstance(value, str):
        raise ValueError("Data ausente")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Data sem fuso")
    return result


def verificacao(codigo, status, mensagem, **dados):
    return {"verificacao": codigo, "status": status, "mensagem": mensagem, "evidencia": dados}


def github_execucao(payload, agora, max_minutos=90):
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not isinstance(runs, list) or not runs:
        return verificacao("monitor_github", "atencao", "Nenhuma execução observada; saúde não verificada.")
    # Só execuções agendadas da main comprovam a rotina. Um disparo manual não mascara cron parado.
    agendadas = [r for r in runs if r.get("event") == "schedule" and r.get("head_branch") == "main"]
    if not agendadas:
        return verificacao("monitor_github", "atencao", "Nenhuma execução agendada observada.")
    run = max(agendadas, key=lambda r: instante(r.get("created_at")))
    idade = (agora - instante(run.get("created_at"))).total_seconds() / 60
    if idade < -5:
        raise ValueError("Data futura")
    evidence = {"run_id": run.get("id"), "idade_minutos": round(idade, 1),
                "conclusao": run.get("conclusion"), "estado": run.get("status")}
    if idade > max_minutos:
        return verificacao("monitor_github", "critico", "Monitor sem execução recente na janela configurada.", **evidence)
    if run.get("status") != "completed":
        return verificacao("monitor_github", "atencao", "Execução ainda não concluída; resultado não confirmado.", **evidence)
    if run.get("conclusion") != "success":
        return verificacao("monitor_github", "critico", "Última execução agendada não concluiu com sucesso.", **evidence)
    return verificacao("monitor_github", "ok", "Execução agendada concluída; completude dos conectores é avaliada separadamente.", **evidence)


def cloud_execucao(job, payload, agora, max_minutos=None):
    runs = payload.get("executions") if isinstance(payload, dict) else None
    codigo = "cloud_run_" + job.replace("-", "_")
    if not isinstance(runs, list) or not runs:
        return verificacao(codigo, "atencao", "Nenhuma execução observada; saúde não verificada.")
    run = max(runs, key=lambda r: instante(r.get("createTime")))
    idade = (agora - instante(run.get("createTime"))).total_seconds() / 60
    if idade < -5:
        raise ValueError("Data futura")
    evidence = {"execucao": run.get("name", "").split("/")[-1], "idade_minutos": round(idade, 1),
                "completude_dados": "nao_verificada"}
    if max_minutos is not None and idade > max_minutos:
        return verificacao(codigo, "critico", "Sem execução recente na janela configurada.", **evidence)
    if run.get("failedCount", 0) or run.get("cancelledCount", 0):
        return verificacao(codigo, "critico", "Execução contém tarefas falhas ou canceladas.", **evidence)
    # Contagens não bastam se o controlador ainda reconcilia a execução.
    if run.get("reconciling") or not run.get("completionTime"):
        return verificacao(codigo, "atencao", "Execução ainda não concluída.", **evidence)
    tasks, succeeded = run.get("taskCount"), run.get("succeededCount")
    if type(tasks) is not int or tasks <= 0 or type(succeeded) is not int or succeeded != tasks:
        return verificacao(codigo, "atencao", "Conclusão sem contagem de sucesso integral comprovada.", **evidence)
    return verificacao(codigo, "ok", "Tarefas concluídas; processamento de dados não comprovado por esse sinal.", **evidence)


def http(url, headers=None):
    req = Request(url, headers={"User-Agent": "LicitaGym-Sentinela/1.0", **(headers or {})})
    with urlopen(req, timeout=20) as response:
        body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError("Resposta excede limite")
        return response.status, body


def pncp_consulta(status, body):
    if status == 204:
        return verificacao("pncp_consulta", "ok", "Consulta respondeu sem conteúdo; não comprova cobertura dos syncs.", http=status)
    if status != 200:
        return verificacao("pncp_consulta", "atencao", "Falha nesta sonda de consulta; confirmar persistência antes de declarar incidente.", http=status)
    obj = json.loads(body)
    if not isinstance(obj, dict) or not isinstance(obj.get("data"), list):
        raise ValueError("Envelope PNCP inválido")
    return verificacao("pncp_consulta", "ok", "Sonda recebeu envelope válido; downloads de documentos não foram testados.", http=200)


def seguro(codigo, executar):
    try:
        return executar()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Não exportar URLs assinadas, tokens, corpo de erro ou mensagens de provedores.
        return verificacao(codigo, "atencao", "Observação indisponível ou inválida; saúde não verificada.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github", action="store_true")
    parser.add_argument("--cloud-run", action="store_true")
    parser.add_argument("--pncp", action="store_true")
    parser.add_argument("--status-licitacoes", action="store_true")
    parser.add_argument("--max-minutos", type=int, default=90, help="Tolerância proposta para monitor e triagem, não SLA homologado")
    args = parser.parse_args()
    if args.max_minutos <= 0:
        parser.error("Tolerância deve ser positiva")
    if not any((args.github, args.cloud_run, args.pncp, args.status_licitacoes)):
        parser.error("Selecione ao menos uma fonte")
    agora = datetime.now(timezone.utc)
    checks = []
    if args.github:
        def consultar_github():
            headers = {"Accept": "application/vnd.github+json"}
            if os.environ.get("GH_TOKEN"):
                headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
            url = f"https://api.github.com/repos/{REPO}/actions/workflows/saude.yml/runs?event=schedule&branch=main&per_page=5"
            _, body = http(url, headers)
            return github_execucao(json.loads(body), agora, args.max_minutos)
        checks.append(seguro("monitor_github", consultar_github))
    if args.cloud_run:
        # gcloud usa a identidade do ambiente (ADC/conta autorizada); nenhuma chave de SA em arquivo.
        def token_gcp():
            return subprocess.run(["gcloud", "auth", "print-access-token"], check=True, capture_output=True,
                                  text=True, timeout=20).stdout.strip()
        token = None
        try:
            token = token_gcp()
        except (OSError, subprocess.SubprocessError):
            pass
        for job in ("preparar-triagem", "coletor-precos"):
            def consultar_job(job=job):
                if not token:
                    raise ValueError("Identidade indisponível")
                url = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}/jobs/{job}/executions?pageSize=5"
                _, body = http(url, {"Authorization": "Bearer " + token})
                # Preços não tem periodicidade confirmada; não inventar atraso para esse job.
                return cloud_execucao(job, json.loads(body), agora,
                                      args.max_minutos if job == "preparar-triagem" else None)
            checks.append(seguro("cloud_run_" + job.replace("-", "_"), consultar_job))
        token = None
    if args.pncp:
        def consultar_pncp():
            query = urlencode({"dataFinal": (agora + timedelta(days=30)).strftime("%Y%m%d"),
                               "pagina": 1, "tamanhoPagina": 10})
            try:
                status, body = http("https://pncp.gov.br/api/consulta/v1/contratacoes/proposta?" + query)
            except HTTPError as exc:
                status, body = exc.code, b""
            return pncp_consulta(status, body)
        checks.append(seguro("pncp_consulta", consultar_pncp))
    if args.status_licitacoes:
        def consultar_status():
            status, _ = http("https://statuslicitacoes.com.br/api-pncp")
            # Página sem contrato de atualização validado: não inferir saúde do PNCP pelo HTML.
            return verificacao("status_licitacoes", "atencao", "Página acessível; atualização e estado anunciado não verificados. Sinal secundário.", http=status)
        checks.append(seguro("status_licitacoes", consultar_status))
    print(json.dumps({"gerado_em": agora.isoformat(), "modo": "observacao", "verificacoes": checks}, ensure_ascii=False))
    return 1 if any(c["status"] == "critico" for c in checks) else 2 if any(c["status"] == "atencao" for c in checks) else 0


if __name__ == "__main__":
    sys.exit(main())
