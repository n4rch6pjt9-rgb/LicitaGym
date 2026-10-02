"""Coletor Compras.gov Pesquisa de Preço (preços efetivamente homologados).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial
    ?tipo=codigoPdm&codigo={codigo_pdm}&pagina={pagina}&tamanhoPagina={tamanhoPagina}
  ou
    ?tipo=codigoItemCatalogo&codigo={codigo_item}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Enriquecimento opcional (detalhes):
  GET https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/2_consultarMaterialDetalhe
    ?codigoItemCatalogo={codigo_item}&pagina=1&tamanhoPagina=100

Grava em public.precos_praticados_itens via PostgREST (upsert idempotente em (id_compra, id_item_compra)).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from typing import Any

import requests

from .destino import Supabase, env

log = logging.getLogger("coletor.compras_precos")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT_MATERIAL = "/modulo-pesquisa-preco/1_consultarMaterial"
ENDPOINT_DETALHE = "/modulo-pesquisa-preco/2_consultarMaterialDetalhe"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"
MAX_RETRY_AFTER_S = 60

# PDMs mais frequentes do catálogo fitness (ex.: 2640 aparelhos musculação, 2638 acessórios)
PDMS_PADRAO = [2640, 2638, 7113, 3522, 5341, 8166, 18481, 10779]


def _calcular_espera_retry(tentativa: int, response: requests.Response) -> float:
    retry_after = (response.headers or {}).get("Retry-After")
    if retry_after:
        try:
            espera = float(retry_after)
        except (TypeError, ValueError):
            try:
                data_retry = parsedate_to_datetime(retry_after)
                if data_retry.tzinfo is None:
                    data_retry = data_retry.replace(tzinfo=timezone.utc)
                espera = (data_retry - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                espera = None
        if espera is not None:
            return max(0.0, min(espera, MAX_RETRY_AFTER_S))
    return tentativa * 3.0


def normalizar_preco_praticado(item: dict[str, Any]) -> dict[str, Any] | None:
    """Mapeia item retornado pelo endpoint de pesquisa de preço para a tabela public.precos_praticados_itens."""
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

    id_compra = str(item.get("idCompra") or "").strip()
    id_item_compra = _int(item.get("idItemCompra"))
    if not id_compra or id_item_compra is None:
        return None

    raw_str = json.dumps(item, sort_keys=True, ensure_ascii=False)
    p_hash = hashlib.sha256(raw_str.encode("utf-8")).hexdigest()

    return {
        "id_compra": id_compra,
        "id_item_compra": id_item_compra,
        "numero_item_compra": _int(item.get("numeroItemCompra")),
        "codigo_item_catalogo": _int(item.get("codigoItemCatalogo")),
        "data_compra": _date(item.get("dataCompra")),
        "forma": item.get("forma"),
        "modalidade": _int(item.get("modalidade")),
        "criterio_julgamento": item.get("criterioJulgamento"),
        "objeto_compra": item.get("objetoCompra"),
        "data_hora_atualizacao_compra": item.get("dataHoraAtualizacaoCompra"),
        "quantidade": _num(item.get("quantidade")),
        "preco_unitario": _num(item.get("precoUnitario")),
        "percentual_maior_desconto": _num(item.get("percentualMaiorDesconto")),
        "descricao_item": item.get("descricaoItem"),
        "descricao_detalhada_item": item.get("descricaoDetalhadaItem"),
        "marca": item.get("marca"),
        "fabricante": item.get("fabricante"),
        "modelo": item.get("modelo"),
        "data_resultado": _date(item.get("dataResultado")),
        "data_hora_atualizacao_item": item.get("dataHoraAtualizacaoItem"),
        "sigla_unidade_fornecimento": item.get("siglaUnidadeFornecimento"),
        "nome_unidade_fornecimento": item.get("nomeUnidadeFornecimento"),
        "capacidade_unidade_fornecimento": _num(item.get("capacidadeUnidadeFornecimento")),
        "sigla_unidade_medida": item.get("siglaUnidadeMedida"),
        "nome_unidade_medida": item.get("nomeUnidadeMedida"),
        "ni_fornecedor": str(item.get("niFornecedor") or "").strip() or None,
        "nome_fornecedor": item.get("nomeFornecedor"),
        "codigo_uasg": str(item.get("codigoUasg") or "").strip() or None,
        "nome_uasg": item.get("nomeUasg"),
        "codigo_orgao": _int(item.get("codigoOrgao")),
        "nome_orgao": item.get("nomeOrgao"),
        "estado": item.get("estado"),
        "codigo_municipio": _int(item.get("codigoMunicipio")),
        "municipio": item.get("municipio"),
        "poder": item.get("poder"),
        "esfera": item.get("esfera"),
        "data_hora_atualizacao_uasg": item.get("dataHoraAtualizacaoUasg"),
        "codigo_classe": _int(item.get("codigoClasse")),
        "nome_classe": item.get("nomeClasse"),
        "codigo_pdm": str(item.get("codigoPdm") or "") or None,
        "nome_pdm": item.get("nomePdm"),
        "id_compra_item": str(item.get("idCompraItem") or "") or None,
        "data_atualizacao_fato": item.get("dataAtualizacaoFato"),
        "raw": item,
        "payload_hash": p_hash,
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
    }


class ClienteComprasPrecos:
    def __init__(self, delay: float = 1.0, timeout: int = 60, sessao: requests.Session | None = None):
        self.delay = max(1.0, delay)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def consultar_material(self, tipo: str, codigo: int, pagina: int = 1, tamanho_pagina: int = 100) -> dict[str, Any]:
        """tipo deve ser 'codigoPdm' ou 'codigoItemCatalogo'."""
        url = f"{BASE_URL}{ENDPOINT_MATERIAL}"
        params = {
            "tipo": tipo,
            "codigo": codigo,
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
                    espera = _calcular_espera_retry(tentativa, r)
                    log.warning("HTTP %d em Pesquisa Preco %s=%d (tentativa %d), aguardando %.1fs...", r.status_code, tipo, codigo, tentativa, espera)
                    if tentativa == 3:
                        raise RuntimeError(f"HTTP {r.status_code} esgotado em Pesquisa Preco {tipo}={codigo}")
                    time.sleep(espera)
                    continue
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("Falha de rede em Pesquisa Preco %s=%d tentativa %d: %s", tipo, codigo, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(tentativa * 2.0)
        raise RuntimeError(f"Falha ao consultar Pesquisa Preco {tipo}={codigo} após retries")


def coletar(
    cliente: ClienteComprasPrecos,
    sb: Supabase | None,
    pdms: list[int] | None = None,
    itens: list[int] | None = None,
    limite: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    total_coletados = 0
    total_gravados = 0
    erros = 0
    amostras = []

    consultas: list[tuple[str, int]] = []
    if itens:
        for it in itens:
            consultas.append(("codigoItemCatalogo", it))
    if pdms:
        for p in pdms:
            consultas.append(("codigoPdm", p))
    if not consultas:
        pdms_efetivos = None
        if sb is not None:
            try:
                res_rpc = sb.rpc("catalogo_catmat_pdms_efetivos", {})
                if res_rpc and isinstance(res_rpc, list):
                    pdms_efetivos = [int(r["codigo_pdm"]) for r in res_rpc if r.get("codigo_pdm")]
                    log.info("Carregados %d PDMs efetivos do catálogo da empresa via RPC", len(pdms_efetivos))
            except Exception as e:
                log.warning("Não foi possível carregar catalogo_catmat_pdms_efetivos (fallback para PDMs padrão): %s", e)
        for p in (pdms_efetivos or PDMS_PADRAO):
            consultas.append(("codigoPdm", p))

    for tipo, cod in consultas:
        pagina = 1
        while True:
            log.info("Consultando Pesquisa Preco %s=%d pagina %d...", tipo, cod, pagina)
            try:
                resp = cliente.consultar_material(tipo, cod, pagina=pagina, tamanho_pagina=100)
            except Exception as e:
                log.error("Erro ao consultar %s=%d pagina %d: %s", tipo, cod, pagina, e)
                erros += 1
                break

            items_raw = resp.get("resultado") or []
            if not items_raw:
                break

            linhas_norm = []
            for it in items_raw:
                norm = normalizar_preco_praticado(it)
                if norm:
                    linhas_norm.append(norm)
                    total_coletados += 1
                    if len(amostras) < 5:
                        amostras.append({
                            "id_compra": norm["id_compra"],
                            "item": norm["codigo_item_catalogo"],
                            "pdm": norm["codigo_pdm"],
                            "fornecedor": norm["nome_fornecedor"],
                            "marca": norm["marca"],
                            "preco_unitario": norm["preco_unitario"],
                            "data_resultado": norm["data_resultado"],
                        })

            if not dry_run and sb is not None and linhas_norm:
                try:
                    conflito = "id_compra,id_item_compra"
                    sb.upsert("precos_praticados_itens", linhas_norm, conflito=conflito)
                    total_gravados += len(linhas_norm)
                except Exception as e:
                    log.error("Erro no upsert de %d linhas de precos: %s", len(linhas_norm), e)
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
            if pagina * 100 >= total_regs or len(items_raw) < 100:
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
    ap = argparse.ArgumentParser(description="Coletor Compras.gov Pesquisa de Preço (preços praticados)")
    ap.add_argument("--pdms", help="Códigos PDM separados por vírgula")
    ap.add_argument("--itens", help="Códigos CATMAT item separados por vírgula")
    ap.add_argument("--limite", type=int, help="Teto de itens a processar")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay mínimo em segundos entre requisições (mínimo 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="Não grava no banco; mostra resumo e amostras")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    pdms = [int(p.strip()) for p in args.pdms.split(",") if p.strip()] if args.pdms else None
    itens = [int(i.strip()) for i in args.itens.split(",") if i.strip()] if args.itens else None

    cliente = ClienteComprasPrecos(delay=args.delay)
    sb = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))

    res = coletar(cliente, sb, pdms=pdms, itens=itens, limite=args.limite, dry_run=args.dry_run)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["sucesso"] else 1


if __name__ == "__main__":
    sys.exit(main())
