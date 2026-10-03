"""Cliente SOMENTE LEITURA sobre arquivos CSV exportados do banco, para o dry-run offline do reclassificador
(reclassificar_escopo_pncp --entrada-dir). Quem lê o banco é o bot LicitaGym Supabase, com o SQL de export
(RECLASSIFICAR-FORTE-EXPORT.sql); este cliente só responde selecionar/rpc a partir dos CSVs, com os mesmos nomes de
tabela e os filtros PostgREST que o coletor usa (eq., in., gte., lte., and=(id.gte.X,id.lte.Y), limit/offset).
Qualquer escrita levanta PermissionError: não há banco do outro lado.

Arquivos do diretório (cabeçalho na 1ª linha; vazio = NULL; booleanos t/f/true/false):
  compras.csv          -> licitacoes_externas: id, codigo_externo, fonte, objeto, title, categoria_escopo,
                          interesse_borracha, prioridade, fase, situacao (title vai para raw.title)
  itens.csv            -> licitacao_itens: id, licitacao_id, numero_item, descricao, material_ou_servico, situacao,
                          tem_resultado, categoria_escopo, interesse_borracha, catalogo_codigo_item, catalogo_id
  mapa.csv             -> rpc/catmat_itens_mapa: codigo_item, codigo_pdm
  pdms_efetivos.csv    -> rpc catalogo_catmat_pdms_efetivos: codigo_pdm
  regras_item.csv      -> catalogo_empresa_catmat (nivel item): codigo_item, codigo_pdm, incluido
  itens_catalogo.csv   -> catmat_item_pdm: codigo_item, codigo_pdm, descricao
"""
from __future__ import annotations

import csv
import os
import re

ARQUIVOS = {
    "licitacoes_externas": "compras.csv",
    "licitacao_itens": "itens.csv",
    "rpc/catmat_itens_mapa": "mapa.csv",
    "catalogo_catmat_pdms_efetivos": "pdms_efetivos.csv",
    "catalogo_empresa_catmat": "regras_item.csv",
    "catmat_item_pdm": "itens_catalogo.csv",
}
_INTEIROS = {"id", "licitacao_id", "numero_item", "codigo_item", "codigo_pdm", "catalogo_id"}
_BOOLEANOS = {"interesse_borracha", "tem_resultado", "incluido"}
_VAZIO_OK = {"licitacao_documentos"}   # sem documentos no export: só escopo (--so-escopo)


def _valor(coluna: str, v: str | None):
    if v is None or v == "":
        return None
    if coluna in _INTEIROS:
        return int(v)
    if coluna in _BOOLEANOS:
        b = v.strip().lower()
        if b in ("t", "true", "1"):
            return True
        if b in ("f", "false", "0"):
            return False
        raise ValueError(f"booleano inválido em {coluna}: {v!r}")
    return v


def _casa(valor, cond: str) -> bool:
    op, _, arg = cond.partition(".")
    if op == "eq":
        return str(valor) == arg if not isinstance(valor, bool) else str(valor).lower() == arg.lower()
    if op == "in":
        return str(valor) in {x.strip() for x in arg.strip("()").split(",")}
    if op in ("gte", "lte"):
        if valor is None:
            return False
        return valor >= int(arg) if op == "gte" else valor <= int(arg)
    raise ValueError(f"filtro não suportado no dry-run offline: {cond!r}")


class ClienteArquivos:
    def __init__(self, diretorio: str):
        self.diretorio = diretorio
        self._tabelas: dict[str, list[dict]] = {}
        for tabela, nome in ARQUIVOS.items():
            caminho = os.path.join(diretorio, nome)
            if not os.path.exists(caminho):
                raise FileNotFoundError(f"dry-run offline: falta {caminho}")
            with open(caminho, encoding="utf-8", newline="") as fh:
                linhas = [{k: _valor(k, v) for k, v in ln.items()} for ln in csv.DictReader(fh)]
            if tabela == "licitacoes_externas":
                for ln in linhas:
                    ln["raw"] = {"title": ln.pop("title", None)}
            self._tabelas[tabela] = linhas

    def selecionar(self, tabela: str, **filtros):
        if tabela in _VAZIO_OK:
            return []
        if tabela not in self._tabelas:
            raise KeyError(f"dry-run offline: tabela sem arquivo: {tabela}")
        f = dict(filtros)
        f.pop("select", None)
        f.pop("order", None)
        limite = int(f.pop("limit")) if "limit" in f else None
        offset = int(f.pop("offset", 0) or 0)
        conds: list[tuple[str, str]] = []
        e = f.pop("and", None)
        if e:
            for parte in e.strip("()").split(","):
                col, _, cond = parte.partition(".")
                conds.append((col, cond))
        conds += list(f.items())
        out = [ln for ln in self._tabelas[tabela] if all(_casa(ln.get(c), cond) for c, cond in conds)]
        out = out[offset:]
        return out[:limite] if limite is not None else out

    def rpc(self, funcao: str, params: dict):
        if funcao != "catalogo_catmat_pdms_efetivos":
            raise PermissionError(f"dry-run offline: rpc {funcao} bloqueada")
        return list(self._tabelas[funcao])

    def __getattr__(self, nome):
        if re.match(r"^(upsert|atualizar|inserir|drenar|deletar|apagar)", nome):
            raise PermissionError(f"dry-run offline: {nome} bloqueado (sem banco)")
        raise AttributeError(nome)
