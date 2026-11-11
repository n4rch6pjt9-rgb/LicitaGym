"""Extrai o catálogo de produtos de um portal Paradigma (Sistema S) por categoria, com o código interno da entidade.

Usa o mesmo webservice público da tela Catálogo (CatalogoProdutos.aspx), pelo cliente de coletor/paradigma.py:
  PesquisarCatalogoProdutoClasses  acha a categoria (o autocomplete casa por prefixo; aqui o casamento é exato)
  PesquisarCatalogoProdutos        produtos da categoria, em faixas de até 100 (nPaginaDe/nPaginaAte), até página vazia

O código interno é `sCdProdutoEmpresa` (ex.: Sesc DN "310031041500001"). Só leitura, sem login; intervalo entre
chamadas pelo PortalParadigma (DELAY_SEGUNDOS >= 1), 429 respeita Retry-After e 401/403 encerram a coleta.

Uso (dentro de services/coletor-externo):
  python -m coletor.catalogo_paradigma --fonte sescdn --categorias "PT030;ES1205" --saida /caminho/fora/do/repo.csv
  python -m coletor.catalogo_paradigma --fonte fieb --tudo --gravar        # catálogo inteiro no banco (spec 0052)

`--tudo` baixa o catálogo inteiro do portal (PesquisarCatalogoProdutos com nCdClasse 0); é o único jeito de listar
as classes, porque o autocomplete de classes devolve no máximo 5. Saem só as classes com pelo menos um produto
(classe vazia, como a 401 da FIEB, não aparece). `qtd_produtos` só é gravado com `--tudo --tipo todos`. `--gravar` faz upsert em
public.sistema_s_catalogo_classes e public.sistema_s_catalogo_produtos (spec 0052 K-1/K-2) com SUPABASE_URL e
SUPABASE_SERVICE_ROLE_KEY do ambiente; classes antes dos produtos (FK). Produto que sumiu do portal não é apagado.

`--categorias` aceita o código ("PT030") ou o nome exato ("PT030 - EQUIP CONDICIONAMENTO FISICO"), separados por ';'.
Uma linha por produto: produto em duas categorias fica com a primeira (a contagem por categoria vai no log).
Saída de coleta não se versiona: caminho dentro do repositório é recusado.

Códigos de saída: 0 ok; 2 categoria inexistente, ambígua, argumentos ou saída inválidos; 3 catálogo possivelmente
cortado (página repetida ou limite de segurança da paginação), sem gravar arquivo nem banco.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

from .destino import env
from .escopo import normalizar
from .paradigma import FONTES, TIPOS_CATALOGO, PortalParadigma, autorizado_para_coleta

log = logging.getLogger("catalogo_paradigma")

CAMPOS = ["codigo_sesc", "descricao", "tipo", "categoria", "id_categoria", "id_produto", "fonte"]
EXTENSOES = (".csv", ".json")
# Excel interpreta como fórmula o texto que começa com estes caracteres (CSV injection).
_INICIO_FORMULA = ("=", "+", "-", "@", "\t", "\r")
RAIZ_REPO = Path(__file__).resolve().parents[3]
TABELA_CLASSES = "sistema_s_catalogo_classes"
TABELA_PRODUTOS = "sistema_s_catalogo_produtos"
LOTE_GRAVACAO = 500
# Catálogo inteiro: FIEB 138.959 e sescsp 119.192 produtos (09/11/2026), ~1.400 páginas de 100. O teto padrão da
# paginação (1.000 páginas) cortaria os dois; 3.000 páginas = 300 mil produtos, com folga.
MAX_PAGINAS_CATALOGO_INTEIRO = 3000
TENTATIVAS_GRAVACAO = 3


class CategoriaNaoEncontrada(LookupError):
    pass


class CatalogoIncompleto(RuntimeError):
    pass


def _codigo_da_classe(nome: str) -> str:
    """'PT030 - EQUIP CONDICIONAMENTO FISICO' -> 'PT030' (o portal prefixa o código antes de ' - ')."""
    return nome.split(" - ", 1)[0].strip().upper() if " - " in nome else ""


def resolver_categoria(portal: Any, termo: str) -> dict:
    """Categoria cujo código (antes de ' - ') ou nome inteiro é exatamente `termo`.

    Ausente: CategoriaNaoEncontrada, nunca lista vazia. Duas classes com o mesmo código: erro de ambiguidade.
    Resposta nula do portal é erro da fonte (RuntimeError), não "categoria inexistente".
    """
    termo = termo.strip()
    candidatas = portal._ws("PesquisarCatalogoProdutoClasses",
                            {"dtoProduto": {"sDsProduto": termo, "dtoIdioma": {"nCdIdioma": 1}}})
    if candidatas is None:
        raise RuntimeError(f"PesquisarCatalogoProdutoClasses devolveu nulo para {termo!r}")
    alvo = normalizar(termo).strip()
    achadas = [c for c in candidatas
               if normalizar(c.get("sDsClasse") or "").strip() == alvo
               or _codigo_da_classe(c.get("sDsClasse") or "") == termo.upper()]
    if len(achadas) > 1:
        nomes = ", ".join(c.get("sDsClasse") or "?" for c in achadas)
        raise CategoriaNaoEncontrada(f"categoria {termo!r} ambígua no catálogo: {nomes}; use o nome exato")
    if achadas:
        return achadas[0]
    nomes = ", ".join(c.get("sDsClasse") or "?" for c in candidatas[:10]) or "nenhuma"
    raise CategoriaNaoEncontrada(f"categoria {termo!r} não encontrada no catálogo (o portal sugeriu: {nomes})")


def _linha(p: dict, slug: str) -> dict:
    texto = lambda k: (str(p[k]).strip() or None) if p.get(k) is not None else None  # noqa: E731
    return {
        "codigo_sesc": texto("sCdProdutoEmpresa"),
        "descricao": texto("sDsProduto"),
        "tipo": texto("sDsProdutoTipo"),
        "categoria": texto("sDsClasse"),
        "id_categoria": p.get("nCdClasse"),
        "id_produto": p.get("nCdProduto"),
        "fonte": slug,
    }


def extrair(portal: Any, categorias: Iterable[str], tipo: str = "todos") -> list[dict]:
    """Produtos das categorias, na ordem do portal, sem repetir produto.

    Aviso de paginação (página repetida, limite de segurança) quer dizer lista possivelmente cortada:
    CatalogoIncompleto, para não entregar catálogo parcial como completo.
    """
    vistos: set[Any] = set()
    out: list[dict] = []
    for termo in categorias:
        classe = resolver_categoria(portal, termo)
        produtos, avisos = portal.catalogo_com_avisos(classe, tipo)
        if avisos:
            raise CatalogoIncompleto(f"catálogo de {classe.get('sDsClasse')} possivelmente cortado: {'; '.join(avisos)}")
        novas = _deduplicar(produtos, portal.fonte.slug, vistos)
        out.extend(novas)
        novos = len(novas)
        log.info("categoria %s (id %s): %d produtos, %d novos", classe.get("sDsClasse"), classe.get("nCdClasse"),
                 len(produtos), novos)
    return out


def _deduplicar(produtos: list[dict], slug: str, vistos: set[Any]) -> list[dict]:
    out: list[dict] = []
    for p in produtos:
        chave = p.get("nCdProduto") if p.get("nCdProduto") is not None else (p.get("sCdProdutoEmpresa"), p.get("sDsProduto"))
        if chave in vistos:
            continue
        vistos.add(chave)
        out.append(_linha(p, slug))
    return out


def extrair_tudo(portal: Any, tipo: str = "todos") -> list[dict]:
    """Catálogo inteiro do portal (classe 0), sem repetir produto. Aviso de paginação: CatalogoIncompleto."""
    produtos, avisos = portal.catalogo_com_avisos(None, tipo, limite_seguranca=MAX_PAGINAS_CATALOGO_INTEIRO)
    if avisos:
        raise CatalogoIncompleto(f"catálogo de {portal.fonte.slug} possivelmente cortado: {'; '.join(avisos)}")
    out = _deduplicar(produtos, portal.fonte.slug, set())
    log.info("catálogo inteiro de %s: %d produtos recebidos, %d distintos", portal.fonte.slug, len(produtos), len(out))
    return out


def _hash_produto(x: dict) -> str:
    """Versão do conteúdo do produto (auditoria e comparação entre coletas): muda só quando código, descrição, tipo ou
    classe mudam."""
    base = {k: x.get(k) for k in ("codigo_sesc", "descricao", "tipo", "id_categoria")}
    return hashlib.sha256(json.dumps(base, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def linhas_banco(linhas: list[dict], agora: str, contar: bool = True) -> tuple[list[dict], list[dict], int]:
    """(classes, produtos, sem_id) no formato das tabelas da spec 0052 K-1/K-2.

    Classe: uma por (fonte, id_categoria), com o nome visto na coleta. Classe que veio sem nome não leva `nome` nem
    `codigo` no upsert: o nome já gravado fica, e classe nova fica com nome nulo (nunca texto inventado).
    `qtd_produtos` só com `contar` (catálogo inteiro, todos os tipos); senão a coluna não vai no upsert.
    Produto sem nCdProduto não tem chave e fica fora (contado em sem_id). Nenhum campo ausente é preenchido.
    `primeira_coleta_em` não vai no upsert: só o default do banco grava a primeira coleta.
    """
    classes: dict[tuple, dict] = {}
    produtos: list[dict] = []
    sem_id = 0
    for x in linhas:
        if x.get("id_categoria") is not None:
            k = (x["fonte"], x["id_categoria"])
            c = classes.setdefault(k, {"fonte": x["fonte"], "id_classe_fonte": x["id_categoria"],
                                       "ultima_coleta_em": agora, **({"qtd_produtos": 0} if contar else {})})
            if x.get("categoria"):
                c["nome"] = x["categoria"]
                c["codigo"] = _codigo_da_classe(x["categoria"]) or None
            if contar and x.get("id_produto") is not None:
                c["qtd_produtos"] += 1
        if x.get("id_produto") is None:
            sem_id += 1
            continue
        produtos.append({"fonte": x["fonte"], "id_produto_fonte": x["id_produto"],
                         "id_classe_fonte": x.get("id_categoria"), "codigo_entidade": x.get("codigo_sesc"),
                         "descricao": x.get("descricao"), "tipo": x.get("tipo"), "payload_hash": _hash_produto(x),
                         "ultima_coleta_em": agora})
    return list(classes.values()), produtos, sem_id


def _transitorio(e: Exception) -> bool:
    """Timeout, conexão ou 5xx do PostgREST: vale repetir. 4xx (dado ou permissão) não."""
    if isinstance(e, requests.RequestException):
        return True
    return isinstance(e, RuntimeError) and re.match(r"Supabase \S+: 5\d\d ", str(e)) is not None


def _upsert_com_retry(sb: Any, tabela: str, linhas: list[dict], conflito: str, rotulo: str,
                      espera: float = 2.0) -> None:
    for tentativa in range(1, TENTATIVAS_GRAVACAO + 1):
        try:
            sb.upsert(tabela, linhas, conflito, retornar=False)
            return
        except (requests.RequestException, RuntimeError) as e:
            if not _transitorio(e) or tentativa == TENTATIVAS_GRAVACAO:
                log.error("%s: falhou na tentativa %d (%s)", rotulo, tentativa, e)
                raise
            pausa = espera * 2 ** (tentativa - 1) * (1 + random.random())
            log.warning("%s: tentativa %d falhou (%s); nova tentativa em %.1f s", rotulo, tentativa, e, pausa)
            time.sleep(pausa)


def _em_lotes(sb: Any, tabela: str, linhas: list[dict], conflito: str, lote: int, espera: float) -> None:
    total = (len(linhas) + lote - 1) // lote
    for n, i in enumerate(range(0, len(linhas), lote), start=1):
        fonte = linhas[i].get("fonte")
        _upsert_com_retry(sb, tabela, linhas[i:i + lote], conflito, f"{tabela} ({fonte}) lote {n}/{total}", espera)


def gravar_banco(sb: Any, linhas: list[dict], agora: str | None = None, lote: int = LOTE_GRAVACAO,
                 contar: bool = True, espera: float = 2.0) -> dict:
    """Upsert das classes e depois dos produtos (FK), em lotes, com retry de falha transitória. Devolve a contagem.

    Classes com e sem nome vão em upserts separados: o PostgREST exige as mesmas colunas em todas as linhas do lote.
    """
    agora = agora or datetime.now(timezone.utc).isoformat()
    classes, produtos, sem_id = linhas_banco(linhas, agora, contar)
    com_nome = [c for c in classes if "nome" in c]
    sem_nome = [c for c in classes if "nome" not in c]
    if sem_nome:
        log.warning("%d classe(s) sem nome na coleta: o nome já gravado fica (classe nova fica com nome nulo)",
                    len(sem_nome))
    for grupo in (com_nome, sem_nome):
        _em_lotes(sb, TABELA_CLASSES, grupo, "fonte,id_classe_fonte", lote, espera)
    _em_lotes(sb, TABELA_PRODUTOS, produtos, "fonte,id_produto_fonte", lote, espera)
    if sem_id:
        log.warning("%d produto(s) sem nCdProduto ficaram fora do banco (sem chave)", sem_id)
    return {"classes": len(classes), "produtos": len(produtos), "sem_id": sem_id}


def _sem_formula(v: Any) -> Any:
    """Texto que o Excel leria como fórmula ganha um apóstrofo na frente (só no CSV; o JSON guarda o original)."""
    return "'" + v if isinstance(v, str) and v.startswith(_INICIO_FORMULA) else v


def validar_saida(destino: Path, raiz_repo: Path = RAIZ_REPO) -> Path:
    """Extensão .csv/.json, pasta existente e fora do repositório. Falha antes da coleta, não depois."""
    destino = Path(destino)
    if destino.suffix.lower() not in EXTENSOES:
        raise ValueError(f"extensão {destino.suffix!r} não suportada: use .csv ou .json")
    pasta = destino.resolve().parent
    if not pasta.is_dir():
        raise ValueError(f"pasta {pasta} não existe")
    if pasta == raiz_repo or raiz_repo in pasta.parents:
        raise ValueError(f"{destino} fica dentro do repositório ({raiz_repo}); dado de coleta não se versiona")
    return destino


def gravar(linhas: list[dict], destino: Path) -> None:
    """CSV (';', UTF-8 com BOM, abre direto no Excel, sem fórmula) ou JSON, pela extensão."""
    destino = Path(destino)
    if destino.suffix.lower() == ".csv":
        with destino.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=CAMPOS, delimiter=";")
            w.writeheader()
            w.writerows({k: _sem_formula(v) for k, v in x.items()} for x in linhas)
    elif destino.suffix.lower() == ".json":
        destino.write_text(json.dumps(linhas, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        raise ValueError(f"extensão {destino.suffix!r} não suportada: use .csv ou .json")


def main(argv: list[str] | None = None, portal: Any = None, sb: Any = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--fonte", required=True, choices=sorted(FONTES))
    ap.add_argument("--categorias", help="códigos ou nomes exatos, separados por ';' (ex.: PT030;ES1205)")
    ap.add_argument("--tudo", action="store_true", help="catálogo inteiro do portal (todas as classes)")
    ap.add_argument("--tipo", choices=sorted(TIPOS_CATALOGO), default="todos", help="filtro Tipo do catálogo")
    ap.add_argument("--saida", help="arquivo .csv ou .json (fora do repositório)")
    ap.add_argument("--gravar", action="store_true", help="grava classes e produtos no banco (spec 0052 K-1/K-2)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.tudo == (args.categorias is not None):
        log.error("informe --categorias ou --tudo (um dos dois)")
        return 2
    if not args.saida and not args.gravar:
        log.error("informe --saida, --gravar ou os dois")
        return 2
    saida = None
    if args.saida:
        try:
            saida = validar_saida(Path(args.saida))
        except ValueError as e:
            log.error("%s", e)
            return 2
    categorias = [c.strip() for c in (args.categorias or "").split(";") if c.strip()]
    if not args.tudo and not categorias:
        log.error("nenhuma categoria informada")
        return 2
    if args.gravar and sb is None:
        from .destino import Supabase
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True),
                      drenar_catmat=False)
    if portal is None:
        fonte = FONTES[args.fonte]
        portal = PortalParadigma(fonte, delay=float(env("DELAY_SEGUNDOS", "1.5")),
                                 autorizado=autorizado_para_coleta(fonte))
    try:
        linhas = extrair_tudo(portal, args.tipo) if args.tudo else extrair(portal, categorias, args.tipo)
    except CategoriaNaoEncontrada as e:
        log.error("%s", e)
        return 2
    except CatalogoIncompleto as e:
        log.error("%s; nada gravado", e)
        return 3
    sem_codigo = sum(1 for x in linhas if not x["codigo_sesc"])
    if saida is not None:
        gravar(linhas, saida)
        log.info("%d produtos gravados em %s (%d sem código interno)", len(linhas), saida, sem_codigo)
    if args.gravar:
        resumo = gravar_banco(sb, linhas, contar=args.tudo and args.tipo == "todos")
        log.info("banco (%s): %d classes, %d produtos, %d sem id; %d sem código interno", args.fonte,
                 resumo["classes"], resumo["produtos"], resumo["sem_id"], sem_codigo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
