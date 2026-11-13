import { assertEquals } from "jsr:@std/assert@1";
import { pickUniquePlanoLinks } from "../../../supabase/functions/link-pca-edital/_shared_prod/pncp/link-pca-edital.ts";

Deno.test("linker não mistura compra do coletor com edital de mesmo texto de id", () => {
  const decisions = pickUniquePlanoLinks([
    {
      editalId: "42",
      planoId: "plano-a",
      metodo: "codigo_item",
      origem: "licitacao_externa",
      detalhe: "codigo=1",
    },
    {
      editalId: "42",
      planoId: "plano-b",
      metodo: "codigo_item",
      origem: "contratacao_edital",
      detalhe: "codigo=1",
    },
  ]);
  assertEquals(decisions.length, 2);
  assertEquals(decisions.find((d) => d.origem === "licitacao_externa")?.planoId, "plano-a");
  assertEquals(decisions.find((d) => d.origem === "contratacao_edital")?.planoId, "plano-b");
});

Deno.test("linker descarta compra com dois planos", () => {
  const decisions = pickUniquePlanoLinks([
    {
      editalId: "7",
      planoId: "plano-a",
      metodo: "pdm_janela",
      origem: "licitacao_externa",
      detalhe: "pdm=1",
    },
    {
      editalId: "7",
      planoId: "plano-b",
      metodo: "pdm_janela",
      origem: "licitacao_externa",
      detalhe: "pdm=2",
    },
  ]);
  assertEquals(decisions.length, 0);
});
