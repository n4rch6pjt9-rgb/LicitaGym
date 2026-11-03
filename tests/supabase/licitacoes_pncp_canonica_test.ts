import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20261003170000_licitacoes_pncp_canonica.sql";
const CHECK = "./supabase/tests/licitacoes_pncp_canonica_check.sql";
const FIXTURES = "./supabase/tests/licitacoes_pncp_canonica_fixtures_check.sql";
const VIEW = "public.licitacoes_pncp_canonica";
const PRIO = "public.licitacoes_externas_prioridade_efetiva";

/** SQL sem comentários de linha, para os asserts não casarem com o cabeçalho. */
async function sqlSemComentarios(path: string): Promise<string> {
  return (await Deno.readTextFile(path)).replace(/--[^\n]*/g, "");
}

/** Corpo de uma view da migration (do create até o ";" que fecha o statement). */
function corpo(sql: string, nome: string): string {
  const i = sql.indexOf(`create or replace view public.${nome}`);
  if (i < 0) return "";
  const fim = sql.indexOf(";\n", i);
  return sql.slice(i, fim + 1);
}

Deno.test("canônica PNCP: só views, idempotente, security_invoker, sem DROP nem escrita", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(/create or replace view public\.licitacoes_pncp_canonica\s+with \(security_invoker = true\) as/.test(sql));
  assertEquals(/\bdrop\b/i.test(sql), false, "sem DROP");
  assertEquals(/\b(insert into|update public\.|delete from|truncate|alter table|create table)\b/i.test(sql), false, "sem DML/DDL de tabela");
  // toda view é create or replace (create view puro falharia na segunda aplicação)
  assertEquals(/create view/i.test(sql), false);
  for (const v of ["licitacoes_externas_prioridade_efetiva", "v_bi_resultados_itens", "oportunidades_borracha", "v_bi_orgaos_match", "v_bi_fornecedor_historico"]) {
    assert(corpo(sql, v).length > 0, `${v} ausente`);
  }
  assert(/^begin;/m.test(sql) && /^commit;/m.test(sql), "transação única");
});

Deno.test("canônica PNCP: só service_role lê a view nova e a de prioridade", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  for (const v of [VIEW, PRIO]) {
    assert(sql.includes(`revoke all on table ${v}\n  from PUBLIC, anon, authenticated, service_role;`), `revoke ${v}`);
    assert(sql.includes(`grant select on table ${v} to service_role;`), `grant ${v}`);
  }
  const grants = sql.match(/grant [^;]*;/gi) ?? [];
  assertEquals(grants.length, 2, "só os dois grants para service_role");
  for (const g of grants) assert(/^grant select on table [a-z_.]+ to service_role;$/.test(g), `grant inesperado: ${g}`);
});

Deno.test("canônica PNCP: chave só PNCP com órgão/processo/edital NOT NULL e ordem da regra aprovada", async () => {
  const v = corpo(await sqlSemComentarios(MIGRATION), "licitacoes_pncp_canonica");
  assert(v.includes("l.fonte = 'pncp'"));
  for (const c of ["l.orgao_cnpj is not null", "l.processo_norm is not null", "l.numero_edital is not null"]) assert(v.includes(c), c);
  assert(v.includes("having count(*) > 1"));
  assert(v.includes("i.valor_unitario_estimado > 0"), "itens com valor");
  const ordem = v.match(/order by ([\s\S]*?)\n\s*\)/)?.[1].replace(/\s+/g, " ").trim();
  assertEquals(
    ordem,
    "m.data_fim desc nulls last, m.itens_com_valor desc, m.n_resultados desc, (m.valor_total is not null) desc, m.data_publicacao desc nulls last, m.id",
  );
  // toda linha da tabela aparece (left join), fora de grupo é canônica de si mesma
  assert(v.includes("left join ordenados o on o.id = l.id"));
  assert(v.includes("coalesce(o.canonica_id, l.id) as canonica_id"));
  assert(v.includes("(o.canonica_id is null or o.canonica_id = l.id) as eh_canonica"));
});

Deno.test("canônica PNCP: prioridade efetiva expõe canonica_id/eh_canonica no fim, regra intacta", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  const prio = corpo(sql, "licitacoes_externas_prioridade_efetiva");
  assert(prio.includes(
    "end as prioridade_motivo,\n  c.canonica_id,\n  c.eh_canonica\nfrom public.licitacoes_externas l\n" +
      "join public.licitacoes_pncp_canonica c on c.id = l.id\n",
  ));
  // a regra da prioridade é a mesma de 20260930200000 (só rebaixa)
  const base = await sqlSemComentarios("./supabase/migrations/20260930200000_licitacoes_prioridade_efetiva.sql");
  const antes = corpo(base, "licitacoes_externas_prioridade_efetiva").replace(/\) j;$/, "");
  const semCanonica = prio
    .replace("end as prioridade_motivo,\n  c.canonica_id,\n  c.eh_canonica\n", "end as prioridade_motivo\n")
    .replace("join public.licitacoes_pncp_canonica c on c.id = l.id\n", "")
    .replace(/\) j;$/, "");
  assertEquals(semCanonica, antes);
});

Deno.test("canônica PNCP: as 4 views BI só contam a publicação canônica", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(corpo(sql, "v_bi_resultados_itens").includes("join public.licitacoes_pncp_canonica cn on cn.id = l.id and cn.eh_canonica"));
  assert(corpo(sql, "oportunidades_borracha").includes("join public.licitacoes_pncp_canonica cn on cn.id = l.id and cn.eh_canonica"));
  assert(corpo(sql, "v_bi_orgaos_match").includes("and l.prioridade = 'historico'\n    and l.eh_canonica\n"));
  const forn = corpo(sql, "v_bi_fornecedor_historico");
  assert(/and l\.eh_canonica\n/.test(forn), "f_resultados só canônica");
  // ponte Compras.gov -> PNCP aponta para o número de controle da canônica
  assert(forn.includes("lc.codigo_externo as numero_controle_pncp_compra"));
  assert(forn.includes("join public.licitacoes_pncp_canonica cn on cn.id = le.id"));
});

Deno.test("canônica PNCP: não mexe no RAG (indexador e match_licitacao_chunks_v2 são do PR do RAG)", async () => {
  const sql = (await Deno.readTextFile(MIGRATION)).replace(/--[^\n]*/g, "");
  assertEquals(/match_licitacao_chunks|licitacao_chunks|licitacao_documentos/i.test(sql), false);
});

Deno.test("canônica PNCP: verificação só leitura e fixtures com rollback", async () => {
  const check = await sqlSemComentarios(CHECK);
  // sem os literais ('INSERT', 'UPDATE'... são nomes de privilégio testados com has_table_privilege)
  const semLiterais = check.replace(/'[^']*'/g, "''");
  assertEquals(/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate)\b/i.test(semLiterais), false, "check só leitura");
  assert(check.includes(VIEW));
  const fx = await Deno.readTextFile(FIXTURES);
  assert(/^begin;/m.test(fx) && /^rollback;/m.test(fx.trimEnd().split("\n").slice(-3).join("\n")), "fixtures em begin/rollback");
  assertEquals(/^commit;/m.test(fx), false);
  assertEquals(/supabase\.co|eyJ[A-Za-z0-9_-]{10,}/.test(fx), false, "sem URL/chave de Supabase");
});
