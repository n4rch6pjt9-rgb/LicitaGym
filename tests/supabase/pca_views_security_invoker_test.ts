import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATION =
  "./supabase/migrations/20260930190000_pca_views_security_invoker.sql";
const ACL_CHECK = "./supabase/tests/pca_views_security_invoker_check.sql";

const VIEWS = [
  "public.pca_alteracoes_resumo",
  "public.pca_conversao_edital_item",
  "public.pca_conversao_edital_taxa",
];

/** SQL sem comentários de linha, para os asserts não casarem com o cabeçalho. */
async function sqlSemComentarios(path: string): Promise<string> {
  return (await Deno.readTextFile(path)).replace(/--[^\n]*/g, "");
}

Deno.test("views PCA: security_invoker = true nas três", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  for (const v of VIEWS) {
    assert(
      new RegExp(
        `alter view ${
          v.replace(".", "\\.")
        }\\s+set \\(security_invoker = true\\);`,
      ).test(sql),
      `${v} sem security_invoker`,
    );
  }
});

Deno.test("views PCA: revoke de anon/PUBLIC e authenticated/service_role só com SELECT", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  const revoke = sql.match(
    /revoke all on table([\s\S]*?)from PUBLIC, anon, authenticated, service_role;/,
  )?.[1] ?? "";
  const grant =
    sql.match(/grant select on table([\s\S]*?)to authenticated, service_role;/)
      ?.[1] ?? "";
  for (const v of VIEWS) {
    assert(revoke.includes(v), `${v} fora do revoke`);
    assert(grant.includes(v), `${v} fora do grant select`);
  }
  assertEquals(
    /grant [^;]*\banon\b/i.test(sql),
    false,
    "nenhum grant para anon",
  );
  assertEquals(
    /grant [^;]*\bpublic\b\s*;/i.test(sql.replace(/public\.\w+/g, "")),
    false,
    "nenhum grant para PUBLIC",
  );
  assertEquals(
    /grant (all|insert|update|delete|truncate)/i.test(sql),
    false,
    "só SELECT",
  );
});

Deno.test("views PCA: migration só mexe em ACL/opções (sem DML nem DROP) e roda numa transação", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assertEquals(
    /\b(insert into|update public\.|delete from|drop (view|table|policy))\b/i
      .test(sql),
    false,
  );
  assert(/^\s*begin;/m.test(sql) && /^\s*commit;/m.test(sql));
  assert(sql.includes("set local lock_timeout"));
});

Deno.test("check SQL cobre as três views, anon/PUBLIC e security_invoker", async () => {
  const sql = await Deno.readTextFile(ACL_CHECK);
  for (const v of VIEWS) assert(sql.includes(`'${v}'`), `${v} fora do check`);
  assert(sql.includes("security_invoker=true"));
  assert(sql.includes("('anon'), ('public')"));
  assert(sql.includes("has_any_column_privilege"));
  assertEquals(
    /\b(insert|update|delete|alter|grant|revoke)\b\s/i.test(
      sql.replace(/--[^\n]*/g, ""),
    ),
    false,
    "check só lê",
  );
});
