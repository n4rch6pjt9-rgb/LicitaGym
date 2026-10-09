#!/usr/bin/env bash
# Teste do Marcelo para a #262: roda scripts/teste-262-producao.sql (só leitura, statement_timeout 20 s) em produção.
# Uso (a senha fica fora do histórico do shell): read -rs DATABASE_URL; export DATABASE_URL; scripts/teste-262-producao.sh
# DATABASE_URL = string de conexão do Postgres do projeto, com ?sslmode=require. O script não a grava nem a imprime.
# O caminho mais simples continua sendo colar o .sql no SQL Editor do Supabase.
# Sai 0 quando a consulta roda; compare a linha com a "Saída esperada" no topo do .sql (antes e depois do merge).
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL (string de conexão do Postgres do projeto)}"
cd "$(git rev-parse --show-toplevel)"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off -x -f scripts/teste-262-producao.sql
