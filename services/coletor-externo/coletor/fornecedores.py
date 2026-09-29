"""Cadastro de fornecedores dos certames: consulta de CNPJ (dados públicos da Receita) -> public.fornecedores.

Todo coletor que grava licitacao_resultados passa os CNPJs dos participantes para `CadastroFornecedores.cadastrar`.
Só grava dado de pessoa jurídica. O QSA (sócios, pessoas físicas) é descartado antes de gravar (LGPD).

Provedores públicos, sem chave (testados em 26/09/2026):
  1. BrasilAPI      https://brasilapi.com.br/api/cnpj/v1/{cnpj}
  2. Minha Receita  https://minhareceita.org/{cnpj}      (mesmo formato; usado quando o 1 falha)
Regras:
  - CNPJ com dígito verificador inválido não é consultado.
  - 404/400 do provedor = CNPJ inexistente -> grava com consulta_status='nao_encontrado'.
  - Falha de rede/limite (429/5xx) em todos os provedores -> erro contado; nunca vira cadastro vazio.
  - Cache: não reconsulta CNPJ consultado há menos de `validade_dias` (padrão 30).

Uso avulso (backfill a partir do que já está em licitacao_resultados):
  python -m coletor.fornecedores --de-resultados [--dry-run]
  python -m coletor.fornecedores --cnpj 24.608.949/0001-37 --dry-run
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import requests

log = logging.getLogger("coletor.fornecedores")

UA = "LicitaGym-Coletor/1.1 (cadastro de fornecedores de licitações públicas)"
PROVEDORES = [
    ("brasilapi", "https://brasilapi.com.br/api/cnpj/v1/{cnpj}"),
    ("minhareceita", "https://minhareceita.org/{cnpj}"),
]
# CNAEs típicos do mercado fitness (para marcar, não para filtrar)
CNAES_FITNESS = {
    3230200: "Fabricação de artefatos para pesca e esporte",
    4649499: "Comércio atacadista de outros equipamentos e artigos de uso pessoal e doméstico",
    4763602: "Comércio varejista de artigos esportivos",
    4789099: "Comércio varejista de outros produtos não especificados",
    4669999: "Comércio atacadista de outras máquinas e equipamentos",
    3329599: "Fabricação de produtos diversos",
    3250701: "Fabricação de instrumentos não eletrônicos e utensílios para uso médico",
    4664800: "Comércio atacadista de máquinas, aparelhos e equipamentos para uso odonto-médico-hospitalar",
}


def so_digitos(v: Any) -> str:
    return re.sub(r"\D", "", v if isinstance(v, str) else str(v or ""))


def cnpj_valido(v: Any) -> str | None:
    """14 dígitos com DV correto -> dígitos; senão None."""
    d = so_digitos(v)
    if len(d) != 14 or d == d[0] * 14:
        return None
    def dv(base: str) -> int:
        pesos = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2][-len(base):]
        r = sum(int(c) * p for c, p in zip(base, pesos)) % 11
        return 0 if r < 2 else 11 - r
    return d if dv(d[:12]) == int(d[12]) and dv(d[:13]) == int(d[13]) else None


def _data(v: Any) -> str | None:
    return v if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v) else None


def _fone(ddd_tel: Any) -> str | None:
    d = so_digitos(ddd_tel)
    return d or None


_CPF_SOLTO = re.compile(r"(?<!\d)(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?!\d)")


def mascarar_cpf(v: Any) -> Any:
    """Razão social de MEI/empresário individual traz o CPF do titular: mascara no padrão da Receita (***123456**)."""
    if isinstance(v, str):
        return _CPF_SOLTO.sub(lambda m: f"***{m.group(2)}{m.group(3)}**", v)
    if isinstance(v, dict):
        return {k: mascarar_cpf(x) for k, x in v.items()}
    if isinstance(v, list):
        return [mascarar_cpf(x) for x in v]
    return v


def pessoa_fisica_titular(dados: dict) -> bool:
    """Empresário individual / MEI: os contatos e o endereço completo são da pessoa física titular."""
    nat = (dados.get("natureza_juridica") or "").lower()
    return bool(dados.get("opcao_pelo_mei")) or "empresário (individual)" in nat or "empresario (individual)" in nat \
        or str(dados.get("codigo_natureza_juridica")) == "2135"


def linha_fornecedor(cnpj: str, dados: dict | None, provedor: str, status: str = "ok",
                     agora: datetime | None = None) -> dict:
    """Resposta BrasilAPI/Minha Receita -> linha de public.fornecedores (sem QSA)."""
    agora = agora or datetime.now(timezone.utc)
    base = {"cnpj": cnpj, "cnpj_raiz": cnpj[:8], "consulta_status": status, "consulta_fonte": provedor,
            "consultado_em": agora.isoformat()}
    if not dados:
        return base
    pf = pessoa_fisica_titular(dados)
    dados = mascarar_cpf({k: v for k, v in dados.items() if k != "cnpj"}) | {"cnpj": dados.get("cnpj")}
    cnae = dados.get("cnae_fiscal")
    secs = [{"codigo": c.get("codigo"), "descricao": c.get("descricao")}
            for c in (dados.get("cnaes_secundarios") or []) if isinstance(c, dict) and c.get("codigo")]
    todos = {cnae} | {c["codigo"] for c in secs}
    fones = [f for f in (_fone(dados.get("ddd_telefone_1")), _fone(dados.get("ddd_telefone_2"))) if f]
    raw = {k: v for k, v in dados.items() if k != "qsa"}  # sócios pessoa física não são gravados
    if pf:  # empresário individual/MEI: sem contato e endereço detalhado do titular
        fones = []
        for k in ("email", "ddd_telefone_1", "ddd_telefone_2", "ddd_fax", "logradouro", "numero", "complemento"):
            raw.pop(k, None)
    return {
        **base,
        "razao_social": dados.get("razao_social"),
        "nome_fantasia": (dados.get("nome_fantasia") or "").strip() or None,
        "matriz_filial": dados.get("descricao_identificador_matriz_filial"),
        "situacao_cadastral": dados.get("descricao_situacao_cadastral"),
        "data_situacao_cadastral": _data(dados.get("data_situacao_cadastral")),
        "data_inicio_atividade": _data(dados.get("data_inicio_atividade")),
        "natureza_juridica": dados.get("natureza_juridica"),
        "porte": dados.get("porte"),
        "opcao_simples": dados.get("opcao_pelo_simples"),
        "opcao_mei": dados.get("opcao_pelo_mei"),
        "capital_social": dados.get("capital_social"),
        "cnae_principal": cnae,
        "cnae_principal_descricao": dados.get("cnae_fiscal_descricao"),
        "cnaes_secundarios": secs,
        "cnae_fitness": bool(todos & set(CNAES_FITNESS)),
        # Fabricante = CNAE principal na indústria de transformação (divisões 10 a 33); senão comércio/serviço.
        "fabricante": bool(cnae) and 10 <= int(str(cnae).zfill(7)[:2]) <= 33,
        "uf": dados.get("uf"),
        "municipio": dados.get("municipio"),
        "codigo_municipio_ibge": dados.get("codigo_municipio_ibge"),
        "cep": so_digitos(dados.get("cep")) or None,
        "logradouro": None if pf else (" ".join(x for x in (dados.get("descricao_tipo_de_logradouro"),
                                                             dados.get("logradouro")) if x) or None),
        "numero": None if pf else dados.get("numero"),
        "complemento": None if pf else (dados.get("complemento") or None),
        "bairro": dados.get("bairro"),
        "email": None if pf else ((dados.get("email") or "").strip().lower() or None),
        "titular_pessoa_fisica": pf,
        "telefones": fones,
        "raw": raw,
    }


class ConsultaCNPJ:
    """Consulta com fallback entre provedores públicos. Erro de todos os provedores levanta exceção."""

    def __init__(self, delay: float = 1.0, timeout: int = 30, sessao: requests.Session | None = None):
        self.delay = delay
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def consultar(self, cnpj: str) -> tuple[dict | None, str, str]:
        """(dados | None, provedor, status) com status 'ok' ou 'nao_encontrado'."""
        erros = []
        for nome, url in PROVEDORES:
            for tentativa in range(3):
                try:
                    r = self.s.get(url.format(cnpj=cnpj), timeout=self.timeout)
                    time.sleep(self.delay)
                except requests.RequestException as e:
                    erros.append(f"{nome}: {e}")
                    time.sleep(2 ** tentativa)
                    continue
                if r.status_code == 200:
                    return r.json(), nome, "ok"
                if r.status_code in (400, 404):
                    return None, nome, "nao_encontrado"
                erros.append(f"{nome}: HTTP {r.status_code}")
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(2 ** tentativa * 2)
                    continue
                break
        raise RuntimeError(f"CNPJ {cnpj}: nenhum provedor respondeu ({'; '.join(erros[-3:])})")


class CadastroFornecedores:
    """Recebe CNPJs de uma pesquisa/certame, consulta os que faltam (ou vencidos) e grava em public.fornecedores."""

    def __init__(self, sb=None, consulta: ConsultaCNPJ | None = None, validade_dias: int = 30, dry_run: bool = False):
        self.sb = sb
        self.consulta = consulta or ConsultaCNPJ()
        self.validade = timedelta(days=validade_dias)
        self.dry_run = dry_run
        self._feitos: set[str] = set()  # cache da execução (vários itens/certames repetem o mesmo fornecedor)

    def _frescos(self, cnpjs: list[str]) -> set[str]:
        if self.sb is None or not cnpjs:
            return set()
        limite = (datetime.now(timezone.utc) - self.validade).isoformat()
        out: set[str] = set()
        for i in range(0, len(cnpjs), 100):
            lote = cnpjs[i:i + 100]
            rows = self.sb.selecionar("fornecedores", select="cnpj", cnpj=f"in.({','.join(lote)})",
                                      consultado_em=f"gte.{limite}")
            out |= {r["cnpj"] for r in rows}
        return out

    def cadastrar(self, cnpjs: Iterable[Any]) -> dict:
        resumo = {"recebidos": 0, "invalidos": 0, "em_cache": 0, "consultados": 0, "nao_encontrados": 0, "erros": 0,
                  "linhas": []}
        validos: list[str] = []
        for c in cnpjs:
            resumo["recebidos"] += 1
            d = cnpj_valido(c)
            if not d:
                resumo["invalidos"] += 1
            elif d not in self._feitos and d not in validos:
                validos.append(d)
        frescos = self._frescos(validos)
        resumo["em_cache"] = len(frescos)
        for cnpj in validos:
            if cnpj in frescos:
                self._feitos.add(cnpj)
                continue
            try:
                dados, prov, status = self.consulta.consultar(cnpj)
            except Exception as e:  # erro nunca vira cadastro vazio
                resumo["erros"] += 1
                log.warning("fornecedor %s: %s", cnpj, e)
                continue
            linha = linha_fornecedor(cnpj, dados, prov, status)
            resumo["consultados"] += 1
            resumo["nao_encontrados"] += status == "nao_encontrado"
            resumo["linhas"].append(linha)
            self._feitos.add(cnpj)
            if not self.dry_run and self.sb is not None:
                self.sb.upsert("fornecedores", linha, "cnpj")
        return resumo


def cnpjs_de_resultados(sb, pagina: int = 1000) -> list[str]:
    """CNPJs distintos já gravados em licitacao_resultados (serve PNCP e Paradigma)."""
    vistos: set[str] = set()
    ini = 0
    while True:
        rows = sb.selecionar("licitacao_resultados", select="fornecedor_cnpj", fornecedor_cnpj="not.is.null",
                             order="id", offset=str(ini), limit=str(pagina))
        vistos |= {r["fornecedor_cnpj"] for r in rows}
        if len(rows) < pagina:
            return sorted(vistos)
        ini += pagina


def main(argv: list[str] | None = None) -> int:
    from .destino import Supabase, env

    ap = argparse.ArgumentParser(description="Cadastro de fornecedores por CNPJ")
    ap.add_argument("--cnpj", action="append", help="CNPJ (pode repetir)")
    ap.add_argument("--de-resultados", action="store_true", help="todos os CNPJs de licitacao_resultados")
    ap.add_argument("--validade-dias", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    precisa_banco = args.de_resultados or not args.dry_run
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True)) \
        if precisa_banco else None
    cnpjs = list(args.cnpj or []) + (cnpjs_de_resultados(sb) if args.de_resultados else [])
    r = CadastroFornecedores(sb, validade_dias=args.validade_dias, dry_run=args.dry_run).cadastrar(cnpjs)
    for l in r.pop("linhas"):
        print(f"{l['cnpj']} | {l.get('razao_social')} | {l.get('porte')} | {l.get('uf')}/{l.get('municipio')} | "
              f"CNAE {l.get('cnae_principal')} {'(fitness)' if l.get('cnae_fitness') else ''} | {l['consulta_status']}")
    print(json.dumps(r, ensure_ascii=False))
    return 1 if r["erros"] and not r["consultados"] else 0


if __name__ == "__main__":
    sys.exit(main())
