"""Leva para o Supabase Storage os arquivos que ficaram fora do LicitaGym (disco da VM ou GCS).

Em 26/09/2026 havia 43 documentos do SEST SENAT gravados em /home/<vm>/licitagym-coletor-sestsenat/dados/...
Rodar NA MÁQUINA onde estão os arquivos:
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_STORAGE_BUCKET=licitacao-documentos
  python -m coletor.migrar_storage --dry-run
  python -m coletor.migrar_storage
O arquivo original não é apagado. A linha só troca de storage_uri depois de o upload conferir o sha256.
"""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import re
import sys

from .destino import Supabase, SupabaseStorage, env, sha256
from .indexador import ler_arquivo

log = logging.getLogger("coletor.migrar_storage")


def caminho_destino(uri: str) -> str:
    """'/home/x/.../dados/sestsenat/59/10/processo/a.pdf' ou 'gs://b/sestsenat/...' -> 'sestsenat/59/10/processo/a.pdf'."""
    if uri.startswith("gs://"):
        return uri[5:].split("/", 1)[1]
    m = re.search(r"(?:^|/)dados/(.+)$", uri.replace("\\", "/"))
    if not m:
        raise ValueError(f"caminho local fora do padrão .../dados/...: {uri}")
    return m.group(1)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Migra documentos para o Supabase Storage")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url, chave = env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True)
    sb, st = Supabase(url, chave), SupabaseStorage(url, chave, env("SUPABASE_STORAGE_BUCKET", "licitacao-documentos"))
    docs = sb.selecionar("licitacao_documentos", select="id,storage_uri,sha256,mime_type",
                         storage_uri="not.like.supabase://*", order="id")
    docs = [d for d in docs if d.get("storage_uri")]
    resumo = {"encontrados": len(docs), "migrados": 0, "erros": 0}
    for d in docs:
        try:
            destino = caminho_destino(d["storage_uri"])
            if args.dry_run:
                print(f"{d['id']}: {d['storage_uri']} -> supabase://{st.bucket}/{destino}")
                continue
            conteudo = ler_arquivo(d["storage_uri"])
            if d.get("sha256") and sha256(conteudo) != d["sha256"]:
                raise RuntimeError("sha256 do arquivo local não confere com o banco")
            ctype = d.get("mime_type") or mimetypes.guess_type(destino)[0] or "application/octet-stream"
            nova = st.salvar(destino, conteudo, ctype)
            if sha256(st.ler(nova)) != sha256(conteudo):
                raise RuntimeError("conferência pós-upload falhou")
            sb.atualizar("licitacao_documentos", d["id"], {"storage_uri": nova})
            resumo["migrados"] += 1
        except Exception as e:
            resumo["erros"] += 1
            log.warning("documento %s: %s", d["id"], e)
    print(json.dumps(resumo, ensure_ascii=False))
    return 1 if resumo["erros"] else 0


if __name__ == "__main__":
    sys.exit(main())
