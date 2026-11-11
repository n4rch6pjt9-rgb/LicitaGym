"""Catálogo de materiais do Portal de Compras MG (SIAD), fora do CATMAT federal.

Fonte: tela pública "Consulta a itens de materiais ou itens de serviços"
(https://www1.compras.mg.gov.br/n/catalogo/itemmaterialouservico), sem login.

Contrato medido em 09/11/2026 (capturado no DevTools da própria tela):

- GET  {BASE}/recuperarDadosIniciais -> {grupos: [{id, codigo, descricao}], situacoes, tiposGrupo, classes, ...}
- POST {BASE}/pesquisar, corpo JSON:
    {"reqId": 2, "ordenacoes": [], "sizePerPage": 100, "page": 1,
     "filtros": {"situacoes": ["ATIVO"], "tiposGrupo": "MATERIAL", "idGrupo": "72"}}
  -> {"resultado": {"total": int, "dados": [item, ...]}}

`idGrupo` é o id INTERNO do grupo, não o código: o grupo 78 (recreação e desporto) tem id 72, e `idGrupo=78`
devolve o grupo 84. Por isso o código do grupo é sempre resolvido por `recuperarDadosIniciais`.
Campos desconhecidos no corpo dão 4xx ("Unrecognized field ... ParametrosPesquisaRest").

Com `ordenacoes: []` (o que a tela manda) a paginação é instável: na coleta de 09/11/2026 as páginas repetiram itens
e 90 dos 1363 faltaram. Por isso o coletor ordena por `id` (chave única): `[{"sortName": "id", "sortOrder": "asc"}]`
(`OrdenacaoRest` só aceita `sortName` e `sortOrder`; o nome é propriedade da entidade, `codigoFormatado` dá erro).

Saída: JSON bruto (lista de itens como vieram) + CSV com colunas achatadas + proveniência. Não grava no banco.

Uso:
    python -m coletor.compras_mg_catalogo --grupo 78
    python -m coletor.compras_mg_catalogo --grupo 78 --grupo 72 --situacao ATIVO --situacao SUSPENSO_PARA_COMPRA
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from coletor.proveniencia import hash_payload
from coletor.retry import espera_retry

log = logging.getLogger(__name__)

BASE = "https://www1.compras.mg.gov.br/servico/catalogo/itemmaterialservico/Consulta"
URL_INICIAIS = f"{BASE}/recuperarDadosIniciais"
URL_PESQUISAR = f"{BASE}/pesquisar"
URL_TELA = "https://www1.compras.mg.gov.br/n/catalogo/itemmaterialouservico"
FONTE = "compras_mg_siad"

ORDENACAO_ESTAVEL = {"sortName": "id", "sortOrder": "asc"}  # sem ela a paginação repete/perde itens
TAMANHO_PAGINA = 100  # o mesmo da tela
TIMEOUT_S = (10, 60)
TENTATIVAS = 5
DELAY_MIN_S = 1.0
SITUACOES_VALIDAS = ("ATIVO", "SUSPENSO_PARA_COMPRA")
TIPOS_GRUPO = ("MATERIAL", "SERVICO")

CABECALHOS = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "LicitaGym-coletor/1.0 (dados abertos; catalogo Compras MG)",
}


class ErroColeta(RuntimeError):
    """Falha de coleta: página com erro, contrato diferente do medido ou contagem que não fecha."""


# --------------------------------------------------------------------------- HTTP

def _requisitar(sessao, metodo: str, url: str, *, corpo: dict | None = None, base_backoff: float = 2.0,
                dormir=time.sleep, contexto: str = "") -> dict:
    """Uma chamada com timeout, retry em 429/5xx/erro de rede (Retry-After ou backoff). Erro vira exceção."""
    onde = f"{url} [{contexto}]" if contexto else url
    ultimo = None
    for tentativa in range(1, TENTATIVAS + 1):
        r = None
        try:
            r = sessao.request(metodo, url, json=corpo, headers=CABECALHOS, timeout=TIMEOUT_S)
        except requests.RequestException as e:
            ultimo = f"{type(e).__name__}: {e}"
        else:
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError as e:
                    raise ErroColeta(f"{onde}: resposta 200 não é JSON") from e
            if r.status_code != 429 and r.status_code < 500:
                raise ErroColeta(f"{onde}: HTTP {r.status_code}: {r.text[:300]}")
            ultimo = f"HTTP {r.status_code}"
        if tentativa < TENTATIVAS:
            espera = espera_retry(r, tentativa, base_backoff)
            log.warning("%s falhou (%s); tentativa %d/%d em %.1fs", onde, ultimo, tentativa, TENTATIVAS, espera)
            dormir(espera)
    raise ErroColeta(f"{onde}: desistiu após {TENTATIVAS} tentativas ({ultimo})")


# --------------------------------------------------------------------------- grupos

def resolver_grupos(iniciais: dict, codigos: list[int]) -> list[dict]:
    """Código do grupo (ex. 78) -> {id, codigo, descricao} da lista oficial. Código ausente é erro, não palpite."""
    grupos = (iniciais or {}).get("grupos")
    if not isinstance(grupos, list) or not grupos:
        raise ErroColeta("recuperarDadosIniciais sem lista 'grupos' (contrato mudou?)")
    por_codigo = {}
    for g in grupos:
        try:
            por_codigo[int(g["codigo"])] = g
        except (KeyError, TypeError, ValueError):
            continue  # grupo sem código numérico não casa com nenhum pedido
    por_codigo = {c: g for c, g in por_codigo.items() if g.get("id") is not None}
    codigos = list(dict.fromkeys(codigos))  # --grupo repetido não coleta duas vezes
    faltando = [c for c in codigos if c not in por_codigo]
    if faltando:
        raise ErroColeta(f"grupo(s) {faltando} não existem no catálogo MG")
    return [por_codigo[c] for c in codigos]


def montar_corpo(id_grupo: int, situacoes: list[str], pagina: int, tamanho: int, tipo: str = "MATERIAL") -> dict:
    return {
        "reqId": 2,
        "ordenacoes": [ORDENACAO_ESTAVEL],
        "sizePerPage": tamanho,
        "page": pagina,
        "filtros": {"situacoes": list(situacoes), "tiposGrupo": tipo, "idGrupo": str(id_grupo)},
    }


# --------------------------------------------------------------------------- paginação

def coletar_grupo(sessao, grupo: dict, situacoes: list[str], *, tamanho: int = TAMANHO_PAGINA,
                  delay: float = DELAY_MIN_S, tipo: str = "MATERIAL", dormir=time.sleep) -> tuple[list[dict], int]:
    """Todas as páginas de um grupo. Devolve (itens, total informado pela API).

    Para quando juntou `total` itens ou a página vem vazia. Página repetida (mesmos ids) ou contagem final
    diferente do `total` é erro: resultado parcial não passa como completo.
    """
    delay = max(DELAY_MIN_S, delay)
    itens: list[dict] = []
    vistos: set = set()
    total = None
    pagina = 1
    while True:
        corpo = montar_corpo(grupo["id"], situacoes, pagina, tamanho, tipo)
        contexto = f"grupo {grupo['codigo']} pág {pagina}"
        resposta = _requisitar(sessao, "POST", URL_PESQUISAR, corpo=corpo, dormir=dormir, contexto=contexto)
        resultado = resposta.get("resultado") if isinstance(resposta, dict) else None
        if not isinstance(resultado, dict) or not isinstance(resultado.get("dados"), list):
            raise ErroColeta(f"{contexto}: resposta sem resultado.dados")
        if total is None:
            # total ausente ou inválido é contrato mudado, não grupo vazio
            bruto = resultado.get("total")
            if isinstance(bruto, bool) or not isinstance(bruto, int) or bruto < 0:
                raise ErroColeta(f"{contexto}: resultado.total ausente ou inválido ({bruto!r})")
            total = bruto
            log.info("grupo %s (id %s): total=%d", grupo["codigo"], grupo["id"], total)
        dados = resultado["dados"]
        if not dados:
            break
        ids = [d.get("id") if isinstance(d, dict) else None for d in dados]
        if any(i is None for i in ids):
            raise ErroColeta(f"{contexto}: item sem id")
        if all(i in vistos for i in ids):
            raise ErroColeta(f"{contexto}: repetiu itens já coletados (paginação ignorada?)")
        for d in dados:
            if d.get("id") not in vistos:
                vistos.add(d.get("id"))
                itens.append(d)
        log.info("página %d: +%d (acumulado %d/%d)", pagina, len(dados), len(itens), total)
        if len(itens) >= total:
            break
        pagina += 1
        dormir(delay)
    if len(itens) != total:
        raise ErroColeta(f"grupo {grupo['codigo']}: coletados {len(itens)} de total {total}")
    return itens, total


# --------------------------------------------------------------------------- CSV

def _g(d, *caminho):
    for chave in caminho:
        if not isinstance(d, dict):
            return None
        d = d.get(chave)
    return d


_INICIO_FORMULA = ("=", "+", "-", "@", "\t", "\r")


def _celula(v):
    """Texto que o Excel leria como fórmula ganha um apóstrofo só no CSV (o JSON bruto fica intacto)."""
    if isinstance(v, str) and v.startswith(_INICIO_FORMULA):
        return "'" + v
    return v


def _bool(v):
    return "" if v is None else ("sim" if v else "nao")


COLUNAS = [
    "codigo_item", "id_interno", "versao", "situacao", "tipo",
    "grupo", "classe", "codigo_material", "nome_material", "natureza_despesa",
    "especificacao", "especificacao_complementar", "sinonimos", "marca_referencia", "linhas_fornecimento",
    "sustentavel", "eh_generico", "eh_item_comum", "possui_ref_melhor_preco", "qtd_itens_similares",
    "payload_hash", "fonte", "url_consulta", "coletado_em", "grupo_codigo_filtro", "grupo_id_filtro", "situacoes_filtro",
]


def linha_csv(item: dict, prov: dict) -> dict:
    """Achata um item. Texto vai como veio da fonte (inclusive quebras de linha da especificação complementar)."""
    mat = item.get("materialOuServico") or {}
    sinonimos = item.get("sinonimos")
    if isinstance(sinonimos, str):
        sinonimos = "; ".join(s.strip() for s in sinonimos.split(";") if s.strip())
    return {
        "codigo_item": item.get("codigo"),
        "id_interno": item.get("id"),
        "versao": item.get("versao"),
        "situacao": _g(item, "situacao", "descricao") or item.get("situacaoItem"),
        "tipo": _g(item, "ehMaterialOuServico", "id"),
        "grupo": _g(mat, "classe", "codigoGrupoFormatado"),
        "classe": _g(mat, "classe", "codigoNomeFormatado"),
        "codigo_material": mat.get("codigoFormatado"),
        "nome_material": mat.get("nome"),
        "natureza_despesa": _g(mat, "naturezaDespesa", "nome"),
        "especificacao": item.get("especificacaoCompleta"),
        "especificacao_complementar": item.get("especificacaoComplementar"),
        "sinonimos": sinonimos,
        "marca_referencia": item.get("marcaReferencia"),
        "linhas_fornecimento": item.get("linhasFornecimentoFormatadas"),
        "sustentavel": _bool(item.get("sustentavel")),
        "eh_generico": _bool(item.get("ehGenerico")),
        "eh_item_comum": _bool(item.get("ehItemComum")),
        "possui_ref_melhor_preco": _bool(item.get("possuiRefMelhorPreco")),
        "qtd_itens_similares": item.get("quantidadeItensSimilares"),
        "payload_hash": hash_payload(item),
        **prov,
    }


def escrever_csv(caminho: Path, linhas: list[dict]) -> None:
    # utf-8-sig + ';' abre direto no Excel pt-BR
    with caminho.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUNAS, delimiter=";", quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        w.writerows({k: _celula(v) for k, v in linha.items()} for linha in linhas)


# --------------------------------------------------------------------------- CLI

def executar(codigos: list[int], situacoes: list[str], saida: Path, *, tamanho: int, delay: float,
             tipo: str = "MATERIAL", sessao=None, dormir=time.sleep) -> dict:
    if sessao is None:
        with requests.Session() as s:
            return executar(codigos, situacoes, saida, tamanho=tamanho, delay=delay, tipo=tipo, sessao=s,
                            dormir=dormir)
    codigos = list(dict.fromkeys(codigos))
    iniciais = _requisitar(sessao, "GET", URL_INICIAIS)
    iniciais = iniciais.get("resultado", iniciais) if isinstance(iniciais, dict) else iniciais
    grupos = resolver_grupos(iniciais, codigos)

    coletado_em = datetime.now(timezone.utc).isoformat(timespec="seconds")
    carimbo = coletado_em.replace(":", "").replace("-", "")[:15]
    saida.mkdir(parents=True, exist_ok=True)
    resumo = {"coletado_em": coletado_em, "fonte": FONTE, "url": URL_PESQUISAR, "grupos": []}
    linhas: list[dict] = []
    for i, grupo in enumerate(grupos):
        if i:
            dormir(max(DELAY_MIN_S, delay))
        try:
            itens, total = coletar_grupo(sessao, grupo, situacoes, tamanho=tamanho, delay=delay, tipo=tipo,
                                         dormir=dormir)
        except ErroColeta:
            if resumo["grupos"]:
                log.warning("coleta parcial: JSON dos grupos %s gravados, CSV não gerado",
                            [g["codigo"] for g in resumo["grupos"]])
            raise
        bruto = saida / f"compras_mg_grupo{grupo['codigo']}_{carimbo}.json"
        bruto.write_text(json.dumps({
            "proveniencia": {
                "fonte": FONTE, "url": URL_PESQUISAR, "tela": URL_TELA, "coletado_em": coletado_em,
                "grupo": grupo, "situacoes": situacoes,
                "corpo_exemplo": montar_corpo(grupo["id"], situacoes, 1, tamanho, tipo),
                "total_api": total,
            },
            "itens": itens,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        prov = {
            "fonte": FONTE, "url_consulta": URL_TELA, "coletado_em": coletado_em,
            "grupo_codigo_filtro": grupo["codigo"], "grupo_id_filtro": grupo["id"],
            "situacoes_filtro": ",".join(situacoes),
        }
        linhas.extend(linha_csv(it, prov) for it in itens)
        resumo["grupos"].append({"codigo": grupo["codigo"], "id": grupo["id"], "descricao": grupo.get("descricao"),
                                 "total_api": total, "coletados": len(itens), "json": str(bruto)})
    nome = "_".join(str(c) for c in codigos)
    csv_path = saida / f"compras_mg_grupos{nome}_{carimbo}.csv"
    escrever_csv(csv_path, linhas)
    resumo["csv"] = str(csv_path)
    resumo["linhas_csv"] = len(linhas)
    return resumo


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Extrai o catálogo de materiais do Compras MG por grupo (JSON + CSV).")
    p.add_argument("--grupo", type=int, action="append", required=True, help="código do grupo (ex. 78); repetível")
    p.add_argument("--situacao", action="append", choices=SITUACOES_VALIDAS,
                   help="padrão: ATIVO (o mesmo da tela); repetível")
    p.add_argument("--tipo", choices=TIPOS_GRUPO, default="MATERIAL", help="padrão: MATERIAL")
    p.add_argument("--tamanho", type=int, default=TAMANHO_PAGINA, help="itens por página (padrão 100)")
    p.add_argument("--delay", type=float, default=DELAY_MIN_S, help="segundos entre páginas (mínimo 1)")
    p.add_argument("--saida", type=Path, default=Path("var/compras_mg"), help="pasta de saída (fora do git)")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not 1 <= a.tamanho <= 100:
        p.error("--tamanho entre 1 e 100")
    try:
        resumo = executar(a.grupo, a.situacao or ["ATIVO"], a.saida, tamanho=a.tamanho, delay=a.delay,
                          tipo=a.tipo)
    except ErroColeta as e:
        log.error("coleta falhou: %s", e)
        return 1
    print(json.dumps(resumo, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
