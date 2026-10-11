// Regressão #321: o upsert de public.entidades não pode enviar coluna gerada.
// entidades.cnpj_normalizado é GENERATED ALWAYS (202609180002_entidades.sql); enviá-la faz o PostgREST
// responder 400 em todo PATCH/INSERT, e o sync de órgãos terminava com erro em todos os CNPJs.
import { assertEquals } from "jsr:@std/assert@1";
import { COLUNAS_GERADAS_ENTIDADES, linhaEntidade } from "../../../supabase/functions/sync-pncp-orgaos/entidade.ts";

Deno.test("#321: linha de entidades não contém coluna gerada", () => {
  const linha = linhaEntidade("00394429000100");
  for (const coluna of COLUNAS_GERADAS_ENTIDADES) {
    assertEquals(coluna in linha, false, `coluna gerada ${coluna} enviada no upsert`);
  }
});

Deno.test("#321: linha de entidades mantém os campos que o sync grava", () => {
  assertEquals(linhaEntidade("00394429000100"), {
    codigo_pncp: "00394429000100",
    cnpj: "00394429000100",
    tipo: "orgao",
  });
});
