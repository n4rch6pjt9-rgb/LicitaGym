#!/usr/bin/env node
// Hook PreToolUse do Claude Code: barreira determinística contra ações destrutivas ou que publicam em produção.
// Uma regra escrita só no prompt some quando o contexto é comprimido; esta é consultada em toda chamada.
// Entrada: JSON do hook no stdin ({tool_name, tool_input}). Bloqueio: exit 2 + motivo no stderr (o agente vê o motivo).
// Não substitui as barreiras fora do agente (MCP somente leitura, proteção de branch, aprovação de environment).
import { readFileSync } from "node:fs";

const REGRAS_COMANDO = [
  [/\bsupabase\s+db\s+(reset|push)\b/, "supabase db reset/push: migrations vão para produção só pelo merge do PR (integração Supabase ↔ GitHub)."],
  [/\bsupabase\s+migration\s+repair\b/, "supabase migration repair altera o histórico de produção: o usuário roda, com a saída do `migration list` à vista."],
  [/\bsupabase\s+(functions|secrets|projects|branches)\s+(delete|unset)\b/, "remoção de função/segredo/projeto/branch no Supabase."],
  [/\bsupabase\s+functions\s+deploy\b/, "deploy de Edge Function é feito pela CI (deploy-supabase-functions.yml) após o merge."],
  [/\bgit\s+push\b(?=[^;&|]*\s(--force|-f)(\s|$))/, "git push --force: use --force-with-lease numa branch de feature, nunca na main."],
  [/\bgit\s+push\b[^;&|]*[\s:+](main|master)(\s|$|;|&|\|)/, "push direto na main: toda mudança entra por PR revisado."],
  [/\bgit\s+push\b[^;&|]*\s--delete\s[^;&|]*\b(main|master)\b/, "apagar a main."],
  [/\bterraform\s+(destroy|apply|import)\b|\bterraform\s+state\s+(rm|push|mv)\b/, "terraform apply/destroy/state só na CI do licitagym-infra, depois do plan revisado."],
  [/\bwrangler\s+(delete|secret\s+delete|r2\s+bucket\s+delete|kv\s+namespace\s+delete|d1\s+delete)\b/, "remoção de recurso na Cloudflare."],
  [/\bwrangler\s+deploy\b/, "deploy do Dashboard é feito pelo usuário (npm run cf:deploy) ou pela CI com aprovação."],
  [/\bgh\s+repo\s+(delete|archive)\b/, "apagar/arquivar repositório."],
  [/\bgh\s+api\b[^;&|]*-X\s*DELETE\b/i, "gh api com DELETE."],
];

// SQL enviado ao MCP do Supabase: só leitura (o servidor já é read_only; isto é a segunda barreira).
const SQL_ESCRITA = /(^|;)\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke|comment|vacuum|reindex|cluster|copy|call|do)\b/i;
const FERRAMENTAS_MCP_BLOQUEADAS = /__(apply_migration|deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|pause_project|restore_project)$/;

function motivo(entrada) {
  const nome = entrada.tool_name ?? "";
  const input = entrada.tool_input ?? {};
  if (nome.startsWith("mcp__")) {
    if (FERRAMENTAS_MCP_BLOQUEADAS.test(nome)) return `${nome}: escrita em produção só por migration + PR revisado.`;
    const sql = input.query ?? input.sql ?? "";
    if (/__execute_sql$/.test(nome) && SQL_ESCRITA.test(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " "))) {
      return "SQL de escrita pelo MCP: o MCP do Supabase é somente leitura; escreva uma migration ou peça ao usuário no SQL Editor.";
    }
    return null;
  }
  const cmd = String(input.command ?? "").replace(/\s+/g, " ");
  for (const [rx, texto] of REGRAS_COMANDO) if (rx.test(cmd)) return texto;
  return null;
}

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
