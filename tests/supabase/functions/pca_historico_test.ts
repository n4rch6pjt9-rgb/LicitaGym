import { assertEquals } from "jsr:@std/assert@1";
import { linhaHistorico, montarHistorico } from "../../../supabase/functions/api-pncp-pca/historico.ts";

const linha = {
  orgao_cnpj: "10729992000146",
  orgao_nome: "IFSul",
  uf: "RS",
  ano_exercicio: 2024,
  classes_presentes: ["7830"],
  planos: 1,
  itens: 2,
  itens_sem_valor: 0,
  valor_planejado: 100,
  unidades: ["158126"],
  compras_escopo_observadas: 1,
  valor_escopo_observado: 40,
  execucoes_confirmadas: 0,
  lag_medio_dias: null,
};

Deno.test("histórico separa planejado de execução e deixa 2026 aberto", () => {
  const montado = montarHistorico([
    linha,
    { ...linha, ano_exercicio: 2026, valor_planejado: null, compras_escopo_observadas: 3, valor_escopo_observado: null, execucoes_confirmadas: 2, lag_medio_dias: 10 },
  ], 2026);

  assertEquals(montado.orgaos.length, 1);
  const orgao = montado.orgaos[0];
  assertEquals(orgao.valor_planejado, 100);
  assertEquals(orgao.compras_escopo_observadas, 4);
  assertEquals(orgao.execucoes_confirmadas, 0);
  assertEquals(orgao.lag_medio_dias, null);
  assertEquals(orgao.anos[1].exercicio_aberto, true);
  assertEquals(orgao.anos[1].execucoes_confirmadas, 2);
  assertEquals(montado.por_uf[0].uf, "RS");
  assertEquals(montado.por_uf[0].valor_planejado, 100);
});

Deno.test("linhaHistorico lê classes_presentes e os campos de escopo da função", () => {
  const l = linhaHistorico({
    orgao_cnpj: "10729992000146",
    ano_exercicio: "2025",
    classes_presentes: ["7220", "7830", null],
    compras_escopo_observadas: "2",
    valor_escopo_observado: "10.5",
  });
  assertEquals(l?.classes_presentes, ["7220", "7830"]);
  assertEquals([l?.compras_escopo_observadas, l?.valor_escopo_observado], [2, 10.5]);
});
