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
import { LIMITE_AMOSTRAS } from "../../../supabase/functions/_shared/agentes/preco.ts";
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
  assertEquals(inseridos[0].score_final, 0.908);
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

Deno.test("recomendar (v1): valida input, filtra por unidade normalizada, clampa alvo e detecta sobrepreço/inviável", async () => {
  const invalido = await recomendar({
    codigo_item: 0,
    unidade: "UN",
    custo_proprio: 1000,
    margem_min: 0.15,
    estimado_edital: 1500,
  });
  assertEquals(invalido.status, "EMPTY_VALID");
  assertEquals(invalido.motivos, ["input_invalido"]);

  const unidadeAusente = await recomendar({
    codigo_item: 485224,
    unidade: "",
    custo_proprio: 1000,
    margem_min: 0,
    estimado_edital: 1500,
  });
  assertEquals(unidadeAusente.status, "EMPTY_VALID");
  assertEquals(unidadeAusente.motivos, ["input_invalido"]);

  const criarCliente = (rows: Array<{ preco_unitario: number; sigla_unidade_fornecimento: string | null }>) => ({
    from: (table: string) => {
      assertEquals(table, "precos_praticados_itens");
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        gt: () => chain,
        or: () => chain,
        ilike: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: rows, error: null }),
      };
      return chain;
    },
  });

  // 1. Disputar normal (normalizando "Unidade" -> "UN" e descartando "CX")
  const ok = await recomendar(
    {
      codigo_item: 485224,
      unidade: "Unidade",
      custo_proprio: 15000,
      margem_min: 0.10, // piso proprio = 16500
      estimado_edital: 25000, // 50% = 12500 -> piso = 16500
    },
    // deno-lint-ignore no-explicit-any
    criarCliente([
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 20000, sigla_unidade_fornecimento: "Unidade" },
      { preco_unitario: 22000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 22000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 99000, sigla_unidade_fornecimento: "CX" }, // ignorado por unidade distinta
    ]) as any,
  );
  assertEquals(ok.status, "SUCCESS_WITH_DATA");
  assertEquals(ok.decisao, "disputar");
  assertEquals(ok.parametros, {
    teto_absoluto: 22000,
    alvo: 20000,
    piso_inexequibilidade: 16500,
  });
  assertEquals(ok.recomendacao_id, "sha256:485224:UN:20000");

  // 2. Sobrepreço (estimado >= 3x mediana) -> aguardar_aprovacao e alvo clampado no piso (32500 > 20000)
  const sobrepreco = await recomendar(
    {
      codigo_item: 485224,
      unidade: "UN",
      custo_proprio: 15000,
      margem_min: 0.10,
      estimado_edital: 65000, // 3.25x mediana (20000), 50% = 32500
    },
    // deno-lint-ignore no-explicit-any
    criarCliente([
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 20000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 40000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 40000, sigla_unidade_fornecimento: "UN" },
    ]) as any,
  );
  assertEquals(sobrepreco.status, "SUCCESS_WITH_DATA");
  assertEquals(sobrepreco.decisao, "aguardar_aprovacao");
  assertEquals(sobrepreco.alertas.length, 1);
  assertEquals(sobrepreco.parametros, {
    teto_absoluto: 40000,
    alvo: 32500,
    piso_inexequibilidade: 32500,
  });

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
    criarCliente([
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 18000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 20000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 22000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 22000, sigla_unidade_fornecimento: "UN" },
    ]) as any,
  );
  assertEquals(inviavel.status, "EMPTY_VALID");
  assertEquals(inviavel.decisao, "nao_disputar");
  assertEquals(inviavel.motivos, ["faixa_inviavel"]);
});

Deno.test("recomendar (v1): o limite de amostras vale depois do filtro de unidade", async () => {
  const entrada = {
    codigo_item: 485224,
    custo_proprio: 1000,
    margem_min: 0,
    estimado_edital: 8000,
  };

  // Outra unidade preenche a janela; as homologações da unidade alvo ficam depois dela.
  const cliente = (
    linhas: Array<{ preco_unitario: number; sigla_unidade_fornecimento: string }>,
    aceita: (sigla: string) => boolean,
  ) => {
    let filtrou = false;
    return {
      client: {
        from: (table: string) => {
          assertEquals(table, "precos_praticados_itens");
          // deno-lint-ignore no-explicit-any
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            gte: () => chain,
            gt: () => chain,
            or: (expr: string) => {
              filtrou = expr.includes("sigla_unidade_fornecimento.ilike.UN,") &&
                expr.includes("sigla_unidade_fornecimento.ilike.UNIDADE");
              return chain;
            },
            ilike: (col: string, val: string) => {
              assertEquals(col, "sigla_unidade_fornecimento");
              filtrou = val === "CX";
              return chain;
            },
            order: () => chain,
            limit: (n: number) => {
              const base = filtrou ? linhas.filter((r) => aceita(r.sigla_unidade_fornecimento)) : linhas;
              return Promise.resolve({ data: base.slice(0, n), error: null });
            },
          };
          return chain;
        },
      },
      filtrou: () => filtrou,
    };
  };

  const outras = Array.from({ length: LIMITE_AMOSTRAS }, () => ({
    preco_unitario: 99000,
    sigla_unidade_fornecimento: "CX",
  }));
  const mesmaUn = cliente(
    [
      ...outras,
      { preco_unitario: 5000, sigla_unidade_fornecimento: "UN" },
      { preco_unitario: 6000, sigla_unidade_fornecimento: "Unidade" },
      { preco_unitario: 7000, sigla_unidade_fornecimento: "UN" },
    ],
    (sigla) => sigla.toUpperCase() === "UN" || sigla.toUpperCase() === "UNIDADE",
  );
  const un = await recomendar(
    { ...entrada, unidade: "Unidade" },
    // deno-lint-ignore no-explicit-any
    mesmaUn.client as any,
  );
  assertEquals(mesmaUn.filtrou(), true);
  assertEquals(un.status, "SUCCESS_WITH_DATA");
  assertEquals(un.referencia?.n, 3);
  assertEquals(un.referencia?.mediana, 6000);

  const unCheias = Array.from({ length: LIMITE_AMOSTRAS }, () => ({
    preco_unitario: 1000,
    sigla_unidade_fornecimento: "UN",
  }));
  const mesmaCx = cliente(
    [
      ...unCheias,
      { preco_unitario: 5000, sigla_unidade_fornecimento: "cx" },
      { preco_unitario: 6000, sigla_unidade_fornecimento: "cx" },
      { preco_unitario: 7000, sigla_unidade_fornecimento: "cx" },
    ],
    (sigla) => sigla.toUpperCase() === "CX",
  );
  const cx = await recomendar(
    { ...entrada, unidade: "CX" },
    // deno-lint-ignore no-explicit-any
    mesmaCx.client as any,
  );
  assertEquals(mesmaCx.filtrou(), true);
  assertEquals(cx.status, "SUCCESS_WITH_DATA");
  assertEquals(cx.referencia?.n, 3);
  assertEquals(cx.referencia?.mediana, 6000);
});
