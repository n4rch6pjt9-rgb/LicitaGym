// Casos de teste do hook bloquear-destrutivo.mjs. Rodar: node .claude/hooks/bloquear-destrutivo.test.mjs
// (sem dependências; sai com código 1 se algum caso falhar).
import { motivo } from "./bloquear-destrutivo.mjs";

const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const sql = (query, tool = "mcp__supabase__execute_sql") => ({ tool_name: tool, tool_input: { query } });
// Branch atual simulada: "main" quando o caminho termina em /main-clone, senão "feat/x".
const atual = (dir) => (dir.endsWith("main-clone") ? "main" : "feat/x");
const naMain = (command) => ({ ...bash(command), cwd: "/tmp/main-clone" });

const bloqueia = [
  bash("supabase db reset"), bash("supabase db push --linked"), bash("supabase migration repair --status applied 1"),
  bash("supabase functions deploy api-catmat"),
  bash("git push --force origin feat/x"), bash("git push -f"), bash("git push -fu origin feat/x"), bash("git push -uf origin feat/x"),
  bash("git push --force=origin/feat/x origin feat/x"),
  bash("git push origin main"), bash("git push origin HEAD:main"), bash("git push origin HEAD:refs/heads/main"),
  bash('git push origin HEAD:refs/heads/"main"'),
  bash("git push origin +HEAD:refs/heads/main"), bash("git push origin feat/x:master"), bash("git push --delete origin main"),
  bash("git push --all origin"), bash("git -C /tmp/main-clone push"), bash("git -C ../outro push origin main"),
  naMain("git push"), naMain("git push origin"), naMain("git push -u origin HEAD"), naMain("git add . && git push"),
  bash("terraform destroy"), bash("terraform apply -auto-approve"), bash("wrangler deploy"), bash("npm run cf:deploy"),
  bash("bun run cf:deploy"), bash("gh api -X DELETE repos/a/b"), bash("gh api repos/a/b --method DELETE"),
  bash("gh api --method=DELETE repos/a/b"), bash("gh repo delete a/b"),
  sql("drop table foo"), sql("-- x\n truncate foo"), sql("with c as (delete from users returning *) select * from c"),
  sql("select 1; update t set a = 1"), sql("do $$ begin perform 1; end $$"), sql("insert into t values (1)"),
  sql("select pg_terminate_backend(123)"), sql("grant select on t to anon", "mcp__claude_ai_Supabase_LicitaGym__execute_sql"),
  { tool_name: "mcp__supabase__apply_migration", tool_input: {} },
];
const libera = [
  bash("git push --force-with-lease origin feat/x"), bash("git push -u origin feat/x"), bash("git push"),
  bash("git push origin feat/main-fix"), bash("git commit -m 'push to main docs'"), bash("git log main..HEAD"),
  bash("terraform plan"), bash("npm run build"), bash("npx vitest run"), bash("gh pr view 91"), bash("gh api repos/a/b/pulls"),
  sql("select count(*) from licitacoes_externas"), sql("with a as (select 1) select * from a"),
  sql("select created_at, updated_at from t"), sql("select 'drop table x' as texto"), sql("select * from t for update"),
  { tool_name: "Read", tool_input: { file_path: "x" } },
];

let falhas = 0;
for (const e of bloqueia) if (!motivo(e, atual)) { falhas++; console.error("DEVIA BLOQUEAR:", JSON.stringify(e.tool_input), e.cwd ?? ""); }
for (const e of libera) { const m = motivo(e, atual); if (m) { falhas++; console.error("DEVIA LIBERAR:", JSON.stringify(e.tool_input), "->", m); } }
console.log(`${bloqueia.length + libera.length - falhas}/${bloqueia.length + libera.length} casos OK`);
process.exit(falhas ? 1 : 0);
