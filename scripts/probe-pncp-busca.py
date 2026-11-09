"""Sonda do contrato da busca do PNCP (/api/search/ e /api/search/filters), editais e atas.

Referência canônica da seção 6 de docs/pncp/schemas-consultas-pncp.md. Só leitura de dado público.
Uma requisição por vez, intervalo >= 1,5 s, retry com backoff só para queda de conexão (a busca derruba
~60 % das conexões sem responder). Não grava nada: imprime o relatório no terminal.

Uso:
  python -I scripts/probe-pncp-busca.py
  python -I scripts/probe-pncp-busca.py --controle 46523262000131-1-000118/2026
"""
from __future__ import annotations

import argparse
import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request

BUSCA = "https://pncp.gov.br/api/search/"
FILTROS = "https://pncp.gov.br/api/search/filters"
CONSULTA = "https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}"
INTERVALO_S = 1.5
TIMEOUT_S = 30
TENTATIVAS = 5
UA = "LicitaGym-sonda/1.0"

_ultimo = 0.0
contagem = {"respostas": 0, "quedas": 0}


def _uma(url: str) -> tuple[int | None, object]:
    global _ultimo
    espera = INTERVALO_S - (time.time() - _ultimo)
    if espera > 0:
        time.sleep(espera)
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            status, corpo = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, corpo = e.code, e.read()
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        status, corpo = None, repr(e).encode()
    finally:
        _ultimo = time.time()
    if corpo[:2] == b"\x1f\x8b":  # /filters vem gzip mesmo sem Accept-Encoding
        corpo = gzip.decompress(corpo)
    try:
        return status, json.loads(corpo)
    except ValueError:
        return status, corpo.decode("utf-8", "replace")[:200]


def get(url: str, params: dict | None = None) -> tuple[int | None, object]:
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    status, corpo = None, None
    for tentativa in range(TENTATIVAS):
        status, corpo = _uma(url)
        if status is not None:
            contagem["respostas"] += 1
            return status, corpo
        contagem["quedas"] += 1
        time.sleep(3 * 2 ** tentativa)
    return status, corpo


def busca(**kw) -> dict:
    p = {"tipos_documento": "edital", "ordenacao": "-data", "pagina": 1, "tam_pagina": 10}
    p.update(kw)
    return p


def resumo(status, corpo) -> str:
    if isinstance(corpo, dict) and "items" in corpo:
        return f"HTTP {status} total={corpo.get('total')} n={len(corpo.get('items') or [])}"
    return f"HTTP {status} {str(corpo)[:120]}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--controle", default="46523262000131-1-000118/2026", help="numero_controle_pncp da compra")
    ap.add_argument("--termo", default="equipamentos de academia")
    a = ap.parse_args()
    cnpj, resto = a.controle.split("-", 1)
    seq, ano = resto.split("-", 1)[1].split("/")
    termo = a.termo

    print("== disponibilidade")
    print("consulta detalhe ", resumo(*get(CONSULTA.format(cnpj=cnpj, ano=ano, seq=int(seq)))))
    s, edital = get(BUSCA, busca(q=f'"{a.controle}"'))
    print("busca edital     ", resumo(s, edital))
    s, atas = get(BUSCA, busca(q=f'"{a.controle}"', tipos_documento="ata", tam_pagina=100))
    print("busca atas       ", resumo(s, atas))
    if isinstance(edital, dict):
        for it in edital.get("items") or []:
            casa = it.get("numero_controle_pncp") == a.controle
            print("   edital", it.get("numero_controle_pncp"), "casa" if casa else "NÃO casa")
    if isinstance(atas, dict):
        da_compra = [i for i in atas.get("items") or [] if str(i.get("numero_controle_pncp", "")).startswith(a.controle + "-")]
        print(f"   atas da compra: {len(da_compra)} de {len(atas.get('items') or [])}")

    print("== status (valor desconhecido é ignorado: comparar totais)")
    for st in [None, "recebendo_proposta", "em_julgamento", "encerradas", "vigente", "valor_inexistente"]:
        p = busca(q=termo)
        if st:
            p["status"] = st
        print(f"  status={st}", resumo(*get(BUSCA, p)))

    print("== separador de vários valores")
    for nome, p in [("ufs=SP|RJ", busca(q=termo, ufs="SP|RJ")), ("ufs=SP,RJ", busca(q=termo, ufs="SP,RJ")),
                    ("modalidades=6|8", busca(q=termo, modalidades="6|8")),
                    ("modalidades=6,8", busca(q=termo, modalidades="6,8"))]:
        print(" ", nome, resumo(*get(BUSCA, p)))

    print("== tamanho e janela")
    for tam in [500, 1000]:
        print(f"  tam_pagina={tam}", resumo(*get(BUSCA, busca(q=termo, tam_pagina=tam))))
    print("  pagina=999 tam=100", resumo(*get(BUSCA, busca(q=termo, status="encerradas", tam_pagina=100, pagina=999))))

    print("== paginação (repetidos e estabilidade)")
    paginas = {}
    for pg in [1, 2, 3, 1]:
        s, c = get(BUSCA, busca(q=termo, status="encerradas", tam_pagina=100, pagina=pg))
        ids = [i.get("numero_controle_pncp") for i in (c.get("items") or [])] if isinstance(c, dict) else []
        chave = pg if pg not in paginas else "1b"
        paginas[chave] = ids
        print(f"  pagina {pg}", resumo(s, c))
    junt = paginas.get(1, []) + paginas.get(2, []) + paginas.get(3, [])
    print(f"  repetidos p1-3: {len(junt) - len(set(junt))}; p1 igual na repetição: {paginas.get(1) == paginas.get('1b')}")

    print("== filters")
    for tipo in ["edital", "ata"]:
        s, c = get(FILTROS, {"q": termo, "tipos_documento": tipo})
        if isinstance(c, dict):
            print(f"  {tipo}: HTTP {s}", {k: len(v) for k, v in c.get("filters", {}).items() if v})
        else:
            print(f"  {tipo}:", resumo(s, c))

    print(f"== conexões: {contagem['respostas']} respostas, {contagem['quedas']} quedas sem resposta")


if __name__ == "__main__":
    main()
