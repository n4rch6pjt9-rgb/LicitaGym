// Spec 0023 (#363): a api-dashboard-oportunidades expõe a proveniência da linha (payload_hash, ingestao_origem,
// ingestao_em). A função devolve as linhas da view como vêm, então o contrato é a projeção: as três colunas
// precisam estar em PUBLIC_LICITACAO_COLUMNS (list e get) e, por consequência, em OPORTUNIDADES_COLUMNS.
import { assertEquals } from "jsr:@std/assert@1";
import {
  OPORTUNIDADES_COLUMNS,
  PUBLIC_LICITACAO_COLUMNS,
} from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";

const PROVENIENCIA = ["payload_hash", "ingestao_origem", "ingestao_em"];

Deno.test("CA-5: list/get projetam payload_hash, ingestao_origem e ingestao_em", () => {
  const publicas = PUBLIC_LICITACAO_COLUMNS.split(",");
  for (const c of PROVENIENCIA) {
    assertEquals(publicas.includes(c), true, `${c} ausente em PUBLIC_LICITACAO_COLUMNS`);
    assertEquals(OPORTUNIDADES_COLUMNS.split(",").includes(c), true, `${c} ausente em OPORTUNIDADES_COLUMNS`);
  }
});

Deno.test("CA-5: os campos existentes continuam na projeção (contrato aditivo)", () => {
  const publicas = PUBLIC_LICITACAO_COLUMNS.split(",");
  for (const c of ["id", "fonte", "codigo_externo", "last_synced_at", "created_at", "objeto_registro_preco"]) {
    assertEquals(publicas.includes(c), true, `${c} saiu de PUBLIC_LICITACAO_COLUMNS`);
  }
});
