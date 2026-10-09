"""Coletor Compras.gov Pesquisa de Preço (preços efetivamente homologados).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial
    ?tipo=codigoPdm&codigo={codigo_pdm}&pagina={pagina}&tamanhoPagina={tamanhoPagina}
  ou
    ?tipo=codigoItemCatalogo&codigo={codigo_item}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Detalhe, só para completar (spec 0009, CA-9; função completar_detalhes):
  GET https://dadosabertos.compras.gov.br/modulo-pesquisa-preco/2_consultarMaterialDetalhe
    ?codigoItemCatalogo={codigo_item}&pagina={pagina}&tamanhoPagina={tamanhoPagina}
  Parâmetro conferido em docs/pncp/contract-matrix.md (endpoint 2, "testado-ok" com codigoItemCatalogo=233523).
  O script antigo scripts/collector_pesquisa_preco.py usava codigoMaterial, que não está documentado como testado.
  Só as linhas gravadas sem descricao_detalhada_item (nula ou em branco) e ainda sem detalhe_sincronizado_em são
  consultadas; o casamento é pela chave (idCompra, idItemCompra), a mesma do 1_.

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
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .arquivo_raw import ArquivoRaw
from .compras_api import ErroApiCompras, ParametroInvalido, corpo_json, erro_http, validar_codigo
from .compras_pdms import CatalogoPdmsIndisponivel, carregar_pdms_efetivos
from .destino import Supabase, env
from .paginacao import TAMANHO_PAGINA_MAX, DecisaoPagina, avaliar_pagina, clamp_tamanho, pagina_repetida
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
# Regra do projeto (Marcelo, 03/10/2026): coletores Python pedem no máximo 100 itens por página, mesmo que a API
# aceite até 500. O fim da coleta é decidido por coletor.paginacao.avaliar_pagina (o mesmo helper do PGC e do ARP):
# só encerra quando os totais da resposta concordam; página curta não é fim; página vazia com totais indicando
# registros restantes, ou com totais divergentes, encerra com aviso e conta como erro (coleta truncada); página
# repetida também é erro. Total declarado 0 só é fim legítimo se a consulta não leu nenhum item: com itens já
# lidos, o metadado é contraditório e a consulta sai como erro (review do Copilot em cc1f0cb).
TAMANHO_PAGINA = TAMANHO_PAGINA_MAX


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


def sem_texto(val: Any) -> bool:
    return val is None or (isinstance(val, str) and val.strip() == "")


def lotes_upsert(linhas: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Separa as linhas sem descricao_detalhada_item e tira a coluna delas.

    O 1_ devolve a descrição detalhada em branco em parte das compras (4.082 de 25.465 em 09/10). Se a coluna fosse
    no upsert, a descrição que completar_detalhes gravou pelo 2_ voltaria a vazio na coleta seguinte. Cada lote tem as
    mesmas chaves em todas as linhas (o PostgREST recusa lote com chaves diferentes).
    """
    com = [ln for ln in linhas if not sem_texto(ln.get("descricao_detalhada_item"))]
    sem = [{k: v for k, v in ln.items() if k != "descricao_detalhada_item"}
           for ln in linhas if sem_texto(ln.get("descricao_detalhada_item"))]
    return [lote for lote in (com, sem) if lote]


class TipoInvalido(ValueError):
    """Campo de texto da API veio com tipo que não é texto (ex.: marca={"nome": "X"})."""


def texto_ou_nulo(val: Any, campo: str = "valor") -> str | None:
    """Texto com strip; vazio e o placeholder "0" da API viram None (ni_fornecedor, marca, codigo_uasg).

    Só aceita str ou None (o schema declara esses campos como string). O único não-texto tolerado é o placeholder
    inteiro 0. Qualquer outro tipo (dict, lista, número, bool) levanta TipoInvalido: serializar com str() gravaria
    "{'nome': 'X'}" como marca oficial.
    """
    if val is None:
        return None
    if type(val) is int and val == 0:
        return None
    if not isinstance(val, str):
        raise TipoInvalido(f"{campo} com tipo {type(val).__name__}, esperado texto")
    s = val.strip()
    return None if s in ("", "0") else s


def total_zero_declarado(corpo: dict[str, Any]) -> str | None:
    """Nome do primeiro total da resposta (totalRegistros, total, totalPaginas) declarado como 0 ou negativo.

    Mesma leitura numérica de coletor.paginacao._inteiro (int, float inteiro ou string de dígitos; bool não conta).
    """
    for chave in ("totalRegistros", "total", "totalPaginas"):
        val = corpo.get(chave)
        if val is None or isinstance(val, bool):
            continue
        if isinstance(val, float) and val.is_integer():
            val = int(val)
        if isinstance(val, str) and val.strip().isdigit():
            val = int(val.strip())
        if isinstance(val, int) and val <= 0:
            return chave
    return None


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
        "marca": texto_ou_nulo(item.get("marca"), "marca"),
        "fabricante": None,
        "modelo": None,
        "data_resultado": _date(item.get("dataResultado")),
        "data_hora_atualizacao_item": item.get("dataHoraAtualizacaoItem"),
        "sigla_unidade_fornecimento": item.get("siglaUnidadeFornecimento"),
        "nome_unidade_fornecimento": item.get("nomeUnidadeFornecimento"),
        "capacidade_unidade_fornecimento": _num(item.get("capacidadeUnidadeFornecimento")),
        "sigla_unidade_medida": item.get("siglaUnidadeMedida"),
        "nome_unidade_medida": item.get("nomeUnidadeMedida"),
        "ni_fornecedor": texto_ou_nulo(item.get("niFornecedor"), "niFornecedor"),
        "nome_fornecedor": item.get("nomeFornecedor"),
        "codigo_uasg": texto_ou_nulo(item.get("codigoUasg"), "codigoUasg"),
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
            "tamanhoPagina": clamp_tamanho(tamanho_pagina, padrao=TAMANHO_PAGINA_MAX, minimo=10,
                                           maximo=TAMANHO_PAGINA_MAX),
        }
        return self._get(url, params, f"Pesquisa Preco {tipo}={codigo}", f"Pesquisa Preco {tipo}={codigo} pagina {pagina}")

    def consultar_detalhe(self, codigo_item: int, pagina: int = 1, tamanho_pagina: int = 100) -> dict[str, Any]:
        """2_consultarMaterialDetalhe por item de catálogo (parâmetro documentado em docs/pncp/contract-matrix.md)."""
        codigo_item = validar_codigo("codigoItemCatalogo", codigo_item)
        params = {
            "codigoItemCatalogo": codigo_item,
            "pagina": pagina,
            "tamanhoPagina": clamp_tamanho(tamanho_pagina, padrao=TAMANHO_PAGINA_MAX, minimo=10,
                                           maximo=TAMANHO_PAGINA_MAX),
        }
        nome = f"Pesquisa Preco detalhe codigoItemCatalogo={codigo_item}"
        return self._get(f"{BASE_URL}{ENDPOINT_DETALHE}", params, nome, f"{nome} pagina {pagina}")

    def _get(self, url: str, params: dict[str, Any], nome: str, contexto: str) -> dict[str, Any]:
        """GET com delay >= 1 s, timeout explícito e até 3 tentativas (Retry-After em 429; backoff em 502/503/504 e
        erro de rede). 4xx permanente é erro sem retry, nunca lista vazia."""
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                log.warning("Falha de rede em %s tentativa %d: %s", nome, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(espera_retry(None, tentativa, base=2.0))
                continue
            if r.status_code == 200:
                return corpo_json(r, contexto)
            if r.status_code in (429, 502, 503, 504):
                if tentativa == 3:
                    raise ErroApiCompras(f"HTTP {r.status_code} esgotado em {nome}", status=r.status_code)
                espera = espera_retry(r, tentativa, base=3.0)
                log.warning("HTTP %d em %s (tentativa %d), aguardando %.1fs...", r.status_code, nome, tentativa, espera)
                time.sleep(espera)
                continue
            # 404 (parâmetro obrigatório faltando), 400 (codigo inválido) e demais: erro sem retry, nunca lista vazia.
            raise erro_http(r, contexto)
        raise ErroApiCompras(f"Falha ao consultar {nome} após retries")


def coletar(
    cliente: ClienteComprasPrecos,
    sb: Supabase | None,
    pdms: list[int] | None = None,
    itens: list[int] | None = None,
    limite: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    arquivo = ArquivoRaw("precos_praticados_itens", "compras-precos", dry_run=dry_run)
    resultado: dict[str, Any] | None = None
    try:
        resultado = _coletar_precos(cliente, sb, pdms, itens, limite, dry_run, arquivo)
        return resultado
    finally:
        manifestos = arquivo.fechar()
        if resultado is not None:
            resultado["arquivo_raw"] = manifestos


def _coletar_precos(
    cliente: ClienteComprasPrecos,
    sb: Supabase | None,
    pdms: list[int] | None,
    itens: list[int] | None,
    limite: int | None,
    dry_run: bool,
    arquivo: ArquivoRaw,
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
        recebidos = 0
        paginas_vistas: set[str] = set()
        while True:
            log.info("Consultando Pesquisa Preco %s=%d pagina %d...", tipo, cod, pagina)
            try:
                resp = cliente.consultar_material(tipo, cod, pagina=pagina, tamanho_pagina=TAMANHO_PAGINA)
            except Exception as e:
                log.error("Erro ao consultar %s=%d pagina %d: %s", tipo, cod, pagina, e)
                erros += 1
                break

            if not isinstance(resp, dict) or not isinstance(resp.get("resultado"), list):
                log.warning("Pesquisa Preco %s=%d página %d: resposta inesperada; não é fim de coleta", tipo, cod, pagina)
                erros += 1
                break
            items_raw = resp["resultado"]
            if items_raw and pagina_repetida(items_raw, paginas_vistas):
                # A API devolveu de novo uma página já vista: não conta como progresso nem como fim.
                log.warning("Pesquisa Preco %s=%d página %d: conteúdo repetido; coleta interrompida como erro",
                            tipo, cod, pagina)
                erros += 1
                break
            recebidos += len(items_raw)

            linhas_norm = []
            for pos, it in enumerate(items_raw):
                if limite and total_coletados >= limite:
                    # --limite vale antes do upsert: o resto da página não é normalizado nem gravado.
                    break
                if not isinstance(it, dict):
                    # Elemento de `resultado` que não é objeto (null, número, texto, lista): mesmo tratamento do
                    # TipoInvalido. Descartado, conta como erro e a consulta segue (review do Copilot r4175462189).
                    descartados += 1
                    erros += 1
                    log.warning("Pesquisa Preco %s=%d página %d: item %d de resultado com tipo %s, esperado objeto; "
                                "descartado", tipo, cod, pagina, pos, type(it).__name__)
                    continue
                try:
                    norm = normalizar_preco_praticado(it)
                except TipoInvalido as e:
                    # Tipo inválido em campo de texto: o item não é gravado e a consulta sai como falha.
                    descartados += 1
                    erros += 1
                    log.warning("Pesquisa Preco %s=%d página %d: item idCompraItem=%s descartado: %s",
                                tipo, cod, pagina, it.get("idCompraItem"), e)
                    continue
                if norm:
                    norm["_bruto"] = it
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
            brutos = [ln.pop("_bruto") for ln in linhas_norm]

            if linhas_norm and (dry_run or sb is not None):
                for ln, bruto in zip(linhas_norm, brutos):
                    arquivo.adicionar(
                        {"id_compra": ln["id_compra"], "id_item_compra": ln["id_item_compra"]}, bruto)
            if not dry_run and sb is not None and linhas_norm:
                for lote in lotes_upsert(linhas_norm):
                    try:
                        sb.upsert("precos_praticados_itens", lote, conflito="id_compra,id_item_compra")
                        total_gravados += len(lote)
                    except Exception as e:
                        log.error("Erro no upsert de %d linhas de precos: %s", len(lote), e)
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

            decisao = avaliar_pagina(items_raw, tamanho=TAMANHO_PAGINA, pagina=pagina, corpo=resp, acumulado=recebidos)
            if decisao.encerrar and not decisao.aviso and recebidos > 0:
                chave_zero = total_zero_declarado(resp)
                if chave_zero:
                    # O helper aceita total 0 + página vazia como fim. Com itens já lidos nesta consulta, isso é
                    # metadado contraditório: encerra com aviso e conta como erro, como os demais casos de truncamento.
                    decisao = DecisaoPagina(True, f"{chave_zero} declarado 0 mas {recebidos} item(ns) já lidos nesta "
                                                  "consulta; totais contraditórios, encerrando com aviso")
            if decisao.aviso:
                log.warning("Pesquisa Preco %s=%d página %d: %s", tipo, cod, pagina, decisao.aviso)
            if decisao.encerrar:
                if decisao.aviso:
                    # Parou sem os totais confirmarem o fim (vazia com registros restantes, totais divergentes ou
                    # ilegíveis): a consulta pode ter ficado truncada, então não sai como sucesso.
                    erros += 1
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


FILTRO_SEM_DESCRICAO = "(descricao_detalhada_item.is.null,descricao_detalhada_item.eq.)"


def _chave_detalhe(item: Any) -> tuple[str, int] | None:
    """(id_compra de 17 dígitos, idItemCompra) de um registro do 2_; None se o registro não traz a chave."""
    if not isinstance(item, dict):
        return None
    id_compra = id_compra_de(item)
    try:
        id_item = int(item.get("idItemCompra"))
    except (TypeError, ValueError):
        return None
    if not id_compra:
        return None
    return id_compra, id_item


def _ler_detalhe_item(cliente: ClienteComprasPrecos, codigo_item: int,
                      faltam: set[tuple[str, int]]) -> tuple[dict[tuple[str, int], Any], int]:
    """Pagina o 2_ de um item até achar todas as chaves pedidas ou os totais confirmarem o fim.

    Devolve {chave: descricaoDetalhadaItem} das chaves pedidas e quantos registros vieram sem chave reconhecível.
    Resposta inválida, página repetida ou fim não confirmado levantam ErroApiCompras (o item inteiro vira falha).
    """
    achados: dict[tuple[str, int], Any] = {}
    sem_chave = 0
    vistos: set[str] = set()
    recebidos = 0
    pagina = 1
    while True:
        resp = cliente.consultar_detalhe(codigo_item, pagina=pagina, tamanho_pagina=TAMANHO_PAGINA)
        itens = resp.get("resultado") if isinstance(resp, dict) else None
        if not isinstance(itens, list):
            raise ErroApiCompras(f"detalhe do item {codigo_item} página {pagina}: resposta sem 'resultado' em lista")
        if itens and pagina_repetida(itens, vistos):
            raise ErroApiCompras(f"detalhe do item {codigo_item} página {pagina}: página repetida")
        recebidos += len(itens)
        for it in itens:
            chave = _chave_detalhe(it)
            if chave is None:
                sem_chave += 1
            elif chave in faltam:
                achados[chave] = it.get("descricaoDetalhadaItem")
        if faltam <= achados.keys():
            return achados, sem_chave
        decisao = avaliar_pagina(itens, tamanho=TAMANHO_PAGINA, pagina=pagina, corpo=resp, acumulado=recebidos)
        if decisao.encerrar:
            if decisao.aviso:
                raise ErroApiCompras(f"detalhe do item {codigo_item}: {decisao.aviso}")
            return achados, sem_chave
        pagina += 1


def completar_detalhes(cliente: ClienteComprasPrecos, sb: Supabase, limite_itens: int | None = None) -> dict[str, Any]:
    """Completa a descrição detalhada pelo 2_consultarMaterialDetalhe só nas linhas que não a têm (spec 0009, CA-9).

    Lê de precos_praticados_itens as linhas com descricao_detalhada_item nula ou em branco e detalhe_sincronizado_em
    nulo, consulta o 2_ uma vez por item de catálogo e, para cada linha achada pela chave (id_compra, id_item_compra):
      * grava descricao_detalhada_item (se o detalhe trouxer texto) e detalhe_sincronizado_em = agora;
      * se o detalhe também vier sem texto, grava só detalhe_sincronizado_em (não consulta de novo toda semana).
    Linha que o detalhe não devolve fica sem marca (tenta de novo na próxima execução) e é contada em nao_encontradas.
    Falha (API do item, registro sem chave, gravação) não derruba a coleta: conta em `falhas` e `sucesso` sai False.
    """
    resumo: dict[str, Any] = {
        "sucesso": True, "linhas_pendentes": 0, "itens_consultados": 0, "completadas": 0,
        "sem_descricao_no_detalhe": 0, "nao_encontradas": 0, "falhas": 0, "erros": [],
    }

    def falhar(n: int, msg: str) -> None:
        resumo["falhas"] += n
        if len(resumo["erros"]) < 20:
            resumo["erros"].append(msg[:300])
        log.warning("Detalhe Pesquisa Preco: %s", msg)

    try:
        pendentes = sb.selecionar(
            "precos_praticados_itens",
            select="id_compra,id_item_compra,codigo_item_catalogo",
            detalhe_sincronizado_em="is.null",
            codigo_item_catalogo="not.is.null",
            order="codigo_item_catalogo.asc,id_compra.asc,id_item_compra.asc",
            **{"or": FILTRO_SEM_DESCRICAO},
        )
    except Exception as e:
        falhar(1, f"leitura das linhas sem descrição falhou: {e}")
        resumo["sucesso"] = False
        return resumo

    por_item: dict[int, set[tuple[str, int]]] = {}
    for ln in pendentes:
        try:
            chave = (str(ln["id_compra"]), int(ln["id_item_compra"]))
            item = int(ln["codigo_item_catalogo"])
        except (KeyError, TypeError, ValueError):
            falhar(1, f"linha pendente fora do contrato: {ln!r}")
            continue
        por_item.setdefault(item, set()).add(chave)
    resumo["linhas_pendentes"] = len(pendentes)

    itens = sorted(por_item)
    if limite_itens is not None:
        itens = itens[:limite_itens]
    for codigo_item in itens:
        faltam = por_item[codigo_item]
        resumo["itens_consultados"] += 1
        try:
            achados, sem_chave = _ler_detalhe_item(cliente, codigo_item, faltam)
        except Exception as e:
            falhar(len(faltam), f"item {codigo_item}: {e}")
            continue
        if sem_chave:
            falhar(1, f"item {codigo_item}: {sem_chave} registro(s) do detalhe sem idCompra/idItemCompra "
                      "(contrato do 2_ não reconhecido)")
        agora = datetime.now(timezone.utc).isoformat()
        for chave in sorted(faltam):
            if chave not in achados:
                resumo["nao_encontradas"] += 1
                continue
            bruto = achados[chave]
            campos: dict[str, Any] = {"detalhe_sincronizado_em": agora}
            if isinstance(bruto, str) and bruto.strip():
                campos["descricao_detalhada_item"] = bruto.strip()
            try:
                n = sb.atualizar_onde("precos_praticados_itens",
                                      {"id_compra": f"eq.{chave[0]}", "id_item_compra": f"eq.{chave[1]}"}, campos)
                if n != 1:
                    raise RuntimeError(f"{n} linha(s) atualizada(s), esperado 1")
            except Exception as e:
                falhar(1, f"gravação de {chave[0]}/{chave[1]}: {e}")
                continue
            if "descricao_detalhada_item" in campos:
                resumo["completadas"] += 1
            else:
                resumo["sem_descricao_no_detalhe"] += 1

    resumo["sucesso"] = resumo["falhas"] == 0
    return resumo


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
