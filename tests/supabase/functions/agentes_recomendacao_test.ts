import { assertEquals } from "jsr:@std/assert@1";
import { agenteConcorrencia } from "../../../supabase/functions/_shared/agentes/concorrencia.ts";
import {
  calcularScoreAderencia,
  calcularScoreConcorrencia,
  calcularScoreRisco,
  calcularScoreViabilidade,
} from "../../../supabase/functions/_shared/agentes/scores.ts";
import { recomendarV4 } from "../../../supabase/functions/_shared/agentes/recomendacao.ts";
import {
  REGRA_VERSAO,
  REGRA_VERSAO_RECOMENDACAO,
  type ResultadoAgente,
} from "../../../supabase/functions/_shared/agentes/tipos.ts";
import { recomendar } from "../../../supabase/functions/_shared/recomendacao.ts";

Deno.test("agenteConcorrencia: sem amostras válidas devolve sem_referencia", () => {
  const res = agenteConcorrencia({
    amostras: [{ ni_fornecedor: "111", nome_fornecedor: "F1", marca: "Konnen", preco_centavos: 0 }],
    piso_tenant_centavos: 777_777,
  });
  assertEquals(res.situacao, "sem_referencia");
  assertEquals(res.achados.map((a) => a.codigo), ["concorrencia.sem_amostras"]);
  assertEquals(JSON.stringify(res).includes("777777"), false);
});

Deno.test("agenteConcorrencia: detecta concentração alta, marcas premium e não vaza piso do tenant", () => {
  const res = agenteConcorrencia({
    amostras: [
      { ni_fornecedor: "11111111000101", nome_fornecedor: "Forn A", marca: "Life Fitness", preco_centavos: 2_000_000 },
      { ni_fornecedor: "22222222000102", nome_fornecedor: "Forn B", marca: "Technogym", preco_centavos: 2_400_000 },
    ],
    piso_tenant_centavos: 1_543_210,
  });
  assertEquals(res.situacao, "ok");
  assertEquals(res.achados.map((a) => a.codigo), [
    "concorrencia.concentracao_alta",
    "concorrencia.somente_premium",
    "concorrencia.resumo_mercado",
  ]);
  const resumo = res.achados.find((a) => a.codigo === "concorrencia.resumo_mercado")!;
  assertEquals(resumo.dados.mediana_mercado_centavos, 2_200_000);
  assertEquals(resumo.dados.marcas, ["Life Fitness", "Technogym"]);
  assertEquals(JSON.stringify(res).includes("1543210"), false);
});

Deno.test("scores: calcula aderência, risco, viabilidade e concorrência de forma determinística", () => {
  const editalOk: ResultadoAgente = {
    agente: "edital",
    situacao: "ok",
    achados: [],
    regra_versao: REGRA_VERSAO,
  };
  const juridicoOk: ResultadoAgente = {
    agente: "juridico",
    situacao: "ok",
    achados: [],
    regra_versao: REGRA_VERSAO,
  };
  const aderencia = calcularScoreAderencia(editalOk, juridicoOk);
  assertEquals(aderencia.score_total, 0.97);

  const risco = calcularScoreRisco(juridicoOk, editalOk);
  assertEquals(risco.score_total, 0.09);

  const precoOk: ResultadoAgente = {
    agente: "preco",
    situacao: "ok",
    achados: [{
      codigo: "preco.referencia_praticada",
      natureza: "fato",
      metodo: "regra",
      severidade: "info",
      titulo: "Referência",
      detalhe: "12 amostras",
      dados: { n: 12 },
      fontes: [{ tipo: "calculo", regra: "mediana", versao: REGRA_VERSAO }],
    }],
    regra_versao: REGRA_VERSAO,
  };
  const viabilidade = calcularScoreViabilidade(precoOk);
  assertEquals(viabilidade.score_total, 1);

  const conc = agenteConcorrencia({
    amostras: Array.from({ length: 10 }, (_, i) => ({
      ni_fornecedor: `forn-${i % 6}`,
      nome_fornecedor: `Fornecedor ${i % 6}`,
      marca: i % 2 === 0 ? "Konnen" : "Movement",
      preco_centavos: 1_000_000 + i * 10_000,
    })),
    piso_tenant_centavos: 800_000,
  });
  const scoreConc = calcularScoreConcorrencia(conc);
  assertEquals(scoreConc.score_total, 0.825);
  assertEquals(scoreConc.detalhes.num_concorrentes, 6);
  assertEquals(scoreConc.detalhes.marcas, ["Konnen", "Movement"]);
  assertEquals(scoreConc.detalhes.razao_preco, null);
  assertEquals(scoreConc.detalhes.tem_so_premium, false);
});

Deno.test("recomendarV4: persiste decisão em recomendacao_decisoes e aplica thresholds sem vazar piso", async () => {
  const inseridos: Array<Record<string, unknown>> = [];
  const mockSupabase = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        assertEquals(table, "recomendacao_decisoes");
        inseridos.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: 42 }, error: null }),
          }),
        };
      },
    }),
  };

  const edital: ResultadoAgente = {
    agente: "edital",
    situacao: "ok",
    achados: [],
    regra_versao: REGRA_VERSAO,
  };
  const preco: ResultadoAgente = {
    agente: "preco",
    situacao: "ok",
    achados: [{
      codigo: "preco.referencia_praticada",
      natureza: "fato",
      metodo: "regra",
      severidade: "info",
      titulo: "Referência",
      detalhe: "10 amostras",
      dados: { n: 10 },
      fontes: [{ tipo: "calculo", regra: "mediana", versao: REGRA_VERSAO }],
    }],
    regra_versao: REGRA_VERSAO,
  };

  const { recomendacao, decisao_id } = await recomendarV4(
    // deno-lint-ignore no-explicit-any
    mockSupabase as any,
    {
      tenant_id: 1,
      licitacao_id: 101,
      numero_item: 1,
      produto_id: 50,
      solicitado_por: "user-uuid-1",
      edital,
      preco,
      dispositivos: [],
      amostras_concorrencia: Array.from({ length: 6 }, (_, i) => ({
        ni_fornecedor: `cnpj-${i}`,
        nome_fornecedor: `Empresa ${i}`,
        marca: "Konnen",
        preco_centavos: 1_500_000,
      })),
      piso_tenant_centavos: 987_654,
    },
  );

  assertEquals(decisao_id, 42);
  assertEquals(recomendacao.decisao, "disputar");
  assertEquals(recomendacao.regra_versao, REGRA_VERSAO_RECOMENDACAO);
  assertEquals(inseridos.length, 1);
  assertEquals(inseridos[0].decisao, "disputar");
  assertEquals(JSON.stringify(recomendacao).includes("987654"), false);
});

Deno.test("recomendarV4: marca nao_disputar quando concorrência e aderência ficam abaixo do mínimo", async () => {
  const mockSupabase = {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 99 }, error: null }),
        }),
      }),
    }),
  };

  const editalComMarca: ResultadoAgente = {
    agente: "edital",
    situacao: "ok",
    achados: [{
      codigo: "exigencia.marca_modelo",
      natureza: "fato",
      metodo: "regra",
      severidade: "critico",
      titulo: "Marca exigida",
      detalhe: "Exige marca específica",
      dados: {},
      fontes: [{ tipo: "chunk", chunk_id: 1, documento_id: 1, pagina: 1, trecho: "marca X" }],
    }],
    regra_versao: REGRA_VERSAO,
  };
  const precoVazio: ResultadoAgente = {
    agente: "preco",
    situacao: "sem_referencia",
    achados: [],
    regra_versao: REGRA_VERSAO,
  };

  const { recomendacao } = await recomendarV4(
    // deno-lint-ignore no-explicit-any
    mockSupabase as any,
    {
      tenant_id: 1,
      licitacao_id: 101,
      numero_item: 1,
      produto_id: null,
      solicitado_por: "user-uuid-1",
      edital: editalComMarca,
      preco: precoVazio,
      dispositivos: [{ norma: "LEI_14133_2021", artigo: 41, texto: "Vedação de marca.", conferido_oficial: true }],
      amostras_concorrencia: [
        { ni_fornecedor: "111", nome_fornecedor: "Único", marca: "Life Fitness", preco_centavos: 3_000_000 },
      ],
      piso_tenant_centavos: 900_000,
    },
  );

  assertEquals(recomendacao.decisao, "nao_disputar");
  assertEquals(recomendacao.motivos.includes("aderencia_insuficiente"), true);
  assertEquals(recomendacao.motivos.includes("concorrencia_desfavoravel"), true);
});

Deno.test("recomendar (v1): valida input, calcula faixa, detecta sobrepreço e faixa inviável", async () => {
  const invalido = await recomendar({
    codigo_item: 0,
    unidade: "UN",
    custo_proprio: 1000,
    margem_min: 0.15,
    estimado_edital: 1500,
  });
  assertEquals(invalido.status, "EMPTY_VALID");
  assertEquals(invalido.motivos, ["input_invalido"]);

  const criarCliente = (row: Record<string, unknown> | null) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: row, error: null }),
          }),
        }),
      }),
    }),
  });

  // 1. Disputar normal
  const ok = await recomendar(
    {
      codigo_item: 485224,
      unidade: "UN",
      custo_proprio: 15000,
      margem_min: 0.10, // piso proprio = 16500
      estimado_edital: 25000, // 50% = 12500 -> piso = 16500
    },
    // deno-lint-ignore no-explicit-any
    criarCliente({
      codigo_item: 485224,
      unidade: "UN",
      preco_mediana: 20000,
      preco_p25: 18000,
      preco_p75: 22000,
      n_cotacoes: 8,
      outlier_tipo: null,
    }) as any,
  );
  assertEquals(ok.status, "SUCCESS_WITH_DATA");
  assertEquals(ok.decisao, "disputar");
  assertEquals(ok.parametros, {
    teto_absoluto: 22000,
    alvo: 20000,
    piso_inexequibilidade: 16500,
  });
  assertEquals(ok.recomendacao_id, "sha256:485224:UN:20000");

  // 2. Sobrepreço (estimado >= 3x mediana) -> aguardar_aprovacao
  const sobrepreco = await recomendar(
    {
      codigo_item: 485224,
      unidade: "UN",
      custo_proprio: 15000,
      margem_min: 0.10,
      estimado_edital: 65000, // 3.25x mediana (20000), 50% = 32500 > teto (22000)? Vamos usar custo/estimado que caiba no p75
    },
    // deno-lint-ignore no-explicit-any
    criarCliente({
      codigo_item: 485224,
      unidade: "UN",
      preco_mediana: 20000,
      preco_p25: 18000,
      preco_p75: 40000,
      n_cotacoes: 5,
      outlier_tipo: null,
    }) as any,
  );
  assertEquals(sobrepreco.status, "SUCCESS_WITH_DATA");
  assertEquals(sobrepreco.decisao, "aguardar_aprovacao");
  assertEquals(sobrepreco.alertas.length, 1);

  // 3. Faixa inviável (piso > teto)
  const inviavel = await recomendar(
    {
      codigo_item: 485224,
      unidade: "UN",
      custo_proprio: 25000,
      margem_min: 0.20, // 30000 > p75 (22000)
      estimado_edital: 25000,
    },
    // deno-lint-ignore no-explicit-any
    criarCliente({
      codigo_item: 485224,
      unidade: "UN",
      preco_mediana: 20000,
      preco_p25: 18000,
      preco_p75: 22000,
      n_cotacoes: 5,
      outlier_tipo: null,
    }) as any,
  );
  assertEquals(inviavel.status, "EMPTY_VALID");
  assertEquals(inviavel.decisao, "nao_disputar");
  assertEquals(inviavel.motivos, ["faixa_inviavel"]);
});
