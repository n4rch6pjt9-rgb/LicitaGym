"""Liga o CLI ao motor. Um host por vez, com a allowlist do manifesto."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .contrato import ContratoError, validar
from .motor import Limites, coletar
from .rede import HttpEducado
from .registro import obter


def slug_fornecedor(marca: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", marca.lower()).strip("-")


def executar_marca(marca: str, cfg: dict, *, intervalo: float, limites: Limites, saida, estado_path: str | None,
                   agora=None) -> dict:
    adaptador = obter(cfg["adaptador"])
    fornecedor = slug_fornecedor(marca)
    cliente = HttpEducado(list(cfg.get("hosts_permitidos") or []), intervalo=intervalo)
    estado = None
    if estado_path and Path(estado_path).exists():
        estado = json.loads(Path(estado_path).read_text(encoding="utf-8"))

    def salvar(atual: dict) -> None:
        if not estado_path:
            return
        destino = Path(estado_path)
        destino.parent.mkdir(parents=True, exist_ok=True)
        tmp = destino.with_suffix(destino.suffix + ".tmp")
        tmp.write_text(json.dumps(atual, ensure_ascii=False), encoding="utf-8")
        tmp.replace(destino)

    resultado = coletar(
        adaptador, cfg, cliente, marca=marca, fornecedor=fornecedor, limites=limites,
        agora=agora, estado=estado, ao_salvar=salvar if estado_path else None,
    )
    invalidos = 0
    for produto in resultado["produtos"]:
        try:
            validar(produto)
        except ContratoError as exc:
            invalidos += 1
            resultado["progresso"]["falhas"].append({"url": produto.get("url_canonica"), "erro": str(exc)})
            continue
        saida.write(json.dumps(produto, ensure_ascii=False) + "\n")
    if invalidos and resultado["status"] == "completa":
        resultado["status"] = "parcial"
        resultado["motivo"] = "contrato"
    return resultado
