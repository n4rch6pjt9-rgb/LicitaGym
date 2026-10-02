"""Coletor Compras.gov PGC (Plano de Contratações Anual).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-pgc/2_consultarPgcDetalheCatalogo
    ?anoPcaProjetoCompra={ano}&tipo=Material&codigo={codigo_classe}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Filtra por classes do escopo (7830 núcleo fitness, 7220 pisos).
Grava em public.pca_pgc_itens via PostgREST (upsert idempotente).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import requests

from .destino import Supabase, env

log = logging.getLogger("coletor.compras_pgc")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-pgc/2_consultarPgcDetalheCatalogo"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

CLASSES_PADRAO = [7830, 7220]


def _calcular_espera_retry(tentativa: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            espera = float(retry_after)
        except ValueError:
            try:
                data_retry = parsedate_to_datetime(retry_after)
                if data_retry.tzinfo is None:
                    data_retry = data_retry.replace(tzinfo=timezone.utc)
                espera = (data_retry - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                espera = float("nan")
        if math.isfinite(espera):
            return min(60.0, max(0.0, espera))

    backoff = min(60.0, 2 ** (tentativa - 1))
    return random.uniform(backoff / 2, backoff)


def normalizar_registro_pgc(item: dict[str, Any], ano_contexto: int | None = None) -> dict[str, Any] | None:
    """Mapeia item retornado pela API para o schema da tabela public.pca_pgc_itens.
    Se o ano do PCA não estiver presente no item nem for fornecido no contexto,
    retorna None para não fabricar ano fictício e evitar contaminação do radar."""
    def _int(val: Any) -> int | None:
        if val in (None, ""):
            return None
        try:
            return int(val)
        except (ValueError, TypeError):
            return None

    def _num(val: Any) -> float | None:
        if val in (None, ""):
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    def _date(val: Any) -> str | None:
        if not val or not isinstance(val, str):
            return None
        v = val.strip()
        if len(v) >= 10 and v[4] == "-" and v[7] == "-":
            return v[:10]
        return None

    raw_str = json.dumps(item, sort_keys=True, ensure_ascii=False)
    p_hash = hashlib.sha256(raw_str.encode("utf-8")).hexdigest()

    orgao_cnpj = str(item.get("orgao") or "").strip()
    codigo_uasg = str(item.get("codigoUasg") or "").strip()
    ano_pca = _int(item.get("anoPcaProjetoCompra")) or ano_contexto
    if not ano_pca:
        log.warning("Item PGC ignorado: anoPcaProjetoCompra ausente e sem ano_contexto")
        return None

    num_item_pncp = _int(item.get("numeroItemPncp"))
    cod_item_cat = _int(item.get("codigoItemCatalogo"))

    return {
        "codigo_uasg": codigo_uasg,
        "nome_uasg": item.get("nomeUasg"),
        "orgao_cnpj": orgao_cnpj,
        "numero_artefato": _int(item.get("numeroArtefato")),
        "ano_artefato": _int(item.get("anoArtefato")),
        "codigo_estado_artefato": _int(item.get("codigoEstadoArtefato")),
        "codigo_categoria_artefato": _int(item.get("codigoCategoriaArtefato")),
        "descricao_artefato": item.get("descricaoArtefato"),
        "codigo_tipo_artefato": _int(item.get("codigoTipoArtefato")),
        "ordem_dfd": _int(item.get("ordemDfd")),
        "descricao_objeto_dfd": item.get("descricaoObjetoDfd"),
        "nivel_prioridade_dfd": item.get("nivelPrioridadeDfd"),
        "data_prevista_formalizacao_demanda": _date(item.get("dataPrevistaFormalizacaoDemanda")),
        "codigo_area_dfd": _int(item.get("codigoAreaDfd")),
        "tipo_item": item.get("tipoItem"),
        "item_sustentavel": item.get("itemSustentavel"),
        "codigo_grupo_material": _int(item.get("codigoGrupoMaterial")),
        "nome_grupo_material": item.get("nomeGrupoMaterial"),
        "codigo_classe_material": _int(item.get("codigoClasseMaterial")),
        "nome_classe_material": item.get("nomeClasseMaterial"),
        "codigo_pdm_material": str(item.get("codigoPdmMaterial") or "") or None,
        "nome_pdm_material": item.get("nomePdmMaterial"),
        "codigo_item_catalogo": cod_item_cat,
        "descricao_item_catalogo": item.get("descricaoItemCatalogo"),
        "sigla_unidade_fornecimento": item.get("siglaUnidadeFornecimento"),
        "nome_unidade_fornecimento": item.get("nomeUnidadeFornecimento"),
        "quantidade_item": _num(item.get("quantidadeItem")),
        "valor_unitario_item": _num(item.get("valorUnitarioItem")),
        "valor_total_item": _num(item.get("valorTotalItem")),
        "titulo_projeto_compra": item.get("tituloProjetoCompra"),
        "descricao_projeto_compra": item.get("descricaoProjetoCompra"),
        "ano_pca_projeto_compra": ano_pca,
        "data_inicio_processo_compra": _date(item.get("dataInicioProcessoCompra")),
        "data_fim_processo_compra": _date(item.get("dataFimProcessoCompra")),
        "duracao_processo_compra": _int(item.get("duracaoProcessoCompra")),
        "numero_item_pncp": num_item_pncp,
        "status_contratacao_execucao": item.get("statusContratacaoExecucao"),
        "data_hora_publicacao_pncp": item.get("dataHoraPublicacaoPncp"),
        "data_hora_atualizacao_item": item.get("dataHoraAtualizacaoItem"),
        "raw": item,
        "payload_hash": p_hash,
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
    }


class ClienteComprasPGC:
    def __init__(self, delay: float = 1.0, timeout: int = 60, sessao: requests.Session | None = None):
        self.delay = max(1.0, delay)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def consultar_classe(self, classe: int, ano: int, pagina: int = 1, tamanho_pagina: int = 500) -> dict[str, Any]:
        url = f"{BASE_URL}{ENDPOINT}"
        params = {
            "anoPcaProjetoCompra": ano,
            "tipo": "Material",
            "codigo": classe,
            "pagina": pagina,
            "tamanhoPagina": min(500, max(10, tamanho_pagina)),
        }
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
                if r.status_code == 200:
                    return r.json()
                if r.status_code == 404:
                    return {"resultado": [], "totalRegistros": 0}
                if r.status_code in (429, 502, 503, 504):
                    if tentativa == 3:
                        raise RuntimeError(f"HTTP {r.status_code} esgotado em PGC classe {classe}")
                    retry_after = r.headers.get("Retry-After") if r.status_code == 429 else None
                    espera = _calcular_espera_retry(tentativa, retry_after)
                    log.warning("HTTP %d em PGC classe %d (tentativa %d), esperando %.1fs...", r.status_code, classe, tentativa, espera)
                    time.sleep(espera)
                    continue
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("Falha de rede em PGC classe %d tentativa %d: %s", classe, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(_calcular_espera_retry(tentativa))
        raise RuntimeError(f"Falha ao consultar PGC classe {classe} após retries")


def coletar(
    cliente: ClienteComprasPGC,
    sb: Supabase | None,
    classes: list[int],
    anos: list[int],
    limite: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    total_coletados = 0
    total_gravados = 0
    erros = 0
    amostras = []

    for ano in anos:
        for classe in classes:
            pagina = 1
            while True:
                log.info("Consultando PGC classe %d ano %d pagina %d...", classe, ano, pagina)
                try:
                    resp = cliente.consultar_classe(classe, ano, pagina=pagina, tamanho_pagina=500)
                except Exception as e:
                    log.error("Erro ao buscar classe %d ano %d pagina %d: %s", classe, ano, pagina, e)
                    erros += 1
                    break

                itens = resp.get("resultado") or []
                if not itens:
                    break

                linhas_norm = []
                for it in itens:
                    norm = normalizar_registro_pgc(it, ano_contexto=ano)
                    if norm and norm.get("orgao_cnpj") and norm.get("codigo_uasg"):
                        linhas_norm.append(norm)
                        total_coletados += 1
                        if len(amostras) < 5:
                            amostras.append({
                                "orgao": norm["orgao_cnpj"],
                                "uasg": norm["codigo_uasg"],
                                "item": norm["codigo_item_catalogo"],
                                "desc": (norm["descricao_item_catalogo"] or "")[:40],
                                "valor_total": norm["valor_total_item"],
                            })

                if not dry_run and sb is not None and linhas_norm:
                    try:
                        conflito = "orgao_cnpj,codigo_uasg,ano_pca_projeto_compra,numero_item_pncp,codigo_item_catalogo"
                        sb.upsert("pca_pgc_itens", linhas_norm, conflito=conflito)
                        total_gravados += len(linhas_norm)
                    except Exception as e:
                        log.error("Erro no upsert de %d linhas PGC: %s", len(linhas_norm), e)
                        erros += 1

                if limite and total_coletados >= limite:
                    log.info("Limite de %d itens atingido", limite)
                    return {
                        "sucesso": True,
                        "total_coletados": total_coletados,
                        "total_gravados": total_gravados,
                        "erros": erros,
                        "amostras": amostras,
                    }

                total_regs = resp.get("totalRegistros") or 0
                if pagina * 500 >= total_regs or len(itens) < 500:
                    break
                pagina += 1

    return {
        "sucesso": erros == 0,
        "total_coletados": total_coletados,
        "total_gravados": total_gravados,
        "erros": erros,
        "amostras": amostras,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Coletor Compras.gov PGC (PCA por classe)")
    ap.add_argument("--classes", help="Classes separadas por vírgula (padrão: 7830,7220)", default="7830,7220")
    ap.add_argument("--anos", help="Anos do PCA separados por vírgula (padrão: ano atual e seguinte)", default=None)
    ap.add_argument("--limite", type=int, help="Teto de itens a processar")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay mínimo em segundos entre requisições (mínimo 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="Não grava no banco; mostra resumo e amostras")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    classes = [int(c.strip()) for c in args.classes.split(",") if c.strip()]
    ano_atual = datetime.now().year
    if args.anos:
        anos = [int(a.strip()) for a in args.anos.split(",") if a.strip()]
    else:
        anos = [ano_atual, ano_atual + 1]

    cliente = ClienteComprasPGC(delay=args.delay)
    sb = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))

    res = coletar(cliente, sb, classes, anos, limite=args.limite, dry_run=args.dry_run)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["sucesso"] else 1


if __name__ == "__main__":
    sys.exit(main())
