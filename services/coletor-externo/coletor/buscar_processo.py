"""Busca um certame pelo PROCESSO ADMINISTRATIVO (e, opcionalmente, pelo CNPJ do órgão).

Nunca busque pelo número do edital ("PE 001/2026"): ele se repete entre órgãos.
  python3 -m coletor.buscar_processo "00007.20260204/0002-28"
  python3 -m coletor.buscar_processo "00007.20260204/0002-28" --cnpj 07.540.925/0001-74
"""
from __future__ import annotations

import argparse
import re

from .destino import Supabase, env


def so_digitos(v: str | None) -> str:
    return re.sub(r"\D", "", v or "")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("processo")
    ap.add_argument("--cnpj", help="CNPJ do órgão (recomendado: o mesmo processo pode ter várias compras)")
    a = ap.parse_args(argv)
    proc = so_digitos(a.processo)
    if len(proc) < 4:
        raise SystemExit("Informe o número do processo administrativo completo.")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    filtros = {"processo_norm": f"eq.{proc}"}
    if a.cnpj:
        filtros["orgao_cnpj"] = f"eq.{so_digitos(a.cnpj)}"
    achou = 0
    for tabela, campos in (("licitacoes_externas", "id,fonte,codigo_externo,numero_processo,numero_edital,orgao_cnpj,orgao_nome,unidade_compradora,objeto,situacao"),
                           ("contratacoes_editais", "id,numero_controle_pncp,numero_processo,orgao_cnpj,objeto,status")):
        try:
            linhas = sb.selecionar(tabela, select=campos, **filtros)
        except Exception as e:
            raise SystemExit(f"{tabela}: {e}\nAplicou supabase/migrations/20260926100000_processo_administrativo.sql?")
        for ln in linhas:
            achou += 1
            print(f"[{tabela}] processo {ln.get('numero_processo')} | órgão {ln.get('orgao_cnpj')} "
                  f"{ln.get('orgao_nome') or ln.get('unidade_compradora') or ''}\n"
                  f"   {ln.get('codigo_externo') or ln.get('numero_controle_pncp') or ln.get('id')} | "
                  f"{ln.get('numero_edital') or ''} | {(ln.get('objeto') or '')[:120]}")
    if not achou:
        print(f"Processo {a.processo} não está no banco. Ele ainda não foi coletado "
              "(o PNCP não pesquisa por processo; é preciso o CNPJ do órgão para localizar as compras dele).")
    else:
        print(f"\n{achou} registro(s). Um mesmo processo pode ter várias compras.")


if __name__ == "__main__":
    main()
