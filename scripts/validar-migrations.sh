#!/usr/bin/env bash
# Valida as migrations num Postgres descartável (Docker), sem tocar em produção.
#  1. sobe pgvector/pgvector:pg16 e aplica supabase/tests/pre.sql (stubs de auth/storage/roles do Supabase);
#  2. aplica todas as migrations em ordem;
#  3. reaplica as migrations novas/alteradas em relação à base (idempotência);
#  4. roda todos os supabase/tests/*_check.sql (falham com EXCEPTION).
# Uso: scripts/validar-migrations.sh [base_git]   (padrão: origin/main)
# Requer: docker, git. Sai com código != 0 se algo falhar.
set -uo pipefail

BASE="${1:-origin/main}"
IMG="pgvector/pgvector:pg16"
NOME="lg-validar-migrations-$$"
RAIZ="$(git rev-parse --show-toplevel)"
# Migrations que dependem de extensão ausente no Postgres puro (só existem no Supabase)
PULAR="202609180008_cron.sql 20260930180000_cron_sync_jobs.sql"

cd "$RAIZ"
if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "Base '$BASE' não encontrada (rode git fetch ou informe outra base)."; exit 2
fi
if ! NOVAS=$(git diff --name-only --diff-filter=AM "$BASE"...HEAD -- 'supabase/migrations/2*.sql'); then
  echo "git diff contra '$BASE' falhou."; exit 2
fi
limpar() { docker rm -f "$NOME" >/dev/null 2>&1; }
trap limpar EXIT
docker run -d --name "$NOME" -e POSTGRES_PASSWORD=x "$IMG" >/dev/null
psql_() { docker run -i --rm --network "container:$NOME" -e PGPASSWORD=x "$IMG" \
  psql -q -h 127.0.0.1 -U postgres -tA -v ON_ERROR_STOP=1 -f - ; }
for _ in $(seq 1 30); do echo 'select 1' | psql_ >/dev/null 2>&1 && break; sleep 2; done

falhas=0
aplicar() { # $1 arquivo, $2 rótulo
  local saida
  case " $PULAR " in *" $(basename "$1") "*) echo "pulada $2 $(basename "$1") (extensão só no Supabase)"; return;; esac
  if saida=$(psql_ < "$1" 2>&1); then
    echo "ok     $2 $(basename "$1") $(grep -o 'SUCESSO.*' <<<"$saida" | head -1)"
  else
    echo "FALHA  $2 $(basename "$1"): $(grep -m1 ERROR <<<"$saida")"; falhas=$((falhas + 1))
  fi
}

aplicar supabase/tests/pre.sql "stubs "
for f in $(ls supabase/migrations/2*.sql | sort); do aplicar "$f" "migr  "; done
echo "migrations novas/alteradas vs $BASE: $(wc -w <<<"$NOVAS")"
for f in $(sort <<<"$NOVAS"); do
  aplicar "$f" "2a vez"
done
for f in supabase/tests/*_check.sql; do aplicar "$f" "check "; done

echo "---"
if [ "$falhas" -gt 0 ]; then echo "$falhas falha(s)."; exit 1; fi
echo "Tudo OK."
