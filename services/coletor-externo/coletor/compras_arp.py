"""Coletor Compras.gov ARP (Atas de Registro de Preço).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-arp/2_consultarARPItem
    ?dataVigenciaInicialMin={YYYY-MM-DD}&dataVigenciaInicialMax={YYYY-MM-DD}&codigoPdm={pdm}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Filtra por PDMs do escopo de produtos fitness.
Grava em public.atas_rp_itens via PostgREST, upsert idempotente na chave natural
(numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor),
constraint uq_atas_rp_itens_lote_fornecedor (migration 20261003020000).

Campos reais do item de ARP (conferidos ao vivo em 02/10/2026 e no schema VwFtArpItemDTO do OpenAPI): não há
marca, fabricante, modelo nem lote/grupo. O fornecedor vem em niFornecedor + classificacaoFornecedor.
Parâmetros obrigatórios da API: dataVigenciaInicialMin e dataVigenciaInicialMax (sem eles a API responde 404).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .compras_api import ErroApiCompras, ParametroInvalido, corpo_json, erro_http, validar_codigo, validar_intervalo
from .compras_pdms import CatalogoPdmsIndisponivel, carregar_pdms_efetivos
from .destino import Supabase, env
from .retry import espera_retry

log = logging.getLogger("coletor.compras_arp")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-arp/2_consultarARPItem"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

# 7115 ESTEIRA ELÉTRICA concentra a maior parte dos preços de esteira; 7113 ESTEIRA ERGONOMICA segue ativo no catálogo.
PDMS_PADRAO = [2640, 2638, 7113, 7115, 3522, 5341, 8166, 18481, 10779]

# Chave natural do item de ata (= colunas de uq_atas_rp_itens_lote_fornecedor). Vários vencedores do mesmo item
# (cadastro de reserva, mais de um fornecedor registrado) não colidem porque o fornecedor faz parte da chave; o lote
# entra quando existir. numero_item é único dentro da compra (conferido ao vivo), então o lote não muda a chave hoje.
CHAVE_ARP = ("numero_ata_registro_preco", "codigo_unidade_gerenciadora", "numero_grupo", "numero_item", "ni_fornecedor")
CONFLITO_ARP = ",".join(CHAVE_ARP)
TAMANHO_PAGINA = 50


def validar_parametros_consulta(codigo_pdm: Any, data_min: Any, data_max: Any) -> int:
    """Obrigatórios do 2_consultarARPItem: sem eles a API responde 404 (não é 'sem resultado')."""
    validar_intervalo("dataVigenciaInicialMin", data_min, "dataVigenciaInicialMax", data_max)
    return validar_codigo("codigoPdm", codigo_pdm)


def chave_arp(linha: dict[str, Any]) -> tuple:
    return tuple(linha.get(c) for c in CHAVE_ARP)


def deduplicar_por_chave(linhas: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """A API repete o item quando a ata é republicada (só mudam dataHoraInclusao/dataHoraAtualizacao).
    Duas linhas com a mesma chave no mesmo upsert fazem o Postgres recusar o lote inteiro
    ("ON CONFLICT DO UPDATE command cannot affect row a second time"). Fica a de dataHoraAtualizacao mais recente
    (empate: a última recebida)."""
    escolhidas: dict[tuple, dict[str, Any]] = {}
    for linha in linhas:
        k = chave_arp(linha)
        atual = escolhidas.get(k)
        if atual is None or str((linha.get("raw") or {}).get("dataHoraAtualizacao") or "") >= str(
                (atual.get("raw") or {}).get("dataHoraAtualizacao") or ""):
            escolhidas[k] = linha
    return list(escolhidas.values()), len(linhas) - len(escolhidas)


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
    # NI só com dígitos (CNPJ ou CPF): compõe a chave, então máscara não pode gerar duas linhas do mesmo fornecedor.
    ni_fornecedor = re.sub(r"\D", "", str(item.get("niFornecedor") or ""))
    if not num_ata or cod_unidade is None or not num_item or not ni_fornecedor:
        # Sem fornecedor a linha não tem chave: vários vencedores do mesmo item colidiriam.
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
        "ni_fornecedor": ni_fornecedor,
        "nome_fornecedor": item.get("nomeRazaoSocialFornecedor"),
        # O item de ARP não tem marca, fabricante nem modelo (VwFtArpItemDTO). As colunas existem na tabela e nas
        # views de BI, mas ficam NULL de propósito: marca vem da Pesquisa de Preço (precos_praticados_itens.marca)
        # ou do Paradigma/edital. Não inventar.
        "marca": None,
        "fabricante": None,
        "modelo": None,
        # Lote/grupo: o item de ARP não traz. NULL = não informado pela fonte (a constraint aceita só NULL ou > 0).
        "numero_grupo": None,
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
        codigo_pdm = validar_parametros_consulta(codigo_pdm, data_min, data_max)
        url = f"{BASE_URL}{ENDPOINT}"
        params = {
            "dataVigenciaInicialMin": data_min,
            "dataVigenciaInicialMax": data_max,
            "codigoPdm": codigo_pdm,
            "pagina": pagina,
            "tamanhoPagina": min(500, max(10, tamanho_pagina)),
        }
        contexto = f"ARP PDM {codigo_pdm} ({data_min} a {data_max}) pagina {pagina}"
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                log.warning("Falha de rede em ARP PDM %d tentativa %d: %s", codigo_pdm, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(espera_retry(None, tentativa, base=3.0))
                continue
            if r.status_code == 200:
                return corpo_json(r, contexto)
            if r.status_code in (429, 502, 503, 504):
                if tentativa == 3:
                    raise ErroApiCompras(f"HTTP {r.status_code} esgotado em ARP PDM {codigo_pdm}", status=r.status_code)
                espera = espera_retry(r, tentativa, base=4.0)
                log.warning("HTTP %d em ARP PDM %d (tentativa %d), aguardando %.1fs...", r.status_code, codigo_pdm, tentativa, espera)
                time.sleep(espera)
                continue
            # 404 (parâmetro obrigatório faltando) e demais 4xx/5xx: erro sem retry, nunca lista vazia.
            raise erro_http(r, contexto)
        raise ErroApiCompras(f"Falha ao consultar ARP PDM {codigo_pdm} após retries")


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
    descartados = 0
    duplicados_removidos = 0
    amostras = []

    try:
        validar_intervalo("dataVigenciaInicialMin", data_min, "dataVigenciaInicialMax", data_max)
    except ParametroInvalido as e:
        log.error("Coleta ARP abortada: %s", e)
        return {"sucesso": False, "erro": str(e), "total_coletados": 0, "total_gravados": 0, "erros": 1,
                "descartados": 0, "duplicados_removidos": 0, "amostras": []}

    for pdm in pdms:
        pagina = 1
        while True:
            log.info("Consultando ARP PDM %d (%s a %s) pagina %d...", pdm, data_min, data_max, pagina)
            try:
                resp = cliente.consultar_itens_pdm(pdm, data_min=data_min, data_max=data_max, pagina=pagina, tamanho_pagina=TAMANHO_PAGINA)
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
                else:
                    descartados += 1
                    log.warning("Item de ARP sem chave completa (ata/UASG/item/fornecedor) descartado: ata=%s uasg=%s item=%s",
                                it.get("numeroAtaRegistroPreco"), it.get("codigoUnidadeGerenciadora"), it.get("numeroItem"))

            linhas_norm, dup = deduplicar_por_chave(linhas_norm)
            duplicados_removidos += dup

            if not dry_run and sb is not None and linhas_norm:
                try:
                    sb.upsert("atas_rp_itens", linhas_norm, conflito=CONFLITO_ARP)
                    total_gravados += len(linhas_norm)
                except Exception as e:
                    log.error("Erro no upsert de %d linhas de atas: %s", len(linhas_norm), e)
                    erros += 1

            if limite and total_coletados >= limite:
                log.info("Limite de %d itens atingido", limite)
                return {
                    "sucesso": erros == 0,
                    "total_coletados": total_coletados,
                    "total_gravados": total_gravados,
                    "erros": erros,
                    "descartados": descartados,
                    "duplicados_removidos": duplicados_removidos,
                    "amostras": amostras,
                }

            total_regs = resp.get("totalRegistros") or 0
            if pagina * TAMANHO_PAGINA >= total_regs or len(items_raw) < TAMANHO_PAGINA:
                break
            pagina += 1

    return {
        "sucesso": erros == 0,
        "total_coletados": total_coletados,
        "total_gravados": total_gravados,
        "erros": erros,
        "descartados": descartados,
        "duplicados_removidos": duplicados_removidos,
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
