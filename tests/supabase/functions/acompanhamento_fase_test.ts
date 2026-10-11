import { assertEquals } from "jsr:@std/assert@1";
import {
  ACOMPANHAMENTO_LICITACAO_COLUMNS,
  ataDoPncp,
  ataVigente,
  enriquecerAcompanhamento,
  mapItemAcompanhamento,
  situacaoExibidaItem,
} from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import type {
  AtaAcompanhamento,
  ItemAcompanhamento,
} from "../../../supabase/functions/api-dashboard-oportunidades/types.ts";

// Caso 129 (Lagoa Nova/RN): fixture única com o coletor (dados públicos do PNCP).
const C129 = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../services/coletor-externo/tests/fixtures/pncp_caso_129.json", import.meta.url),
  ),
);
const ATA_129: AtaAcompanhamento = {
  numero: C129.atas.data[0].numeroAtaRegistroPreco,
  ano: C129.atas.data[0].anoAta,
  vigenciaInicio: null,
  vigenciaFim: C129.atas.data[0].dataVigenciaFim,
  dataAssinatura: C129.atas.data[0].dataAssinatura,
  cancelado: C129.atas.data[0].cancelado,
};

function item(situacao: string | null, temResultado = false): ItemAcompanhamento {
  return {
    ...mapItemAcompanhamento({ numeroItem: 1, descricao: "x", situacaoCompraItemNome: situacao, temResultado }),
  };
}

Deno.test("acompanhamento lê a coluna fase", () => {
  assertEquals(ACOMPANHAMENTO_LICITACAO_COLUMNS.includes("fase"), true);
});

Deno.test("ataVigente compara vigenciaFim com o dia de Brasília; cancelada é false; sem fim é null", () => {
  assertEquals(ataVigente(ATA_129, "2025-05-09"), true);
  assertEquals(ataVigente(ATA_129, "2025-05-10"), false);
  assertEquals(ataVigente({ ...ATA_129, cancelado: true }, "2025-01-01"), false);
  assertEquals(ataVigente({ ...ATA_129, vigenciaFim: null }, "2025-01-01"), null);
  assertEquals(ataVigente({ ...ATA_129, vigenciaInicio: "2025-02-01" }, "2025-01-01"), false);
});

Deno.test("situacaoExibidaItem: específica do PNCP é mantida; Em andamento deriva pela ata, resultado e fase", () => {
  const sem = { fase: null, atas: [] as AtaAcompanhamento[] };
  assertEquals(situacaoExibidaItem(item("Homologado"), { ...sem, atas: [ATA_129] }), "Homologado");
  assertEquals(situacaoExibidaItem(item("Deserto"), { fase: "Recebendo propostas", atas: [] }), "Deserto");
  assertEquals(situacaoExibidaItem(item("Em andamento"), { ...sem, atas: [ATA_129] }), "Registro de Preço");
  assertEquals(
    situacaoExibidaItem(item("Em andamento"), { ...sem, atas: [{ ...ATA_129, cancelado: true }] }),
    "Em andamento",
  );
  assertEquals(situacaoExibidaItem(item("Em andamento", true), sem), "Homologado");
  assertEquals(situacaoExibidaItem(item("Em andamento"), { fase: "Homologada (documento)", atas: [] }), "Homologado");
  assertEquals(situacaoExibidaItem(item("Em andamento"), { fase: "Suspensa (documento)", atas: [] }), "Suspensa");
  assertEquals(
    situacaoExibidaItem(item("Em andamento"), { fase: "Recebendo propostas", atas: [] }),
    "Recebendo Propostas",
  );
  assertEquals(situacaoExibidaItem(item("Em andamento"), { fase: "Prazo inválido", atas: [] }), "Em andamento");
  assertEquals(situacaoExibidaItem(item(null), { fase: "Recebendo propostas", atas: [] }), null);
});

Deno.test("enriquecerAcompanhamento acrescenta fase, vigente e situacaoExibida sem remover campos", () => {
  const payload = {
    itens: { dados: [item("Em andamento")], total: 1, erro: null },
    atas: { dados: [ATA_129], total: 1, erro: null },
    outro: "mantido",
  };
  const r = enriquecerAcompanhamento(payload, "Registro de Preço", new Date("2025-05-09T12:00:00Z"));
  assertEquals(r.fase, "Registro de Preço");
  assertEquals(r.outro, "mantido");
  assertEquals(r.atas.dados?.[0].vigente, true);
  assertEquals(r.atas.dados?.[0].numero, ATA_129.numero);
  assertEquals(r.itens.dados?.[0].situacaoExibida, "Registro de Preço");
  assertEquals(r.itens.dados?.[0].situacaoCompraItemNome, "Em andamento");
  assertEquals(payload.atas.dados[0].vigente, undefined); // entrada não muda (cache)
  // 2025-05-10 03:00Z ainda é 09/05 em Brasília
  assertEquals(enriquecerAcompanhamento(payload, null, new Date("2025-05-10T02:00:00Z")).atas.dados?.[0].vigente, true);
  const semAtas = enriquecerAcompanhamento({ ...payload, atas: { dados: null, total: 0, erro: "x" } }, null, new Date());
  assertEquals(semAtas.atas.dados, null);
});

Deno.test("ataDoPncp: dataCancelamento preenchida cancela a ata mesmo com cancelado=false", () => {
  const base = {
    numeroAtaRegistroPreco: "00129/2025",
    anoAta: 2025,
    dataVigenciaInicio: "2025-01-01",
    dataVigenciaFim: "2099-12-31",
  };
  const cancelada = ataDoPncp({ ...base, cancelado: false, dataCancelamento: "2025-06-01T10:00:00" });
  assertEquals([cancelada.cancelado, cancelada.dataCancelamento], [true, "2025-06-01T10:00:00"]);
  assertEquals(ataVigente(cancelada, "2025-07-01"), false);
  assertEquals(situacaoExibidaItem({} as never, { fase: null, atas: [cancelada] }) === "Registro de Preço", false);
  const ativa = ataDoPncp({ ...base, cancelado: false, dataCancelamento: "  " });
  assertEquals([ativa.cancelado, ativa.dataCancelamento], [false, null]);
  assertEquals(ataVigente(ativa, "2025-07-01"), true);
  assertEquals(ataDoPncp({ ...base, cancelado: true }).cancelado, true);
});
