import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20260930180000_cron_sync_jobs.sql";
const CONFIG = "./supabase/config.toml";

async function sql(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

Deno.test("cron: toda função agendada existe, está no config.toml com verify_jwt=false e exige o Bearer do cron", async () => {
  const texto = await sql();
  const config = await Deno.readTextFile(CONFIG);
  const funcoes = new Set<string>();
  for (
    const m of texto.matchAll(
      /private\.cron_chamar_edge\('licitagym-[a-z0-9-]+', '([a-z0-9-]+)'/g,
    )
  ) funcoes.add(m[1]);
  assertEquals([...funcoes].sort(), [
    "link-catmat-pca",
    "sync-compras-catmat",
    "sync-pncp-catalogo",
    "sync-pncp-legislation",
    "sync-pncp-orgaos",
    "sync-pncp-pca",
  ]);
  for (const f of funcoes) {
    const codigo = await Deno.readTextFile(
      `./supabase/functions/${f}/index.ts`,
    );
    assert(codigo.includes("validateCronAuth"), `${f} valida o Bearer do cron`);
    const bloco =
      config.match(new RegExp(`\\[functions\\.${f}\\][^\\[]*`))?.[0] ?? "";
    assert(
      /verify_jwt\s*=\s*false/.test(bloco),
      `${f} está no config.toml com verify_jwt = false`,
    );
  }
});

Deno.test("cron: o segredo vem do Vault por nome e falta de segredo aborta antes da chamada HTTP", async () => {
  const texto = await sql();
  const corpo = texto.slice(
    texto.indexOf("create or replace function private.cron_chamar_edge"),
  );
  const leitura = corpo.indexOf("from vault.decrypted_secrets");
  const excecao = corpo.indexOf("raise exception 'Vault sem o segredo");
  const post = corpo.indexOf("net.http_post");
  assert(
    leitura > 0 && excecao > leitura && post > excecao,
    "lê o Vault, valida e só então chama net.http_post",
  );
  assert(
    corpo.includes("name = 'sync_cron_secret'"),
    "segredo lido pelo nome sync_cron_secret",
  );
  assertEquals(
    /Bearer [A-Za-z0-9._-]{8,}/.test(texto),
    false,
    "nenhum token literal na migration",
  );
  assertEquals(
    /(select|perform)\s+vault\.(create|update)_secret/i.test(texto),
    false,
    "a migration não cria nem altera segredo",
  );
});

Deno.test("cron: agendamento idempotente, nomes únicos e helper sem EXECUTE para roles da API", async () => {
  const texto = await sql();
  const nomes = [
    ...texto.matchAll(/\('(licitagym-[a-z0-9-]+)', '([0-9*/, -]+)',/g),
  ].map((m) => m[1]);
  assertEquals(nomes.length, 11);
  assertEquals(new Set(nomes).size, nomes.length, "nomes de job únicos");
  assert(
    texto.indexOf("perform cron.unschedule") > 0 &&
      texto.indexOf("perform cron.unschedule") <
        texto.indexOf("perform cron.schedule(j.nome"),
    "unschedule antes de schedule",
  );
  assert(
    texto.includes(
      "revoke all on function private.cron_chamar_edge(text, text, jsonb, integer) from public, anon, authenticated, service_role;",
    ),
  );
});
