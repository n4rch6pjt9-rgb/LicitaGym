// Regressão #321: o upsert de public.entidades não pode enviar coluna gerada.
// entidades.cnpj_normalizado é GENERATED ALWAYS (202609180002_entidades.sql); enviá-la faz o PostgREST
// responder 400 em todo PATCH/INSERT, e o sync de órgãos terminava com erro em todos os CNPJs.
// As colunas geradas são lidas das migrations, para que uma coluna gerada nova também seja coberta.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { linhaEntidade } from "../../../supabase/functions/sync-pncp-orgaos/entidade.ts";

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url);

async function colunasGeradasDeEntidades(): Promise<Set<string>> {
  const colunas = new Set<string>();
  for await (const arq of Deno.readDir(MIGRATIONS)) {
    if (!arq.isFile || !arq.name.endsWith(".sql") || !/^\d/.test(arq.name)) continue;
    const sql = await Deno.readTextFile(new URL(arq.name, MIGRATIONS));
    // create table public.entidades ( ... ) e alter table public.entidades add column ...
    for (const m of sql.matchAll(/(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?public\.entidades\b([\s\S]*?);/gi)) {
      for (const c of m[1].matchAll(/(?:^|[,(\s])(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?(\w+)\s+[\w ]+?\s+generated\s+always/gi)) {
        colunas.add(c[1].toLowerCase());
      }
    }
  }
  return colunas;
}

Deno.test("#321: as migrations declaram cnpj_normalizado como coluna gerada de entidades", async () => {
  assert((await colunasGeradasDeEntidades()).has("cnpj_normalizado"));
});

Deno.test("#321: linha de entidades não contém coluna gerada", async () => {
  const geradas = await colunasGeradasDeEntidades();
  const enviadas = Object.keys(linhaEntidade("00394429000100"));
  assertEquals(enviadas.filter((c) => geradas.has(c)), [], "coluna gerada enviada no upsert");
});

Deno.test("#321: linha de entidades mantém os campos que o sync grava", () => {
  assertEquals(linhaEntidade("00394429000100"), {
    codigo_pncp: "00394429000100",
    cnpj: "00394429000100",
    tipo: "orgao",
  });
});
