import { assertEquals } from "jsr:@std/assert@1";
import { classesDaQuery, resolverClasses } from "../../../../supabase/functions/_shared/catalogo-classes.ts";

const CATALOGO = ["7220", "7810", "7830", "9320"];

Deno.test("sem classes pedidas, usa as do catálogo", () => {
  assertEquals(resolverClasses(undefined, CATALOGO), { ok: true, classes: CATALOGO });
  assertEquals(resolverClasses([], CATALOGO), { ok: true, classes: CATALOGO });
});

Deno.test("classes pedidas do catálogo passam, ordenadas e sem repetição", () => {
  assertEquals(resolverClasses(["7830", "7220", "7830"], CATALOGO), { ok: true, classes: ["7220", "7830"] });
});

Deno.test("classe fora do catálogo é 400 e diz qual", () => {
  const r = resolverClasses(["7830", "6515"], CATALOGO);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.status, 400);
    assertEquals(r.erro.includes("6515"), true);
  }
});

Deno.test("código que não é CATMAT de 4 dígitos é 400", () => {
  const r = resolverClasses(["78"], CATALOGO);
  assertEquals(r.ok ? 0 : r.status, 400);
  const s = resolverClasses("7830", CATALOGO);
  assertEquals(s.ok ? 0 : s.status, 400);
});

Deno.test("catálogo vazio é erro explícito, sem padrão fixo", () => {
  const r = resolverClasses(undefined, []);
  assertEquals(r.ok ? 0 : r.status, 409);
});

Deno.test("classesDaQuery junta classes= e classe=, separa vírgula e ignora vazio", () => {
  assertEquals(classesDaQuery(new URL("https://x.test/?classes=7830,7220&classe=9320")), ["7830", "7220", "9320"]);
  assertEquals(classesDaQuery(new URL("https://x.test/?classes=")), null);
  assertEquals(classesDaQuery(new URL("https://x.test/")), null);
});
