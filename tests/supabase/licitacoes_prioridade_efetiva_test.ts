import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATION =
  "./supabase/migrations/20260930200000_licitacoes_prioridade_efetiva.sql";
const CHECK = "./supabase/tests/licitacoes_prioridade_efetiva_check.sql";
const VIEW = "public.licitacoes_externas_prioridade_efetiva";
const FN = "private.pncp_instante_brt(text)";

/** SQL sem comentários de linha, para os asserts não casarem com o cabeçalho. */
async function sqlSemComentarios(path: string): Promise<string> {
  return (await Deno.readTextFile(path)).replace(/--[^\n]*/g, "");
}

/** Corpo da view (do "as select" até o ";" final da definição). */
function corpoDaView(sql: string): string {
  return sql.match(
    /create or replace view public\.licitacoes_externas_prioridade_efetiva[\s\S]*?\) j;/,
  )?.[0] ?? "";
}

Deno.test("prioridade efetiva: view idempotente com security_invoker", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(
    /create or replace view public\.licitacoes_externas_prioridade_efetiva\s+with \(security_invoker = true\) as/
      .test(sql),
  );
  assert(
    /create or replace function private\.pncp_instante_brt\(p_valor text\)/
      .test(sql),
  );
  assert(/create schema if not exists private;/.test(sql));
  assertEquals(/\bdrop\b/i.test(sql), false, "sem DROP");
});

Deno.test("prioridade efetiva: só service_role lê a view e executa a função", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(
    sql.includes(
      `revoke all on table ${VIEW}\n  from PUBLIC, anon, authenticated, service_role;`,
    ),
  );
  assert(sql.includes(`grant select on table ${VIEW} to service_role;`));
  assert(
    sql.includes(
      `revoke all on function ${FN} from PUBLIC, anon, authenticated, service_role;`,
    ),
  );
  assert(sql.includes(`grant execute on function ${FN} to service_role;`));
  const grants = sql.match(/grant [^;]*;/gi) ?? [];
  assertEquals(grants.length, 2, "só os dois grants para service_role");
  for (const g of grants) {
    assert(/to service_role;$/.test(g), `grant fora do service_role: ${g}`);
    assertEquals(/\b(anon|authenticated|public)\b\s*(,|;)/i.test(g), false);
  }
  assertEquals(
    /grant (all|insert|update|delete|truncate)/i.test(sql),
    false,
    "só SELECT/EXECUTE",
  );
});

Deno.test("prioridade efetiva: regra só rebaixa (nunca produz 'leads' por conta própria)", async () => {
  const view = corpoDaView(await sqlSemComentarios(MIGRATION));
  assert(view.length > 0, "view não encontrada");
  assert(view.includes("when e.encerramento is not null then 'historico'"));
  assert(view.includes("when j.prazo_encerrado then 'monitorar'"));
  assert(view.includes("else l.prioridade"));
  assertEquals(/then 'leads'/.test(view), false, "nenhum ramo promove a leads");
  // rebaixa para monitorar só a partir de leads
  assert(
    /l\.prioridade = 'leads'\s+and coalesce\(private\.pncp_instante_brt\(l\.raw ->> 'data_fim_vigencia'\), l\.data_fim\) <= now\(\)/
      .test(view),
  );
  for (
    const sinal of [
      "l.data_homologacao is not null",
      "from public.licitacao_resultados r where r.licitacao_id = l.id",
      "l.raw ->> 'tem_resultado'",
      "l.raw ->> 'cancelado'",
      "coalesce(nullif(l.situacao, ''), l.raw ->> 'situacao_nome', '')",
    ]
  ) assert(view.includes(sinal), `sinal de encerramento ausente: ${sinal}`);
  assert(view.includes("l.prioridade as prioridade_gravada"));
  assert(view.includes("as prioridade_motivo"));
});

Deno.test("prioridade efetiva: regex de situação igual à do coletor", async () => {
  const view = corpoDaView(await sqlSemComentarios(MIGRATION));
  const py = await Deno.readTextFile(
    "./services/coletor-externo/coletor/pncp.py",
  );
  const m = py.match(
    /_SITUACAO_ENCERRADA = re\.compile\(r"([^"]+)"\s*\n\s*r"([^"]+)"/,
  );
  assert(m, "regex do coletor não encontrada");
  const termosPy = (m[1] + m[2]).split("|").filter(Boolean).sort();
  const termosSql = view.match(/~\* '\(([^)]+)\)'/)?.[1].split("|").sort() ??
    [];
  assertEquals(termosSql, termosPy);
});

Deno.test("prioridade efetiva: prazo sem fuso em BRT e inválido não derruba a view", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(sql.includes("at time zone 'America/Sao_Paulo'"));
  assert(/exception\s+when data_exception then\s+return null;/.test(sql));
  assert(/set search_path = ''/.test(sql));
});

Deno.test("prioridade efetiva: colunas da view cobrem PUBLIC_LICITACAO_COLUMNS", async () => {
  const view = corpoDaView(await sqlSemComentarios(MIGRATION));
  const ts = await Deno.readTextFile(
    "./supabase/functions/api-dashboard-oportunidades/index.ts",
  );
  const bloco =
    ts.match(/PUBLIC_LICITACAO_COLUMNS = \[([\s\S]*?)\]\.join/)?.[1] ?? "";
  const cols = [...bloco.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  assert(cols.length > 20);
  for (const c of cols) {
    if (c === "prioridade") continue; // recalculada
    assert(
      new RegExp(`\\bl\\.${c},`).test(view),
      `coluna ${c} ausente na view`,
    );
  }
  assertEquals(
    /\bl\.(raw|notas|esclarecimentos|anexo_raiz_id|edital_id)\s*,/.test(
      view.split("from public.licitacoes_externas l")[0],
    ),
    false,
    "colunas internas fora",
  );
});

Deno.test("prioridade efetiva: migration sem DML, numa transação, com lock_timeout", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assertEquals(
    /\b(insert into|update public\.|delete from|truncate)\b/i.test(sql),
    false,
  );
  assert(/^\s*begin;/m.test(sql) && /^\s*commit;/m.test(sql));
  assert(sql.includes("set local lock_timeout"));
});

Deno.test("check SQL: só lê e cobre grants, security_invoker e a regra", async () => {
  const raw = await Deno.readTextFile(CHECK);
  const sql = raw.replace(/--[^\n]*/g, "");
  assert(sql.includes(`'${VIEW}'`));
  assert(sql.includes("security_invoker=true"));
  assert(sql.includes("('anon'), ('public'), ('authenticated')"));
  assert(sql.includes("has_function_privilege"));
  assert(sql.includes("nunca promove a leads"));
  assertEquals(
    /\b(insert|update|delete|alter|grant|revoke|create|drop)\b\s/i.test(sql),
    false,
    "check só lê",
  );
});
