#!/usr/bin/env node
// Hook PostToolUse do Claude Code: lint só do arquivo que o agente acabou de editar.
// O lint do pre-commit e da CI continua valendo; este hook só antecipa o erro, para o agente corrigir na hora
// em vez de descobrir no commit. Reaproveita scripts/ci/lint-alterados.sh (mesmas regras, mesmo recorte de arquivos).
// Entrada: JSON do hook no stdin ({tool_name, tool_input: {file_path}, cwd}). Falha de lint: exit 2 + saída no stderr
// (o Claude Code devolve o stderr ao agente). Qualquer outra situação (arquivo fora do recorte, bash ausente, ferramenta
// ausente, tempo esgotado, entrada ilegível) não bloqueia: exit 0.
// Casos de teste: .claude/hooks/lint-pos-edicao.test.mjs (node .claude/hooks/lint-pos-edicao.test.mjs).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FERRAMENTAS_DE_EDICAO = new Set(["Edit", "Write", "MultiEdit"]);
const LIMITE_SAIDA = 4000; // caracteres devolvidos ao agente
const TEMPO_MAXIMO_MS = 60_000;

// Devolve o caminho do arquivo relativo à raiz do repositório se ele entra no recorte do lint, senão null.
// Mesmo recorte de scripts/ci/lint-alterados.sh: .ts/.tsx em supabase/functions e tests/supabase (menos _shared_prod) e .py.
export function arquivoParaLint(entrada, raiz) {
  if (!FERRAMENTAS_DE_EDICAO.has(entrada.tool_name ?? "")) return null;
  const alvo = entrada.tool_input?.file_path;
  if (typeof alvo !== "string" || alvo === "") return null;
  const rel = relative(raiz, resolve(entrada.cwd || raiz, alvo)).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null; // fora do repositório
  if (rel.split("/").pop().startsWith("-")) return null; // nunca vira opção do script
  if (/^supabase\/functions\/[^/]+\/_shared_prod\//.test(rel)) return null; // cópia antiga, a eliminar
  if (/^(supabase\/functions|tests\/supabase)\/.+\.tsx?$/.test(rel)) return rel;
  if (/\.py$/.test(rel)) return rel;
  return null;
}

// Roda o lint do arquivo. `rodar` é injetável para teste. Devolve { codigo, mensagem }.
export function executarLint(rel, raiz, rodar = spawnSync) {
  const r = rodar("bash", ["scripts/ci/lint-alterados.sh", rel], {
    cwd: raiz,
    encoding: "utf8",
    timeout: TEMPO_MAXIMO_MS,
    // Sem deno/ruff instalado, o script só avisa (como no pre-commit) em vez de falhar.
    env: { ...process.env, PULAR_SEM_FERRAMENTA: "1" },
  });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") return { codigo: 0, mensagem: `Lint de ${rel} passou de ${TEMPO_MAXIMO_MS / 1000} s e foi ignorado pelo hook; a CI roda de novo.` };
    return { codigo: 0, mensagem: "" }; // bash ausente (ENOENT) ou erro ao iniciar: a CI roda de novo
  }
  if (r.status === 0) return { codigo: 0, mensagem: "" };
  const saida = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const corte = saida.length > LIMITE_SAIDA ? `${saida.slice(0, LIMITE_SAIDA)}\n[saída cortada]` : saida;
  return { codigo: 2, mensagem: `Lint de ${rel} falhou (corrija antes de seguir):\n${corte}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let entrada = {};
  try {
    entrada = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0); // entrada ilegível: não decide
  }
  const raiz = process.env.CLAUDE_PROJECT_DIR || entrada.cwd || process.cwd();
  const rel = arquivoParaLint(entrada, raiz);
  if (!rel) process.exit(0);
  const { codigo, mensagem } = executarLint(rel, raiz);
  if (mensagem) process.stderr.write(`${mensagem}\n`);
  process.exit(codigo);
}
