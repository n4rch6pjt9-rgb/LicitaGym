"""Coletor Compras.gov ARP (Atas de Registro de Preço).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-arp/2_consultarARPItem
    ?dataVigenciaInicialMin={YYYY-MM-DD}&dataVigenciaInicialMax={YYYY-MM-DD}&codigoPdm={pdm}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Filtra por PDMs do escopo de produtos fitness.
Grava em public.atas_rp_itens via PostgREST (upsert idempotente em (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item)).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .compras_pdms import CatalogoPdmsIndisponivel, carregar_pdms_efetivos
from .destino import Supabase, env
from .retry import espera_retry

log = logging.getLogger("coletor.compras_arp")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-arp/2_consultarARPItem"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

PDMS_PADRAO = [2640, 2638, 7113, 3522, 5341, 8166, 18481, 10779]


def normalizar_ata_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """Mapeia item retornado pela API ARP para o schema da tabela public.atas_rp_itens."""
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

    num_ata = str(item.get("numeroAtaRegistroPreco") or "").strip()
    cod_unidade = _int(item.get("codigoUnidadeGerenciadora"))
    num_item = str(item.get("numeroItem") or "").strip()
    if not num_ata or cod_unidade is None or not num_item:
        return None

    raw_str = json.dumps(item, sort_keys=True, ensure_ascii=False)
    p_hash = hashlib.sha256(raw_str.encode("utf-8")).hexdigest()

    return {
        "numero_ata_registro_preco": num_ata,
        "codigo_unidade_gerenciadora": cod_unidade,
        "nome_unidade_gerenciadora": item.get("nomeUnidadeGerenciadora"),
        "numero_compra": str(item.get("numeroCompra") or "") or None,
        "ano_compra": _int(item.get("anoCompra")),
        "codigo_modalidade_compra": str(item.get("codigoModalidadeCompra") or "") or None,
        "nome_modalidade_compra": item.get("nomeModalidadeCompra"),
        "data_assinatura": item.get("dataAssinatura"),
        "data_vigencia_inicial": _date(item.get("dataVigenciaInicial")),
        "data_vigencia_final": _date(item.get("dataVigenciaFinal")),
        "numero_item": num_item,
        "codigo_item": _int(item.get("codigoItem")),
        "codigo_pdm": str(item.get("codigoPdm") or "") or None,
        "nome_pdm": item.get("nomePdm"),
        "descricao_item": item.get("descricaoItem"),
        "tipo_item": item.get("tipoItem"),
        "quantidade_homologada_item": _num(item.get("quantidadeHomologadaItem")),
        "classificacao_fornecedor": str(item.get("classificacaoFornecedor") or "") or None,
        "ni_fornecedor": str(item.get("niFornecedor") or "").strip() or None,
        "nome_fornecedor": item.get("nomeRazaoSocialFornecedor"),
        "marca": item.get("marca"),
        "fabricante": item.get("fabricante"),
        "modelo": item.get("modelo"),
        "quantidade_homologada_vencedor": _num(item.get("quantidadeHomologadaVencedor")),
        "valor_unitario": _num(item.get("valorUnitario")),
        "valor_total": _num(item.get("valorTotal")),
        "maximo_adesao": _num(item.get("maximoAdesao")),
        "quantidade_empenhada": _num(item.get("quantidadeEmpenhada")),
        "percentual_maior_desconto": _num(item.get("percentualMaiorDesconto")),
        "id_compra": str(item.get("idCompra") or "") or None,
        "numero_controle_pncp_compra": item.get("numeroControlePncpCompra"),
        "numero_controle_pncp_ata": item.get("numeroControlePncpAta"),
        "raw": item,
        "payload_hash": p_hash,
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
    }


class ClienteComprasARP:
    def __init__(self, delay: float = 1.0, timeout: int = 90, sessao: requests.Session | None = None):
        self.delay = max(1.0, delay)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def consultar_itens_pdm(
        self,
        codigo_pdm: int,
        data_min: str,
        data_max: str,
        pagina: int = 1,
        tamanho_pagina: int = 50,
    ) -> dict[str, Any]:
        url = f"{BASE_URL}{ENDPOINT}"
        params = {
            "dataVigenciaInicialMin": data_min,
            "dataVigenciaInicialMax": data_max,
            "codigoPdm": codigo_pdm,
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
                        raise RuntimeError(f"HTTP {r.status_code} esgotado em ARP PDM {codigo_pdm}")
                    espera = espera_retry(r, tentativa, base=4.0)
                    log.warning("HTTP %d em ARP PDM %d (tentativa %d), aguardando %.1fs...", r.status_code, codigo_pdm, tentativa, espera)
                    time.sleep(espera)
                    continue
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("Falha de rede em ARP PDM %d tentativa %d: %s", codigo_pdm, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(espera_retry(None, tentativa, base=3.0))
        raise RuntimeError(f"Falha ao consultar ARP PDM {codigo_pdm} após retries")


def coletar(
    cliente: ClienteComprasARP,
    sb: Supabase | None,
    pdms: list[int],
    data_min: str,
    data_max: str,
    limite: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    total_coletados = 0
    total_gravados = 0
    erros = 0
    amostras = []

    for pdm in pdms:
        pagina = 1
        while True:
            log.info("Consultando ARP PDM %d (%s a %s) pagina %d...", pdm, data_min, data_max, pagina)
            try:
                resp = cliente.consultar_itens_pdm(pdm, data_min=data_min, data_max=data_max, pagina=pagina, tamanho_pagina=50)
            except Exception as e:
                log.error("Erro ao consultar ARP PDM %d pagina %d: %s", pdm, pagina, e)
                erros += 1
                break

            items_raw = resp.get("resultado") or []
            if not items_raw:
                break

            linhas_norm = []
            for it in items_raw:
                norm = normalizar_ata_item(it)
                if norm:
                    linhas_norm.append(norm)
                    total_coletados += 1
                    if len(amostras) < 5:
                        amostras.append({
                            "ata": norm["numero_ata_registro_preco"],
                            "uasg": norm["codigo_unidade_gerenciadora"],
                            "item": norm["codigo_item"],
                            "pdm": norm["codigo_pdm"],
                            "fornecedor": norm["nome_fornecedor"],
                            "valor_unitario": norm["valor_unitario"],
                            "vigencia_fim": norm["data_vigencia_final"],
                        })

            if not dry_run and sb is not None and linhas_norm:
                try:
                    conflito = "numero_ata_registro_preco,codigo_unidade_gerenciadora,numero_item"
                    sb.upsert("atas_rp_itens", linhas_norm, conflito=conflito)
                    total_gravados += len(linhas_norm)
                except Exception as e:
                    log.error("Erro no upsert de %d linhas de atas: %s", len(linhas_norm), e)
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
            if pagina * 50 >= total_regs or len(items_raw) < 50:
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
    ap = argparse.ArgumentParser(description="Coletor Compras.gov ARP (Atas de Registro de Preço)")
    ap.add_argument("--pdms", help="Códigos PDM separados por vírgula")
    ap.add_argument("--data-min", help="Data início vigência inicial (YYYY-MM-DD)", default=None)
    ap.add_argument("--data-max", help="Data fim vigência inicial (YYYY-MM-DD)", default=None)
    ap.add_argument("--limite", type=int, help="Teto de itens a processar")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay mínimo em segundos entre requisições (mínimo 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="Não grava no banco; mostra resumo e amostras")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    pdms = [int(p.strip()) for p in args.pdms.split(",") if p.strip()] if args.pdms else PDMS_PADRAO
    ano_atual = datetime.now().year
    data_min = args.data_min or f"{ano_atual}-01-01"
    data_max = args.data_max or f"{ano_atual}-12-31"

    cliente = ClienteComprasARP(delay=args.delay)
    sb = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))

    pdms_finais = pdms
    if not args.pdms and sb is not None:
        # Com banco, a lista vem só do catálogo efetivo: falha da RPC encerra o job com erro (sem PDMS_PADRAO).
        try:
            pdms_finais = carregar_pdms_efetivos(sb)
        except CatalogoPdmsIndisponivel as e:
            log.error("Coleta ARP abortada: %s", e)
            print(json.dumps({"sucesso": False, "erro": str(e), "total_coletados": 0, "total_gravados": 0,
                              "erros": 1, "amostras": []}, indent=2, ensure_ascii=False))
            return 1
        if not pdms_finais:
            log.warning("Catálogo de PDMs efetivos vazio: coleta ARP sem consultas")

    res = coletar(cliente, sb, pdms=pdms_finais, data_min=data_min, data_max=data_max, limite=args.limite, dry_run=args.dry_run)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["sucesso"] else 1


if __name__ == "__main__":
    sys.exit(main())
