// Spec 0023 (#363): a api-dashboard-oportunidades expõe a proveniência da linha (payload_hash, ingestao_origem,
// ingestao_em). A função devolve as linhas da view como vêm, então o contrato é a projeção: as três colunas
// precisam estar em PUBLIC_LICITACAO_COLUMNS (list e get) e, por consequência, em OPORTUNIDADES_COLUMNS.
import { assertEquals } from "jsr:@std/assert@1";
import {
  colunaOpcionalAusente,
  comColunasOpcionais,
  OPORTUNIDADES_COLUMNS,
  OPORTUNIDADES_COLUMNS_SEM_OPCIONAIS,
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

Deno.test("CA-5: função publicada antes da migration: 42703 em ingestao_origem repete a leitura sem as opcionais", async () => {
  type Leitura = { data: unknown; error: { code: string; message: string } | null };
  const pedidos: string[] = [];
  const r = await comColunasOpcionais((colunas): Promise<Leitura> => {
    pedidos.push(colunas);
    if (pedidos.length === 1) {
      return Promise.resolve({ data: null, error: { code: "42703", message: "column l.ingestao_origem does not exist" } });
    }
    return Promise.resolve({ data: [{ id: 1 }], error: null });
  });
  assertEquals(r.error, null);
  assertEquals(pedidos, [OPORTUNIDADES_COLUMNS, OPORTUNIDADES_COLUMNS_SEM_OPCIONAIS]);
  for (const c of [...PROVENIENCIA, "objeto_categoria", "objeto_registro_preco"]) {
    assertEquals(OPORTUNIDADES_COLUMNS_SEM_OPCIONAIS.split(",").includes(c), false, `${c} deveria sair do fallback`);
  }
  assertEquals(OPORTUNIDADES_COLUMNS_SEM_OPCIONAIS.split(",").includes("last_synced_at"), true);
  // outro erro não dispara o fallback
  assertEquals(colunaOpcionalAusente({ code: "42703", message: "column l.uf does not exist" }), false);
  assertEquals(colunaOpcionalAusente({ code: "57014", message: "timeout" }), false);
});

Deno.test("CA-5: os campos existentes continuam na projeção (contrato aditivo)", () => {
  const publicas = PUBLIC_LICITACAO_COLUMNS.split(",");
  for (const c of ["id", "fonte", "codigo_externo", "last_synced_at", "created_at", "objeto_registro_preco"]) {
    assertEquals(publicas.includes(c), true, `${c} saiu de PUBLIC_LICITACAO_COLUMNS`);
  }
});
