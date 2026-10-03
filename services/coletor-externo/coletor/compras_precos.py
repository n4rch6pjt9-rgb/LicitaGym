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

Campos reais (conferidos ao vivo em 02/10/2026 e no schema FtPesqPrecoCompraMaterialDTO do OpenAPI): a fonte traz
`marca` (única fonte de marca entre os módulos do Compras.gov), mas não tem fabricante, modelo nem lote/grupo.
`idCompra` chega como NÚMERO JSON e perde o zero à esquerda (UASG 090181 => 16 dígitos); `idCompraItem` chega como
string de 22 dígitos = idCompra (17) + número do item (5) e preserva o zero.
Parâmetros obrigatórios da API: tipo e codigo (sem eles a API responde 404).
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

from .compras_api import ErroApiCompras, ParametroInvalido, corpo_json, erro_http, validar_codigo
from .compras_pdms import CatalogoPdmsIndisponivel, carregar_pdms_efetivos
from .destino import Supabase, env
from .retry import espera_retry

log = logging.getLogger("coletor.compras_precos")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT_MATERIAL = "/modulo-pesquisa-preco/1_consultarMaterial"
ENDPOINT_DETALHE = "/modulo-pesquisa-preco/2_consultarMaterialDetalhe"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

# PDMs mais frequentes do catálogo fitness (ex.: 2640 aparelhos musculação, 2638 acessórios).
# 7115 ESTEIRA ELÉTRICA concentra a maior parte dos preços de esteira (206 registros em 02/10/2026, contra 48 do
# 7113 ESTEIRA ERGONOMICA, que segue ativo no catálogo).
PDMS_PADRAO = [2640, 2638, 7113, 7115, 3522, 5341, 8166, 18481, 10779]

TIPOS_CONSULTA = ("codigoPdm", "codigoItemCatalogo")
# A API aceita tamanhoPagina de 10 a 500 neste módulo (plugin comprasgov-dados-abertos 0.3.1; varredura dos 40 PDMs
# efetivos com 500 fez 80 requisições em 02/10/2026).
TAMANHO_PAGINA = 500


def validar_parametros_consulta(tipo: Any, codigo: Any) -> int:
    """Obrigatórios do 1_consultarMaterial: sem tipo/codigo a API responde 404 (não é 'sem resultado')."""
    if tipo not in TIPOS_CONSULTA:
        raise ParametroInvalido(f"'tipo' deve ser um de {TIPOS_CONSULTA} (recebido {tipo!r})")
    return validar_codigo("codigo", codigo)


def id_compra_de(item: dict[str, Any]) -> str | None:
    """idCompra como string de 17 dígitos.

    A API manda idCompra como número JSON: UASG com zero à esquerda (ex.: 090181) chega com 16 dígitos. O
    idCompraItem (string de 22 dígitos = idCompra[17] + item[5]) preserva o zero e é a fonte preferida; sem ele,
    completa idCompra numérico com zeros à esquerda até 17 dígitos.
    """
    id_compra_item = str(item.get("idCompraItem") or "").strip()
    bruto = item.get("idCompra")
    id_compra = str(bruto).strip() if bruto not in (None, "") else ""
    if re.fullmatch(r"\d{22}", id_compra_item):
        derivado = id_compra_item[:17]
        if id_compra and id_compra.isdigit() and id_compra.zfill(17) != derivado:
            log.warning("idCompra %s diverge do prefixo de idCompraItem %s; usando idCompraItem", id_compra, id_compra_item)
        return derivado
    if id_compra.isdigit() and len(id_compra) <= 17:
        return id_compra.zfill(17)
    return id_compra or None


def deduplicar_por_chave(linhas: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Mesma (id_compra, id_item_compra) duas vezes no mesmo upsert faz o Postgres recusar o lote inteiro."""
    escolhidas: dict[tuple, dict[str, Any]] = {}
    for linha in linhas:
        k = (linha["id_compra"], linha["id_item_compra"])
        atual = escolhidas.get(k)
        if atual is None or str(linha.get("data_hora_atualizacao_item") or "") >= str(atual.get("data_hora_atualizacao_item") or ""):
            escolhidas[k] = linha
    return list(escolhidas.values()), len(linhas) - len(escolhidas)


def texto_ou_nulo(val: Any) -> str | None:
    """Texto com strip; vazio e o placeholder "0" da API viram None (ni_fornecedor, marca, codigo_uasg)."""
    if val is None:
        return None
    s = str(val).strip()
    return None if s in ("", "0") else s


def tipo_ni(ni: str | None) -> str | None:
    """'cnpj' (14 dígitos), 'cpf' (11), 'outro' ou None. Pessoa física fica gravada, mas fora do ranking de marcas
    (v_marca_ocorrencias.entra_ranking só aceita CNPJ)."""
    if not ni:
        return None
    if re.fullmatch(r"\d{14}", ni):
        return "cnpj"
    if re.fullmatch(r"\d{11}", ni):
        return "cpf"
    return "outro"


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

    id_compra = id_compra_de(item)
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
        # Única fonte de marca do Compras.gov: é a marca declarada na proposta, em texto livre e sem limite de 20
        # caracteres (até 84): ~76% é marca real, o restante é modelo, lixo ou ambíguo. Por isso a marca canônica sai de
        # private.marca_resolver na view. Fabricante e modelo não existem na fonte: NULL de propósito (colunas
        # mantidas porque as views de BI as leem). Não inventar.
        "marca": texto_ou_nulo(item.get("marca")),
        "fabricante": None,
        "modelo": None,
        "data_resultado": _date(item.get("dataResultado")),
        "data_hora_atualizacao_item": item.get("dataHoraAtualizacaoItem"),
        "sigla_unidade_fornecimento": item.get("siglaUnidadeFornecimento"),
        "nome_unidade_fornecimento": item.get("nomeUnidadeFornecimento"),
        "capacidade_unidade_fornecimento": _num(item.get("capacidadeUnidadeFornecimento")),
        "sigla_unidade_medida": item.get("siglaUnidadeMedida"),
        "nome_unidade_medida": item.get("nomeUnidadeMedida"),
        "ni_fornecedor": texto_ou_nulo(item.get("niFornecedor")),
        "nome_fornecedor": item.get("nomeFornecedor"),
        "codigo_uasg": texto_ou_nulo(item.get("codigoUasg")),
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
        codigo = validar_parametros_consulta(tipo, codigo)
        url = f"{BASE_URL}{ENDPOINT_MATERIAL}"
        params = {
            "tipo": tipo,
            "codigo": codigo,
            "pagina": pagina,
            "tamanhoPagina": min(500, max(10, tamanho_pagina)),
        }
        contexto = f"Pesquisa Preco {tipo}={codigo} pagina {pagina}"
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                log.warning("Falha de rede em Pesquisa Preco %s=%d tentativa %d: %s", tipo, codigo, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(espera_retry(None, tentativa, base=2.0))
                continue
            if r.status_code == 200:
                return corpo_json(r, contexto)
            if r.status_code in (429, 502, 503, 504):
                if tentativa == 3:
                    raise ErroApiCompras(f"HTTP {r.status_code} esgotado em Pesquisa Preco {tipo}={codigo}", status=r.status_code)
                espera = espera_retry(r, tentativa, base=3.0)
                log.warning("HTTP %d em Pesquisa Preco %s=%d (tentativa %d), aguardando %.1fs...", r.status_code, tipo, codigo, tentativa, espera)
                time.sleep(espera)
                continue
            # 404 (parâmetro obrigatório faltando), 400 (codigo inválido) e demais: erro sem retry, nunca lista vazia.
            raise erro_http(r, contexto)
        raise ErroApiCompras(f"Falha ao consultar Pesquisa Preco {tipo}={codigo} após retries")


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
    descartados = 0
    duplicados_removidos = 0
    amostras = []
    por_tipo_ni = {"cnpj": 0, "cpf": 0, "outro": 0, "sem_ni": 0}

    consultas: list[tuple[str, int]] = []
    if itens:
        for it in itens:
            consultas.append(("codigoItemCatalogo", it))
    if pdms:
        for p in pdms:
            consultas.append(("codigoPdm", p))
    if not consultas:
        if sb is None:
            # Sem banco (dry-run sem --pdms/--itens): única situação em que a lista fixa é usada.
            pdms_efetivos = list(PDMS_PADRAO)
        else:
            # Com banco, só o catálogo efetivo: falha/resposta inválida da RPC falha a coleta, sem PDMS_PADRAO.
            try:
                pdms_efetivos = carregar_pdms_efetivos(sb)
            except CatalogoPdmsIndisponivel as e:
                log.error("Coleta de Pesquisa de Preço abortada: %s", e)
                return {
                    "sucesso": False,
                    "erro": str(e),
                    "total_coletados": 0,
                    "total_gravados": 0,
                    "erros": 1,
                    "amostras": [],
                }
            if not pdms_efetivos:
                log.warning("Catálogo de PDMs efetivos vazio: coleta de Pesquisa de Preço sem consultas")
        for p in pdms_efetivos:
            consultas.append(("codigoPdm", p))

    for tipo, cod in consultas:
        pagina = 1
        while True:
            log.info("Consultando Pesquisa Preco %s=%d pagina %d...", tipo, cod, pagina)
            try:
                resp = cliente.consultar_material(tipo, cod, pagina=pagina, tamanho_pagina=TAMANHO_PAGINA)
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
                    por_tipo_ni[tipo_ni(norm["ni_fornecedor"]) or "sem_ni"] += 1
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
                else:
                    descartados += 1
                    log.warning("Preço sem idCompra/idItemCompra descartado: idCompraItem=%s", it.get("idCompraItem"))

            linhas_norm, dup = deduplicar_por_chave(linhas_norm)
            duplicados_removidos += dup

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
                    "sucesso": erros == 0,
                    "total_coletados": total_coletados,
                    "total_gravados": total_gravados,
                    "erros": erros,
                    "descartados": descartados,
                    "duplicados_removidos": duplicados_removidos,
                    "por_tipo_ni": por_tipo_ni,
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
        "por_tipo_ni": por_tipo_ni,
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
