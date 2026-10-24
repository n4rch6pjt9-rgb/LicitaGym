#!/usr/bin/env bash
# Gera .claude/rules/<area>.md a partir de .github/instructions/<area>.instructions.md.
# Fonte única: .github/instructions (Copilot/Cursor usam `applyTo:`; Claude Code usa `paths:`).
# Uso:  scripts/ci/sincronizar-regras-claude.sh          -> gera
#       scripts/ci/sincronizar-regras-claude.sh --check  -> falha se .claude/rules estiver desatualizado (CI)
set -euo pipefail

raiz="$(cd "$(dirname "$0")/../.." && pwd)"
origem="$raiz/.github/instructions"
destino="$raiz/.claude/rules"
modo="${1:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for f in "$origem"/*.instructions.md; do
  [ -e "$f" ] || continue
  area="$(basename "$f" .instructions.md)"
  saida="$tmp/$area.md"
  # applyTo: "a/**, b/**"  ->  paths: lista YAML
  apply="$(awk 'NR==1 && $0!="---"{exit} /^---$/{n++; if(n==2) exit; next} n==1 && /^applyTo:/{sub(/^applyTo:[ ]*/,""); gsub(/"/,""); print}' "$f")"
  {
    echo "---"
    if [ -n "$apply" ]; then
      echo "paths:"
      IFS=',' read -ra globs <<< "$apply"
      for g in "${globs[@]}"; do
        g="$(echo "$g" | xargs)"
        [ -n "$g" ] && echo "  - \"$g\""
      done
    fi
    echo "---"
    echo "<!-- GERADO de .github/instructions/$area.instructions.md por scripts/ci/sincronizar-regras-claude.sh. Não edite aqui. -->"
    # corpo sem o frontmatter original
    awk 'NR==1 && $0!="---"{print; body=1; next} body{print; next} /^---$/{n++; if(n==2){body=1}; next}' "$f"
  } > "$saida"
done

if [ "$modo" = "--check" ]; then
  falhou=0
  for g in "$tmp"/*.md; do
    nome="$(basename "$g")"
    if ! diff -q "$g" "$destino/$nome" >/dev/null 2>&1; then
      echo "desatualizado: .claude/rules/$nome (rode scripts/ci/sincronizar-regras-claude.sh)"; falhou=1
    fi
  done
  exit "$falhou"
fi

mkdir -p "$destino"
cp "$tmp"/*.md "$destino"/
echo "regras geradas em .claude/rules/: $(ls "$tmp" | tr '\n' ' ')"
