"""Backfill de licitacoes_externas.prioridade nas compras PNCP (nova semântica, decisão do owner 29/09/2026).

Antes, `prioridade` vinha do modo de coleta: `leads` = homologada nos últimos 120 dias, e o modo
historico não rebaixava um lead. Agora vem do ESTADO da compra (coletor.pncp.prioridade_da_compra):
  leads = recebendo proposta | monitorar = em julgamento (propostas encerradas, sem resultado)
  historico = homologada / com resultado / revogada / anulada / deserta / fracassada / cancelada
Compra homologada não é lead: as linhas antigas de `leads` com data_homologacao viram `historico`.

Recalcula a partir do que já está gravado (situacao, data_homologacao, data_fim, raw = item da busca,
itens em licitacao_itens). Com --consultar-pncp, relê o detalhe da compra no PNCP (GET, só leitura) das
linhas que o gravado não fecha como historico (o retrato gravado pode estar velho: a compra pode ter
sido homologada/revogada depois da coleta). Indeterminado = não mexe.

Padrão: DRY-RUN (lê, mostra contagem por transição e amostra, não grava nada). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.backfill_prioridade_pncp                        # dry-run, só dados gravados
  python -m coletor.backfill_prioridade_pncp --consultar-pncp --limit 50   # dry-run + detalhe do PNCP
  python -m coletor.backfill_prioridade_pncp --apply                # grava só a coluna prioridade
Falha de consulta ao PNCP não grava nada da consulta (fica o cálculo pelos dados gravados).
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
from datetime import datetime, timezone

from .destino import Supabase, env
from .pncp import PNCP, motivo_prioridade

log = logging.getLogger("coletor.backfill_prioridade_pncp")

SELECT = "id,codigo_externo,prioridade,situacao,data_homologacao,data_fim,raw,licitacao_itens(situacao,tem_resultado)"


def _compra_de_codigo(codigo: str | None) -> dict | None:
    """numero_controle_pncp ({cnpj}-1-{seq}/{ano}) -> dict com o que PNCP.compra()/itens() pedem."""
    m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", codigo or "")
    if not m:
        return None
    return {"orgao_cnpj": m.group(1), "numero_sequencial": int(m.group(2)), "ano": int(m.group(3)),
            "numero_controle_pncp": codigo}


def _consultar(pncp, ln: dict, agora: datetime) -> tuple[str | None, str]:
    """Recalcula com o detalhe atual do PNCP; se o detalhe diz 'propostas encerradas sem resultado',
    confere os itens (deserto/fracassado em todos = encerrada). Levanta se a consulta falhar."""
    c = _compra_de_codigo(ln.get("codigo_externo"))
    if not c:
        raise ValueError(f"codigo_externo inválido: {ln.get('codigo_externo')!r}")
    det = pncp.compra(c)
    # detalhe atual vence o retrato gravado; data_homologacao gravada (resultado já visto) continua valendo
    base = {**det, "data_homologacao": ln.get("data_homologacao")}
    prioridade, motivo = motivo_prioridade(base, agora=agora)
    if prioridade == "monitorar":
        itens = pncp.itens(c)
        prioridade, motivo = motivo_prioridade(base, agora=agora, itens=itens)
    return prioridade, f"PNCP: {motivo}"


def backfill(sb, pncp=None, *, aplicar: bool = False, limite: int | None = None, amostra: int = 5,
             agora: datetime | None = None, consultar_pncp: bool = False) -> dict:
    """Retorna o resumo; em dry-run (aplicar=False) nunca chama sb.atualizar."""
    agora = agora or datetime.now(timezone.utc)
    filtros = {"select": SELECT, "fonte": "eq.pncp", "order": "id"}
    if limite:
        filtros["limit"] = str(limite)
    linhas = sb.selecionar("licitacoes_externas", **filtros)
    r = {"lidas": len(linhas), "sem_mudanca": 0, "mudariam": 0, "gravadas": 0, "indeterminadas": 0,
         "consultadas_pncp": 0, "falha_consulta": 0, "transicoes": {}, "amostra": {}}
    for ln in linhas:
        atual = ln.get("prioridade")
        nova, motivo = motivo_prioridade(ln, agora=agora, itens=ln.get("licitacao_itens") or None)
        if consultar_pncp and pncp is not None and nova != "historico":
            try:
                nova, motivo = _consultar(pncp, ln, agora)
                r["consultadas_pncp"] += 1
            except Exception as e:
                r["falha_consulta"] += 1
                log.warning("  %s: consulta ao PNCP falhou, fica o cálculo pelos dados gravados: %s",
                            ln.get("codigo_externo"), str(e)[:120])
        if nova is None:
            r["indeterminadas"] += 1
            continue
        if nova == atual:
            r["sem_mudanca"] += 1
            continue
        chave = f"{atual or 'NULL'}->{nova}"
        r["mudariam"] += 1
        r["transicoes"][chave] = r["transicoes"].get(chave, 0) + 1
        exemplos = r["amostra"].setdefault(chave, [])
        if len(exemplos) < amostra:
            exemplos.append((ln["id"], ln.get("codigo_externo"), motivo))
        if aplicar:
            try:
                sb.atualizar("licitacoes_externas", ln["id"], {"prioridade": nova})
            except RuntimeError as e:
                if " 401 " in str(e) or " 403 " in str(e):
                    raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY.")
                raise
            r["gravadas"] += 1
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Backfill de prioridade (PNCP) pelo estado da compra")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, não grava nada)")
    ap.add_argument("--limit", type=int, help="máximo de linhas a processar")
    ap.add_argument("--amostra", type=int, default=5, help="exemplos por transição (padrão 5)")
    ap.add_argument("--consultar-pncp", action="store_true",
                    help="relê o detalhe no PNCP (GET) das linhas que os dados gravados não fecham como historico")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    pncp = PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5"))) if args.consultar_pncp else None
    r = backfill(sb, pncp, aplicar=args.apply, limite=args.limit, amostra=args.amostra,
                 consultar_pncp=args.consultar_pncp)
    amostra = r.pop("amostra")
    for chave, n in sorted(r.pop("transicoes").items(), key=lambda kv: -kv[1]):
        print(f"{chave}: {n}")
        for id_, codigo, motivo in amostra.get(chave, []):
            print(f"  #{id_} {codigo}: {motivo}")
    log.info("RESUMO%s: %s", "" if args.apply else " (DRY-RUN, nada gravado; use --apply)", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
