#!/usr/bin/env node
// Hook PreToolUse do Claude Code: barreira determinística contra ações destrutivas ou que publicam em produção.
// Uma regra escrita só no prompt some quando o contexto é comprimido; esta é consultada em toda chamada.
// Entrada: JSON do hook no stdin ({tool_name, tool_input, cwd}). Bloqueio: exit 2 + motivo no stderr.
// Não substitui as barreiras fora do agente (MCP somente leitura, proteção de branch, aprovação de environment).
// Casos de teste: .claude/hooks/bloquear-destrutivo.test.mjs (node .claude/hooks/bloquear-destrutivo.test.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGRAS_COMANDO = [
  [/\bsupabase\s+db\s+(reset|push)\b/, "supabase db reset/push: migrations vão para produção só pelo merge do PR (integração Supabase ↔ GitHub)."],
  [/\bsupabase\s+migration\s+repair\b/, "supabase migration repair altera o histórico de produção: o usuário roda, com a saída do `migration list` à vista."],
  [/\bsupabase\s+(functions|secrets|projects|branches)\s+(delete|unset)\b/, "remoção de função/segredo/projeto/branch no Supabase."],
  [/\bsupabase\s+functions\s+deploy\b/, "deploy de Edge Function é feito pela CI (deploy-supabase-functions.yml) após o merge."],
  [/\bterraform\s+(destroy|apply|import)\b|\bterraform\s+state\s+(rm|push|mv)\b/, "terraform apply/destroy/state só na CI do licitagym-infra, depois do plan revisado."],
  [/\bwrangler\s+(delete|secret\s+delete|r2\s+bucket\s+delete|kv\s+namespace\s+delete|d1\s+delete)\b/, "remoção de recurso na Cloudflare."],
  [/\bwrangler\s+deploy\b/, "deploy do Dashboard é feito pelo usuário (npm run cf:deploy) ou pela CI com aprovação."],
  [/\b(npm|bun|pnpm|yarn)\s+(run\s+)?cf:deploy\b/, "deploy do Dashboard é feito pelo usuário, com o .env.production.local dele."],
  [/\bgh\s+repo\s+(delete|archive)\b/, "apagar/arquivar repositório."],
  [/\bgh\s+api\b[^;&|]*(\s-X\s*|\s--method[\s=]+)["']?DELETE\b/i, "gh api com DELETE."],
];

const PROTEGIDAS = new Set(["main", "master"]);

// Divide em palavras respeitando aspas simples/duplas (suficiente para linhas de comando de agente).
function palavras(texto) {
  const out = [];
  for (const m of texto.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function branchAtual(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Analisa cada `git [-C dir] [opções] push ...` do comando. Devolve o motivo do bloqueio ou null.
export function motivoGitPush(comando, cwd = process.cwd(), atual = branchAtual) {
  for (const trecho of comando.split(/&&|\|\||;|\||\n/)) {
    const p = palavras(trecho.trim());
    const iGit = p.findIndex((w) => /(^|[\\/])git(\.exe)?$/.test(w));
    if (iGit < 0) continue;
    let dir = cwd;
    let i = iGit + 1;
    for (; i < p.length && p[i] !== "push"; i++) {
      if (p[i] === "-C" && p[i + 1]) dir = resolve(dir, p[++i]);
      else if (!p[i].startsWith("-")) break; // outro subcomando (commit, log...)
    }
    if (p[i] !== "push") continue;

    const posicionais = [];
    for (const w of p.slice(i + 1)) {
      if (w === "--force" || w.startsWith("--force=")) return "git push --force: use --force-with-lease numa branch de feature, nunca na main.";
      if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(w)) return "git push -f (ou -fu, -uf...): use --force-with-lease numa branch de feature.";
      if (w === "--all" || w === "--mirror") return "git push --all/--mirror também empurra a main.";
      if (!w.startsWith("-")) posicionais.push(w);
    }
    const refspecs = posicionais.slice(1); // o primeiro é o remoto
    const cur = () => atual(dir);
    if (refspecs.length === 0) {
      const b = cur();
      if (b === null) return "git push sem refspec e branch atual desconhecida: informe a branch explicitamente.";
      if (PROTEGIDAS.has(b)) return `git push estando na ${b}: toda mudança entra por PR revisado.`;
      continue;
    }
    for (const r of refspecs) {
      let destino = r.replace(/^\+/, "");
      if (destino.includes(":")) destino = destino.split(":").pop();
      destino = destino.replace(/^refs\/heads\//, "");
      if (destino === "HEAD" || destino === "@") destino = cur() ?? "HEAD";
      if (PROTEGIDAS.has(destino) || destino === "HEAD") return "push direto na main: toda mudança entra por PR revisado.";
    }
  }
  return null;
}

// SQL enviado ao MCP do Supabase: só leitura (o servidor já é read_only; isto é a segunda barreira).
// Olha o texto inteiro (inclusive CTEs como `with x as (delete ... returning *) select ...`), sem literais e comentários.
const SQL_ESCRITA = new RegExp(
  [
    String.raw`\binsert\s+into\b`, String.raw`\bupdate\s+[\w."]+\s+set\b`, String.raw`\bdelete\s+from\b`,
    String.raw`\bmerge\s+into\b`, String.raw`\b(drop|truncate|alter|create|grant|revoke|comment\s+on|vacuum|reindex|cluster|refresh\s+materialized|copy|call)\b`,
    String.raw`(^|;)\s*do\b`, String.raw`\bpg_(terminate|cancel)_backend\b`, String.raw`\bdblink_exec\b`, String.raw`\blo_unlink\b`,
  ].join("|"),
  "i",
);
const FERRAMENTAS_MCP_BLOQUEADAS = /__(apply_migration|deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|pause_project|restore_project)$/;

export function sqlSemLiterais(sql) {
  return sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function motivo(entrada, atual = branchAtual) {
  const nome = entrada.tool_name ?? "";
  const input = entrada.tool_input ?? {};
  if (nome.startsWith("mcp__")) {
    if (FERRAMENTAS_MCP_BLOQUEADAS.test(nome)) return `${nome}: escrita em produção só por migration + PR revisado.`;
    const sql = String(input.query ?? input.sql ?? "");
    if (/__execute_sql$/.test(nome) && (SQL_ESCRITA.test(sqlSemLiterais(sql)) || /(^|;)\s*do\s*\$/i.test(sql))) {
      return "SQL de escrita pelo MCP: o MCP do Supabase é somente leitura; escreva uma migration ou peça ao usuário no SQL Editor.";
    }
    return null;
  }
  const bruto = String(input.command ?? "");
  const cmd = bruto.replace(/\s+/g, " ");
  for (const [rx, texto] of REGRAS_COMANDO) if (rx.test(cmd)) return texto;
  return motivoGitPush(bruto, entrada.cwd || process.cwd(), atual);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let entrada = {};
  try {
    entrada = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0); // entrada ilegível: não decide (as demais barreiras continuam valendo)
  }
  const m = motivo(entrada);
  if (m) {
    process.stderr.write(`Bloqueado por .claude/hooks/bloquear-destrutivo.mjs: ${m}\n`);
    process.exit(2);
  }
  process.exit(0);
}
