/**
 * Garante que as colunas lidas de public.licitacoes_externas pelas Edge Functions
 * existem de fato no schema versionado em supabase/migrations.
 *
 * O schema é reconstruído a partir de:
 *   - CREATE TABLE [IF NOT EXISTS] [public.]licitacoes_externas (...)
 *   - ALTER TABLE [IF EXISTS] [ONLY] [public.]licitacoes_externas ADD COLUMN [IF NOT EXISTS] ...
 *   - ALTER TABLE ... DROP COLUMN [IF EXISTS] ... (remove)
 *   - ALTER TABLE ... RENAME COLUMN a TO b
 * em ordem de nome de arquivo (= ordem de aplicação).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1";
import { ACOMPANHAMENTO_LICITACAO_COLUMNS } from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import { PUBLIC_LICITACAO_COLUMNS } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";

const MIGRATIONS_DIR = fromFileUrl(new URL("../../../supabase/migrations/", import.meta.url));
const TABLE = "licitacoes_externas";
const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?`;

/** Remove comentários SQL (`-- ...` e `/* ... *\/`). */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function unquote(ident: string): string {
  return ident.replace(/^"|"$/g, "");
}

/** Divide o corpo do CREATE TABLE em itens de nível superior (vírgulas fora de parênteses). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Retorna o índice do parêntese que fecha o aberto em `openIdx`. */
function matchParen(sql: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const CONSTRAINT_KEYWORDS = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like"]);

export function applyMigration(sqlRaw: string, columns: Set<string>): void {
  const sql = stripComments(sqlRaw);

  const createRe = new RegExp(String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${TABLE_REF}\s*\(`, "gi");
  for (const m of sql.matchAll(createRe)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(sql, open);
    if (close < 0) continue;
    for (const item of splitTopLevel(sql.slice(open + 1, close))) {
      const first = item.trim().match(/^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/);
      if (!first) continue;
      const name = unquote(first[1]);
      if (!first[1].startsWith('"') && CONSTRAINT_KEYWORDS.has(name.toLowerCase())) continue;
      columns.add(first[1].startsWith('"') ? name : name.toLowerCase());
    }
  }

  // ALTER TABLE: cada instrução vai até o próximo ';'.
  const alterRe = new RegExp(String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${TABLE_REF}\s+([^;]*)`, "gi");
  for (const m of sql.matchAll(alterRe)) {
    const actions = m[1];
    for (const a of actions.matchAll(/add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi)) {
      const raw = a[1];
      const name = unquote(raw);
      if (!raw.startsWith('"') && CONSTRAINT_KEYWORDS.has(name.toLowerCase())) continue; // ADD CONSTRAINT / ADD PRIMARY KEY ...
      columns.add(raw.startsWith('"') ? name : name.toLowerCase());
    }
    for (const d of actions.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi)) {
      const name = unquote(d[1]);
      columns.delete(d[1].startsWith('"') ? name : name.toLowerCase());
    }
    for (const r of actions.matchAll(/rename\s+column\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+to\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/gi)) {
      const from = r[1].startsWith('"') ? unquote(r[1]) : r[1].toLowerCase();
      const to = r[2].startsWith('"') ? unquote(r[2]) : r[2].toLowerCase();
      if (columns.delete(from)) columns.add(to);
    }
  }
}

async function loadLicitacoesExternasColumns(): Promise<Set<string>> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();
  const columns = new Set<string>();
  for (const f of files) {
    applyMigration(await Deno.readTextFile(`${MIGRATIONS_DIR}${f}`), columns);
  }
  return columns;
}

/** Nome de coluna do PostgREST sem aspas vira minúsculo no Postgres. */
function normalizeSelected(col: string): string {
  const c = col.trim();
  return c.startsWith('"') ? unquote(c) : c.toLowerCase();
}

Deno.test("parser de migrations: CREATE TABLE + ADD/DROP/RENAME COLUMN", () => {
  const cols = new Set<string>();
  applyMigration(
    `-- comentário: add column fantasma text
     create table if not exists public.licitacoes_externas (
       id bigint generated always as identity primary key,
       fonte text not null, -- 'x', y
       valor numeric(12, 2),
       "CamelCase" text,
       unique (fonte, id),
       constraint c1 check (valor > 0)
     );
     create table public.outra (nao_conta text);
     alter table public.licitacoes_externas
       add column if not exists orgao_cnpj text,
       add column uf text,
       add constraint k unique (uf);
     alter table public.outra add column tambem_nao text;
     alter table licitacoes_externas drop column if exists valor;
     alter table public.licitacoes_externas rename column uf to sigla_uf;`,
    cols,
  );
  assertEquals([...cols].sort(), ["CamelCase", "fonte", "id", "orgao_cnpj", "sigla_uf"].sort());
});

Deno.test("licitacoes_externas: schema das migrations contém colunas conhecidas e não contém linkSistemaOrigem", async () => {
  const cols = await loadLicitacoesExternasColumns();
  for (const c of ["id", "fonte", "raw", "codigo_externo", "orgao_cnpj", "prioridade", "processo_norm", "status_normalizado"]) {
    assert(cols.has(c), `coluna esperada ausente no parser: ${c}`);
  }
  assertEquals(cols.has("linkSistemaOrigem"), false);
  assertEquals(cols.has("linksistemaorigem"), false);
});

Deno.test("acompanhamento: toda coluna selecionada existe em licitacoes_externas", async () => {
  const cols = await loadLicitacoesExternasColumns();
  const missing = ACOMPANHAMENTO_LICITACAO_COLUMNS.map(normalizeSelected).filter((c) => !cols.has(c));
  assertEquals(missing, [], `colunas inexistentes no select de acompanhamento: ${missing.join(", ")}`);
});

Deno.test("list/get: toda coluna de PUBLIC_LICITACAO_COLUMNS existe em licitacoes_externas", async () => {
  const cols = await loadLicitacoesExternasColumns();
  const selected = PUBLIC_LICITACAO_COLUMNS.split(",").map(normalizeSelected);
  const missing = selected.filter((c) => !cols.has(c));
  assertEquals(missing, [], `colunas inexistentes em PUBLIC_LICITACAO_COLUMNS: ${missing.join(", ")}`);
});
