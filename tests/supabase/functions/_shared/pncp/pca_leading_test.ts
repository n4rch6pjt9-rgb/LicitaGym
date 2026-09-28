import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  agregarLeadingPca,
  type PcaItemLeading,
} from "../../../../../supabase/functions/_shared/pcaLeading.ts";

const HOJE = "2026-09-26";

function item(partial: Partial<PcaItemLeading> & Pick<PcaItemLeading, "planoId">): PcaItemLeading {
  return {
    orgaoCnpj: "00.000.000/0001-91",
    valorTotalEstimado: 100,
    dataPrevista: "2026-11-25",
    prioridade: null,
    pdmCodigoOrigem: null,
    pdmInferido: false,
    pdmConfirmado: false,
    lastSyncedAt: "2026-09-19T15:00:00.000Z",
    ...partial,
  };
}

Deno.test("valor nulo não vira zero e a soma ignora ausência", () => {
  const leitura = agregarLeadingPca(
    [
      item({ planoId: "a", valorTotalEstimado: 10 }),
      item({ planoId: "b", valorTotalEstimado: null }),
    ],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.valor_estimado_demanda_planejada, 10);
  assertEquals(leitura.itens_sem_valor, 1);
  assertEquals(leitura.itens, 2);
});

Deno.test("sem nenhum valor a soma fica ausente, não zero", () => {
  const leitura = agregarLeadingPca(
    [item({ planoId: "a", valorTotalEstimado: null })],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.valor_estimado_demanda_planejada, null);
  assertEquals(leitura.itens_sem_valor, 1);
});

Deno.test("prioridade vazia é não informada e texto da fonte não vira faixa", () => {
  const leitura = agregarLeadingPca(
    [
      item({ planoId: "a", prioridade: null }),
      item({ planoId: "b", prioridade: "  " }),
      item({ planoId: "c", prioridade: "Alta" }),
    ],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.prioridade_nao_informada, 2);
  assertEquals(leitura.prioridade_informada, 1);
});

Deno.test("PDM de origem, inferido e confirmado se sobrepõem e confirmado não é origem", () => {
  const leitura = agregarLeadingPca(
    [
      item({
        planoId: "a",
        pdmCodigoOrigem: "18481",
        pdmInferido: true,
        pdmConfirmado: true,
      }),
      item({
        planoId: "b",
        pdmCodigoOrigem: null,
        pdmInferido: true,
        pdmConfirmado: false,
      }),
    ],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.pdm_informado_origem, 1);
  assertEquals(leitura.pdm_inferido, 2);
  assertEquals(leitura.pdm_confirmado, 1);
});

Deno.test("janela experimental inclui 60 e 120; 0 a 59 fica fora; data ausente não entra", () => {
  const leitura = agregarLeadingPca(
    [
      item({ planoId: "a", dataPrevista: "2026-11-25" }),
      item({ planoId: "b", dataPrevista: "2027-01-24" }),
      item({ planoId: "c", dataPrevista: "2026-09-26" }),
      item({ planoId: "d", dataPrevista: "2026-11-24" }),
      item({ planoId: "e", dataPrevista: "2027-01-25" }),
      item({ planoId: "f", dataPrevista: null }),
    ],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.janela_experimental_60_120, 2);
  assertEquals(leitura.fora_janela_0_59, 2);
  assertEquals(leitura.fora_das_faixas, 1);
  assertEquals(leitura.antecedencia_nao_calculada, 1);
});

Deno.test("trocar unidade muda a contagem e não a soma dos itens", () => {
  const itens = [
    item({ planoId: "p1", orgaoCnpj: "11.111.111/0001-11", valorTotalEstimado: 40 }),
    item({ planoId: "p1", orgaoCnpj: "11111111000111", valorTotalEstimado: 60 }),
    item({ planoId: "p2", orgaoCnpj: "22.222.222/0001-22", valorTotalEstimado: 15 }),
  ];
  const porItem = agregarLeadingPca(itens, { hoje: HOJE, unidade: "item" });
  const porPlano = agregarLeadingPca(itens, { hoje: HOJE, unidade: "plano" });
  const porOrgao = agregarLeadingPca(itens, { hoje: HOJE, unidade: "orgao" });
  assertEquals(porItem.contagem_unidade, 3);
  assertEquals(porPlano.contagem_unidade, 2);
  assertEquals(porOrgao.contagem_unidade, 2);
  assertEquals(porItem.valor_estimado_demanda_planejada, 115);
  assertEquals(porPlano.valor_estimado_demanda_planejada, 115);
  assertEquals(porOrgao.valor_estimado_demanda_planejada, 115);
});

Deno.test("item sem CNPJ não vira órgão e não zera os demais", () => {
  const leitura = agregarLeadingPca(
    [
      item({ planoId: "p1", orgaoCnpj: null }),
      item({ planoId: "p2", orgaoCnpj: "33.333.333/0001-33" }),
    ],
    { hoje: HOJE, unidade: "orgao" },
  );
  assertEquals(leitura.orgaos, 1);
  assertEquals(leitura.itens_sem_cnpj_orgao, 1);
  assertEquals(leitura.contagem_unidade, 1);
  assertEquals(leitura.itens, 2);
});

Deno.test("data da sync é a mais recente e data de referência inválida falha", () => {
  const leitura = agregarLeadingPca(
    [
      item({ planoId: "a", lastSyncedAt: "2026-09-19T10:00:00.000Z" }),
      item({ planoId: "b", lastSyncedAt: "2026-09-18T10:00:00.000Z" }),
    ],
    { hoje: HOJE, unidade: "item" },
  );
  assertEquals(leitura.data_sync, "2026-09-19T10:00:00.000Z");
  assertEquals(leitura.data_referencia, HOJE);
  assertThrows(() => agregarLeadingPca([], { hoje: "ontem", unidade: "item" }));
});
