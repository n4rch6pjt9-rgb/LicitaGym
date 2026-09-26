"""Confere se um documento gravado no Supabase é idêntico ao publicado hoje no portal SEST SENAT.

Baixa de novo o arquivo direto do portal, calcula o sha256 e compara com licitacao_documentos.sha256.
Também salva a cópia em ./verificacao/ para você abrir (Cloud Shell: botão ⋮ → Download).

  python3 -m coletor.verificar_documento --id 214
  python3 -m coletor.verificar_documento --processo 3866-1/2026      # todos os baixados do processo
"""
from __future__ import annotations

import argparse
import os

from .destino import Supabase, env, sha256
from .portal import PortalSestSenat


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--id", type=int, help="licitacao_documentos.id")
    g.add_argument("--processo", help="numero_processo (ex.: 3866-1/2026)")
    a = ap.parse_args(argv)

    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    if a.id:
        docs = sb.selecionar("licitacao_documentos", id=f"eq.{a.id}", select="*")
    else:
        lic = sb.selecionar("licitacoes_externas", numero_processo=f"eq.{a.processo}", fonte="eq.sestsenat", select="id")
        if not lic:
            raise SystemExit(f"Processo {a.processo} não encontrado.")
        docs = sb.selecionar("licitacao_documentos", licitacao_id=f"eq.{lic[0]['id']}", sha256="not.is.null", select="*")
    if not docs:
        raise SystemExit("Nenhum documento encontrado.")

    portal = PortalSestSenat(delay=float(env("DELAY_SEGUNDOS", "1.5")))
    os.makedirs("verificacao", exist_ok=True)
    cache: dict[tuple, dict] = {}
    iguais = 0
    for d in docs:
        lic = sb.selecionar("licitacoes_externas", id=f"eq.{d['licitacao_id']}",
                            select="id_externo,modulo,anexo_raiz_id,numero_processo")[0]
        chave = (lic["id_externo"], d["secao"])
        if chave not in cache:
            if d["secao"] == "processo":
                arqs = portal.anexos_processo(lic["anexo_raiz_id"])
            else:
                arqs = portal.anexos_secao(d["secao"], lic["anexo_raiz_id"], lic["id_externo"], lic["modulo"] or 59)
            cache[chave] = {x.arquivo_origem: x for x in arqs}
        atual = cache[chave].get(d["arquivo_origem"])
        if not atual or not atual.parametro_download:
            print(f"#{d['id']} {d['nome_original']}: NÃO está mais publicado no portal (ou mudou de nome interno)")
            continue
        conteudo, _ = portal.baixar(atual.parametro_download)
        h = sha256(conteudo)
        destino = os.path.join("verificacao", f"{d['id']}-{os.path.basename(d['nome_original'] or 'arquivo')}")
        with open(destino, "wb") as f:
            f.write(conteudo)
        ok = h == d.get("sha256")
        iguais += ok
        print(f"#{d['id']} {lic['numero_processo']} | {d['nome_original']}\n"
              f"   gravado : {d.get('sha256')}\n   portal  : {h}\n"
              f"   {'IDÊNTICO ✔' if ok else 'DIFERENTE ✘ (o portal publicou outra versão)'}  → cópia em {destino}")
    print(f"\n{iguais}/{len(docs)} documentos idênticos ao portal.")


if __name__ == "__main__":
    main()
