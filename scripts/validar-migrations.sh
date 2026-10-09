#!/usr/bin/env bash
# Valida as migrations num Postgres descartável (Docker), sem tocar em produção.
#  1. sobe pgvector/pgvector:pg17 (mesma versão major da produção; troque com PG_IMAGE) e aplica supabase/tests/pre.sql (stubs de auth/storage/roles do Supabase);
#  2. aplica todas as migrations em ordem;
#  3. reaplica as migrations novas/alteradas em relação à base (idempotência);
#  4. roda todos os supabase/tests/*_check.sql (falham com EXCEPTION).
# Arquivos em supabase/tests/pendentes.txt podem falhar (PENDENTE, com issue); se passarem, a validação falha
# até saírem da lista.
# Uso: scripts/validar-migrations.sh [base_git]   (padrão: origin/main)
# Requer: docker, git. Sai com código != 0 se algo falhar.
set -uo pipefail

BASE="${1:-origin/main}"
IMG="${PG_IMAGE:-pgvector/pgvector:pg17}"
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
if ! docker run -d --name "$NOME" -e POSTGRES_PASSWORD=x "$IMG" >/dev/null; then
  echo "Não subiu o Postgres ($IMG): docker indisponível ou imagem não baixou."; exit 2
fi
psql_() { docker run -i --rm --network "container:$NOME" -e PGPASSWORD=x "$IMG" \
  psql -q -h 127.0.0.1 -U postgres -tA -v ON_ERROR_STOP=1 -f - ; }
pronto=0
for _ in $(seq 1 30); do echo 'select 1' | psql_ >/dev/null 2>&1 && { pronto=1; break; }; sleep 2; done
if [ "$pronto" -ne 1 ]; then echo "Postgres ($IMG) não respondeu em 60 s."; exit 2; fi
echo "Postgres: $(echo 'show server_version' | psql_)"

# Lista: "<arquivo> | <trecho do erro esperado> | <issue>". Só vale para checks: migration (ou pre.sql) listada
# derrubaria o portão em silêncio, e o trecho garante que só a falha conhecida vira PENDENTE.
declare -A PEND
if [ -f supabase/tests/pendentes.txt ]; then
  while IFS='|' read -r nome trecho _; do
    nome="$(echo "$nome" | xargs)"; case "$nome" in ''|\#*) continue;; esac
    case "$nome" in *_check.sql) ;; *) echo "supabase/tests/pendentes.txt só aceita *_check.sql (achei '$nome')."; exit 2;; esac
    trecho="$(echo "$trecho" | sed 's/^ *//; s/ *$//')"
    [ -n "$trecho" ] || { echo "supabase/tests/pendentes.txt: '$nome' sem trecho de erro esperado."; exit 2; }
    PEND["$nome"]="$trecho"
  done < supabase/tests/pendentes.txt
fi
falhas=0; pendentes=0
aplicar() { # $1 arquivo, $2 rótulo
  local saida pend=0
  case "$2" in check*) [ -n "${PEND[$(basename "$1")]+x}" ] && pend=1;; esac
  case " $PULAR " in *" $(basename "$1") "*) echo "pulada $2 $(basename "$1") (extensão só no Supabase)"; return;; esac
  if saida=$(psql_ < "$1" 2>&1); then
    if [ "$pend" -eq 1 ]; then
      echo "FALHA  $2 $(basename "$1"): passou, mas está em supabase/tests/pendentes.txt (tire da lista)"; falhas=$((falhas + 1)); return
    fi
    echo "ok     $2 $(basename "$1") $(grep -o 'SUCESSO.*' <<<"$saida" | head -1)"
  elif [ "$pend" -eq 1 ] && grep -qF -- "${PEND[$(basename "$1")]}" <<<"$saida"; then
    echo "PENDENTE $2 $(basename "$1"): ${PEND[$(basename "$1")]}"; pendentes=$((pendentes + 1))
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
[ "$pendentes" -gt 0 ] && echo "$pendentes pendente(s) conhecida(s) (supabase/tests/pendentes.txt)."
if [ "$falhas" -gt 0 ]; then echo "$falhas falha(s)."; exit 1; fi
echo "Tudo OK."
