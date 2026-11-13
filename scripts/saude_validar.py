#!/usr/bin/env python3
"""Valida o contrato de api-saude antes de renderizar dados ou normalizar incidentes."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys

ESTADOS = {"ok": 0, "atencao": 1, "critico": 2}


def validar(resumo, agora=None, max_minutos=90, esperadas=()):
    agora = agora or datetime.now(timezone.utc)
    if max_minutos <= 0:
        raise ValueError("Tolerância inválida")
    if not isinstance(resumo, dict) or resumo.get("action") != "resumo":
        raise ValueError("Envelope inválido")
    try:
        gerado = datetime.fromisoformat(resumo["gerado_em"].replace("Z", "+00:00"))
    except (KeyError, AttributeError, ValueError, TypeError) as exc:
        raise ValueError("Data inválida") from exc
    if gerado.tzinfo is None or gerado > agora + timedelta(minutes=5):
        raise ValueError("Data sem fuso ou futura")
    if agora - gerado > timedelta(minutes=max_minutos):
        raise ValueError("Resumo desatualizado")
    verificacoes = resumo.get("verificacoes")
    if not isinstance(verificacoes, list) or not verificacoes:
        raise ValueError("Resumo sem verificações")
    contagem = dict.fromkeys(ESTADOS, 0)
    codigos = set()
    for v in verificacoes:
        if not isinstance(v, dict):
            raise ValueError("Verificação inválida")
        codigo, estado = v.get("verificacao"), v.get("status")
        if not isinstance(codigo, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,99}", codigo):
            raise ValueError("Identificador inválido")
        if codigo in codigos or not isinstance(estado, str) or estado not in ESTADOS:
            raise ValueError("Identificador duplicado ou estado inválido")
        if not isinstance(v.get("mensagem"), str):
            raise ValueError("Mensagem inválida")
        codigos.add(codigo)
        contagem[estado] += 1
    if set(esperadas) - codigos:
        raise ValueError("Cobertura incompleta")
    if resumo.get("contagem") != contagem:
        raise ValueError("Contagem inconsistente")
    pior = max(contagem, key=lambda s: ESTADOS[s] if contagem[s] else -1)
    if resumo.get("status_geral") != pior:
        raise ValueError("Estado geral inconsistente")
    # O consumidor não precisa de detalhe, que pode conter mensagens internas de origem.
    return {"action": "resumo", "gerado_em": gerado.isoformat(), "contagem": contagem,
            "status_geral": pior, "verificacoes": [
                {"verificacao": v["verificacao"], "status": v["status"],
                 "mensagem": " ".join(v["mensagem"].replace("|", "/").split())[:500]}
                for v in verificacoes]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arquivo", type=Path)
    parser.add_argument("--max-minutos", type=int, default=90)
    parser.add_argument("--esperadas", default="")
    args = parser.parse_args()
    try:
        resultado = validar(json.loads(args.arquivo.read_text(encoding="utf-8")),
                            max_minutos=args.max_minutos,
                            esperadas=filter(None, args.esperadas.split(",")))
    except (ValueError, OSError, UnicodeError):
        # Não refletir payload ou caminhos potencialmente sensíveis no incidente público.
        print("Resumo de saúde inválido, incompleto ou desatualizado.", file=sys.stderr)
        return 1
    print(json.dumps(resultado, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
