"""Backfill de licitacoes_externas.data_fim e data_publicacao das compras PNCP gravadas com o fuso errado (#332).

Até esta correção, o coletor gravava data_fim e data_publicacao com pncp._data, que lê o texto sem fuso do PNCP
("2026-10-08T10:00", horário de Brasília) como UTC, e o prazo ficava 3 h adiantado. Agora usa pncp._data_pncp. Este script recalcula as duas colunas a partir do bruto já gravado em raw
(data_fim_vigencia e data_publicacao_pncp), sem consultar o PNCP, e grava só o que mudou de instante.

- data_fim normalizado (normalizacoes.data_fim, de normalizacao_prazo, que já usa o fuso do PNCP) não é tocado.
- Sem o campo no raw, a coluna fica como está (nada é inventado).
- Mesmo instante em outra representação não é mudança.

Padrão: DRY-RUN (mostra contagem e amostra, não grava nada). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.backfill_fuso_prazos_pncp --limit 20     # dry-run
  python -m coletor.backfill_fuso_prazos_pncp --apply        # grava
Roteiro: dry-run completo; --apply --limit 20 e conferir a amostra (ex.: #185 com data_fim 10:00-03:00); só então o
--apply completo, fora da janela do Cloud Run Job do coletor. A amostra mostra o valor antigo e o novo; o antigo também
dá para reconstruir do raw (é o mesmo texto lido como UTC).
data_documento, data_resultado e data_homologacao ficam de fora (issue própria): não há o texto original no raw.
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime

from .destino import Supabase, env
from .pncp import _data_pncp

log = logging.getLogger("coletor.backfill_fuso_prazos_pncp")

# coluna gravada -> campo bruto do raw (item da busca do PNCP)
CAMPOS = (("data_fim", "data_fim_vigencia"), ("data_publicacao", "data_publicacao_pncp"))


def _mesmo_instante(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return a == b
    try:
        return datetime.fromisoformat(a.replace("Z", "+00:00")) == datetime.fromisoformat(b)
    except ValueError:
        return False


def correcoes(ln: dict) -> dict | None:
    """Colunas a regravar na linha, ou None se o raw não traz os campos. {} = já correta."""
    raw = ln.get("raw") if isinstance(ln.get("raw"), dict) else None
    if not raw:
        return None
    normalizado = isinstance(ln.get("normalizacoes"), dict) and "data_fim" in ln["normalizacoes"]
    mudancas, algum_campo = {}, False
    for coluna, campo in CAMPOS:
        if coluna == "data_fim" and normalizado:
            continue
        novo = _data_pncp(raw.get(campo))
        if novo is None:
            continue
        algum_campo = True
        if not _mesmo_instante(ln.get(coluna), novo):
            mudancas[coluna] = novo
    return mudancas if algum_campo else None


def backfill(sb, *, aplicar: bool = False, limite: int | None = None, amostra: int = 10) -> dict:
    """Retorna o resumo; em dry-run (aplicar=False) nunca chama sb.atualizar."""
    filtros = {"select": "id,codigo_externo,data_fim,data_publicacao,normalizacoes,raw", "fonte": "eq.pncp",
               "order": "id"}
    if limite:
        filtros["limit"] = str(limite)
    linhas = sb.selecionar("licitacoes_externas", **filtros)
    r = {"lidas": len(linhas), "corrigir": 0, "ja_corretas": 0, "sem_raw": 0, "gravadas": 0, "amostra": []}
    for ln in linhas:
        mudancas = correcoes(ln)
        if mudancas is None:
            r["sem_raw"] += 1
            continue
        if not mudancas:
            r["ja_corretas"] += 1
            continue
        r["corrigir"] += 1
        if len(r["amostra"]) < amostra:
            r["amostra"].append((ln["id"], ln.get("codigo_externo"),
                                 {c: (ln.get(c), novo) for c, novo in mudancas.items()}))
        if aplicar:
            try:
                sb.atualizar("licitacoes_externas", ln["id"], mudancas)
            except RuntimeError as e:
                if " 401 " in str(e) or " 403 " in str(e):
                    raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY.")
                raise
            r["gravadas"] += 1
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Backfill do fuso de data_fim/data_publicacao das compras PNCP (#332)")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, não grava nada)")
    ap.add_argument("--limit", type=int, help="máximo de linhas a processar")
    ap.add_argument("--amostra", type=int, default=10, help="quantas linhas mostrar na amostra (padrão 10)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    r = backfill(sb, aplicar=args.apply, limite=args.limit, amostra=args.amostra)
    for id_, codigo, mudancas in r.pop("amostra"):
        print(f"  #{id_} {codigo}: {mudancas}")
    log.info("RESUMO%s: %s", "" if args.apply else " (DRY-RUN, nada gravado; use --apply)", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
