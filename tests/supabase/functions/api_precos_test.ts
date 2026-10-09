// Spec specs/0009-precos-historicos-pesquisa-preco.md: GET api-precos (CA-1 a CA-4, backend).
// PostgREST falso em memória (from + rpc, eq/gt/gte/lte, order com nulos, range e contagem) que registra cada chamada,
// para provar que os filtros vão para o banco, que o catálogo é conferido e que nada é lido antes da autenticação.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FONTE, periodoDe, type PrecosClient, responderPrecos } from "../../../supabase/functions/api-precos/precos.ts";

type Linha = Record<string, unknown>;

interface Chamada {
  alvo: string;
  metodo: string;
  args: unknown[];
}

interface Erros {
  catalogo?: { message: string };
  resumo?: { message: string };
  amostras?: { message: string };
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function criarFake(opts: {
  catalogo?: number[];
  resumo?: Linha[];
  linhas?: Linha[];
  erros?: Erros;
}) {
  const chamadas: Chamada[] = [];
  const catalogo = opts.catalogo ?? [2640, 8166];

  function builder(alvo: string, fonte: () => Linha[], erro?: { message: string }) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let faixa: [number, number] | null = null;
    let contar = false;
    const gravar = (metodo: string, args: unknown[]) => chamadas.push({ alvo, metodo, args });
    const q = {
      select(cols?: string, o?: { count?: string }) {
        gravar("select", [cols, o]);
        contar = o?.count === "exact";
        return q;
      },
      eq(col: string, v: unknown) {
        gravar("eq", [col, v]);
        filtros.push((l) => l[col] === v);
        return q;
      },
      gt(col: string, v: number) {
        gravar("gt", [col, v]);
        filtros.push((l) => typeof l[col] === "number" && (l[col] as number) > v);
        return q;
      },
      gte(col: string, v: string) {
        gravar("gte", [col, v]);
        filtros.push((l) => l[col] !== null && l[col] !== undefined && String(l[col]) >= v);
        return q;
      },
      lte(col: string, v: string) {
        gravar("lte", [col, v]);
        filtros.push((l) => l[col] !== null && l[col] !== undefined && String(l[col]) <= v);
        return q;
      },
      order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
        gravar("order", [col, o]);
        ordens.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst === true });
        return q;
      },
      range(a: number, b: number) {
        gravar("range", [a, b]);
        faixa = [a, b];
        return q;
      },
      then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
        if (erro) return Promise.resolve({ data: null, error: erro, count: null }).then(resolve, reject);
        let r = fonte().filter((l) => filtros.every((f) => f(l)));
        r = [...r].sort((x, y) => {
          for (const o of ordens) {
            const a = x[o.col];
            const b = y[o.col];
            const an = a === null || a === undefined;
            const bn = b === null || b === undefined;
            if (an !== bn) return (an ? 1 : -1) * (o.nullsFirst ? -1 : 1);
            if (!an && !bn) {
              const c = cmp(a, b);
              if (c !== 0) return o.asc ? c : -c;
            }
          }
          return 0;
        });
        const total = r.length;
        if (faixa && faixa[0] > 0 && faixa[0] >= total) {
          const e416 = { code: "PGRST103", message: "Requested range not satisfiable", details: `0-${total}` };
          return Promise.resolve({ data: null, error: e416, count: null }).then(resolve, reject);
        }
        if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
        return Promise.resolve({ data: r, error: null, count: contar ? total : null }).then(resolve, reject);
      },
    };
    return q;
  }

  const client = {
    from(tabela: string) {
      chamadas.push({ alvo: tabela, metodo: "from", args: [] });
      return builder(tabela, () => opts.linhas ?? [], opts.erros?.amostras);
    },
    rpc(funcao: string, args?: Record<string, unknown>) {
      chamadas.push({ alvo: funcao, metodo: "rpc", args: [args] });
      if (funcao === "catalogo_catmat_pdms_efetivos") {
        return builder(funcao, () => catalogo.map((codigo_pdm) => ({ codigo_pdm })), opts.erros?.catalogo);
      }
      return builder(funcao, () => opts.resumo ?? [], opts.erros?.resumo);
    },
  };
  return { client: client as unknown as PrecosClient, chamadas };
}

const HOJE = "2026-10-09";

async function chamar(qs: string, opts: Parameters<typeof criarFake>[0] = {}) {
  const fake = criarFake(opts);
  let clientes = 0;
  const url = new URL(`https://x.supabase.co/functions/v1/api-precos?${qs}`);
  const res = await responderPrecos(new Request(url, { headers: { Authorization: "Bearer jwt" } }), url, {
    requireAuth: () => Promise.resolve(null),
    criarCliente: () => {
      clientes++;
      return fake.client;
    },
    hoje: () => HOJE,
  });
  const body = await res.json();
  return { res, body, chamadas: fake.chamadas, clientes };
}

function resumoLinha(p: Partial<Linha> = {}): Linha {
  return {
    n: 10,
    media: 1500.5,
    preco_min: 900,
    p25: 1200,
    mediana: 1450.25,
    p75: 1800,
    preco_max: 2500,
    motivo: null,
    unidade_sigla: "UN",
    unidade_nome: "UNIDADE",
    unidade_n: 9,
    unidades: [{ sigla: "UN", nome: "UNIDADE", n: 9 }, { sigla: "PAR", nome: "PAR", n: 1 }],
    ultima_data_resultado: "2026-10-01",
    atualizado_em: "2026-10-03T02:09:15.381205+00:00",
    ...p,
  };
}

function amostra(p: Partial<Linha> = {}): Linha {
  return {
    id_compra: "15851705900012026",
    id_item_compra: 1,
    numero_item_compra: 1,
    codigo_item_catalogo: 480144,
    codigo_pdm: "2640",
    data_resultado: "2026-09-18",
    data_compra: "2026-08-01",
    codigo_uasg: "158517",
    nome_uasg: "UNILA",
    codigo_orgao: 26441,
    nome_orgao: "UNIVERSIDADE FEDERAL DA INTEGRAÇÃO LATINO-AMERICANA",
    estado: "PR",
    municipio: "FOZ DO IGUAÇU",
    quantidade: 2,
    preco_unitario: 9000,
    sigla_unidade_fornecimento: "UN",
    nome_unidade_fornecimento: "UNIDADE",
    sigla_unidade_medida: null,
    nome_unidade_medida: null,
    marca: "FORTIX",
    nome_fornecedor: "W.E.V COMERCIAL LTDA",
    ni_fornecedor: "04372852000160",
    objeto_compra: "Aquisição de equipamentos de academia",
    descricao_item: "CROSS OVER",
    descricao_detalhada_item: "Cross over com duas torres de peso",
    ...p,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

Deno.test("CA-1: sem JWT responde 401 e não cria cliente service_role", async () => {
  const url = new URL("https://x.supabase.co/functions/v1/api-precos?action=resumo&pdm=2640");
  let clientes = 0;
  const res = await responderPrecos(new Request(url), url, {
    requireAuth: () => Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
    criarCliente: () => {
      clientes++;
      return criarFake({}).client;
    },
    hoje: () => HOJE,
  });
  assertEquals(res.status, 401);
  assertEquals(clientes, 0);
});

Deno.test("CA-2: período de 12 ou 24 meses termina hoje e começa no dia seguinte ao de N meses atrás", () => {
  assertEquals(periodoDe("2026-10-09", 12), { inicio: "2025-10-10", fim: "2026-10-09" });
  assertEquals(periodoDe("2026-10-09", 24), { inicio: "2024-10-10", fim: "2026-10-09" });
  // fim de mês: 2028-02-29 - 12 meses = 2027-02-28 (como o Postgres), +1 dia
  assertEquals(periodoDe("2028-02-29", 12), { inicio: "2027-03-01", fim: "2028-02-29" });
  assertEquals(periodoDe("2026-12-31", 24), { inicio: "2025-01-01", fim: "2026-12-31" });
});

Deno.test("CA-2: resumo confere o catálogo, chama a função do banco com o período e devolve as estatísticas", async () => {
  const { res, body, chamadas } = await chamar("action=resumo&pdm=2640&meses=24&uf=pr&item=480144", {
    resumo: [resumoLinha()],
  });
  assertEquals(res.status, 200);
  const cat = chamadas.filter((c) => c.alvo === "catalogo_catmat_pdms_efetivos");
  assert(cat.some((c) => c.metodo === "eq" && c.args[0] === "codigo_pdm" && c.args[1] === 2640));
  const rpc = chamadas.find((c) => c.alvo === "precos_praticados_resumo" && c.metodo === "rpc");
  assertEquals(rpc?.args[0], {
    p_pdm: 2640,
    p_inicio: "2024-10-10",
    p_fim: "2026-10-09",
    p_item: 480144,
    p_uf: "PR",
    p_unidade: null,
  });
  assertEquals(body.fonte, FONTE);
  assertEquals(body.filtro, { pdm: 2640, item: 480144, meses: 24, uf: "PR", unidade: null });
  assertEquals(body.periodo_inicio, "2024-10-10");
  assertEquals(body.periodo_fim, "2026-10-09");
  assertEquals(body.n, 10);
  assertEquals(body.media, 1500.5);
  assertEquals(body.min, 900);
  assertEquals(body.p25, 1200);
  assertEquals(body.mediana, 1450.25);
  assertEquals(body.p75, 1800);
  assertEquals(body.max, 2500);
  assertEquals(body.motivo, null);
  assertEquals(body.unidade_fornecimento_predominante, { sigla: "UN", nome: "UNIDADE", n: 9 });
  assertEquals(body.ultima_data_resultado, "2026-10-01");
  assertEquals(body.atualizado_em, "2026-10-03T02:09:15.381205+00:00");
  assert(typeof body.arredondamento === "string" && body.arredondamento.includes("meio para longe do zero"));
});

Deno.test("CA-2: meses padrão é 12; sem item e sem UF vão null para o banco", async () => {
  const { body, chamadas } = await chamar("action=resumo&pdm=2640", { resumo: [resumoLinha()] });
  const rpc = chamadas.find((c) => c.alvo === "precos_praticados_resumo" && c.metodo === "rpc");
  assertEquals(rpc?.args[0], {
    p_pdm: 2640,
    p_inicio: "2025-10-10",
    p_fim: "2026-10-09",
    p_item: null,
    p_uf: null,
    p_unidade: null,
  });
  assertEquals(body.filtro, { pdm: 2640, item: null, meses: 12, uf: null, unidade: null });
});

Deno.test("CA-2: com n < 3 média e quartis vão null, com motivo, mesmo que o banco mande número", async () => {
  const { res, body } = await chamar("action=resumo&pdm=2640", {
    resumo: [resumoLinha({ n: 2, media: 10, p25: 10, mediana: 10, p75: 10, preco_min: 9, preco_max: 11, motivo: null })],
  });
  assertEquals(res.status, 200);
  assertEquals(body.n, 2);
  assertEquals(body.media, null);
  assertEquals(body.p25, null);
  assertEquals(body.mediana, null);
  assertEquals(body.p75, null);
  assertEquals(body.min, 9);
  assertEquals(body.max, 11);
  assert(typeof body.motivo === "string" && body.motivo.length > 0);
});

Deno.test("CA-2: recorte vazio devolve n = 0, valores null e motivo (não 404 nem lista vazia muda)", async () => {
  const { res, body } = await chamar("action=resumo&pdm=2640", {
    resumo: [resumoLinha({
      n: 0, media: null, preco_min: null, p25: null, mediana: null, p75: null, preco_max: null,
      motivo: "Sem preços homologados no recorte.", unidade_sigla: null, unidade_nome: null, unidade_n: null,
      ultima_data_resultado: null, atualizado_em: null,
    })],
  });
  assertEquals(res.status, 200);
  assertEquals(body.n, 0);
  assertEquals(body.media, null);
  assertEquals(body.min, null);
  assertEquals(body.unidade_fornecimento_predominante, null);
  assertEquals(body.motivo, "Sem preços homologados no recorte.");
});

Deno.test("CA-2: PDM fora do catálogo da empresa dá 400 explícito e não lê preço", async () => {
  const { res, body, chamadas } = await chamar("action=resumo&pdm=9999", { catalogo: [2640] });
  assertEquals(res.status, 400);
  assertEquals(body.codigo, "pdm_fora_do_catalogo");
  assert(!chamadas.some((c) => c.alvo === "precos_praticados_resumo" || c.alvo === "precos_praticados_itens"));
});

Deno.test("CA-3: amostras filtra no banco, ordena por data_resultado desc com desempate pela chave e pagina", async () => {
  const linhas = [
    amostra({ id_compra: "A", id_item_compra: 2, data_resultado: "2026-09-01" }),
    amostra({ id_compra: "A", id_item_compra: 1, data_resultado: "2026-09-01" }),
    amostra({ id_compra: "B", id_item_compra: 1, data_resultado: "2026-10-01" }),
    amostra({ id_compra: "C", id_item_compra: 1, data_resultado: "2024-01-01" }), // fora do período
    amostra({ id_compra: "D", id_item_compra: 1, estado: "SP" }),
    amostra({ id_compra: "E", id_item_compra: 1, codigo_pdm: "8166" }),
  ];
  const { res, body, chamadas } = await chamar("action=amostras&pdm=2640&uf=PR&limit=2&page=1", { linhas });
  assertEquals(res.status, 200);
  const q = chamadas.filter((c) => c.alvo === "precos_praticados_itens");
  const tem = (metodo: string, col: string, v: unknown) =>
    q.some((c) => c.metodo === metodo && c.args[0] === col && c.args[1] === v);
  assert(tem("eq", "codigo_pdm", "2640"));
  assert(tem("gte", "data_resultado", "2025-10-10"));
  assert(tem("lte", "data_resultado", "2026-10-09"));
  assert(tem("eq", "estado", "PR"));
  assert(tem("gt", "preco_unitario", 0));
  const ordens = q.filter((c) => c.metodo === "order").map((c) => c.args);
  assertEquals(ordens, [
    ["data_resultado", { ascending: false, nullsFirst: false }],
    ["id_compra", { ascending: true }],
    ["id_item_compra", { ascending: true }],
  ]);
  assert(q.some((c) => c.metodo === "range" && c.args[0] === 0 && c.args[1] === 1));
  assertEquals(body.total, 3);
  assertEquals(body.page, 1);
  assertEquals(body.limit, 2);
  assertEquals(body.periodo_inicio, "2025-10-10");
  assertEquals(body.periodo_fim, "2026-10-09");
  assertEquals(body.itens.map((i: Linha) => `${i.id_compra}-${i.id_item_compra}`), ["B-1", "A-1"]);

  const p2 = await chamar("action=amostras&pdm=2640&uf=PR&limit=2&page=2", { linhas });
  assertEquals(p2.body.itens.map((i: Linha) => `${i.id_compra}-${i.id_item_compra}`), ["A-2"]);
});

Deno.test("CA-3: amostra traz órgão, fornecedor, marca e fonte como vieram; ausente vira null", async () => {
  const linhas = [
    amostra({ marca: null, ni_fornecedor: null, descricao_detalhada_item: "", municipio: "  ", quantidade: null }),
  ];
  const { body } = await chamar("action=amostras&pdm=2640&item=480144", { linhas });
  assertEquals(body.itens?.length, 1);
  const i = body.itens[0];
  assertEquals(i.fonte, FONTE);
  assertEquals(i.marca, null);
  assertEquals(i.ni_fornecedor, null);
  assertEquals(i.descricao_detalhada_item, null);
  assertEquals(i.municipio, null);
  assertEquals(i.quantidade, null);
  assertEquals(i.nome_fornecedor, "W.E.V COMERCIAL LTDA");
  assertEquals(i.preco_unitario, 9000);
  assertEquals(i.codigo_uasg, "158517");
  assertEquals(i.nome_uasg, "UNILA");
  assertEquals(i.nome_orgao, "UNIVERSIDADE FEDERAL DA INTEGRAÇÃO LATINO-AMERICANA");
  assertEquals(i.uf, "PR");
  assertEquals(i.data_resultado, "2026-09-18");
  assertEquals(i.data_compra, "2026-08-01");
  assertEquals(i.id_compra, "15851705900012026");
  assertEquals(i.id_item_compra, 1);
  assertEquals(i.objeto_compra, "Aquisição de equipamentos de academia");
  assertEquals(i.sigla_unidade_fornecimento, "UN");
  assertEquals(i.sigla_unidade_medida, null);
  const chaves = Object.keys(i).sort();
  for (
    const k of [
      "data_resultado", "data_compra", "codigo_uasg", "nome_uasg", "codigo_orgao", "nome_orgao", "uf", "municipio",
      "quantidade", "preco_unitario", "sigla_unidade_fornecimento", "nome_unidade_fornecimento",
      "sigla_unidade_medida", "nome_unidade_medida", "marca", "nome_fornecedor", "ni_fornecedor", "ni_tipo", "objeto_compra",
      "descricao_item", "descricao_detalhada_item", "id_compra", "id_item_compra", "codigo_item_catalogo", "fonte",
    ]
  ) assert(chaves.includes(k), `falta ${k}`);
});

Deno.test("CA-4: parâmetro inválido dá 400 com mensagem e não cria cliente", async () => {
  for (
    const qs of [
      "", "action=xyz&pdm=2640", "action=resumo", "action=resumo&pdm=abc", "action=resumo&pdm=0",
      "action=resumo&pdm=2640&meses=6", "action=resumo&pdm=2640&meses=36", "action=resumo&pdm=2640&meses=12a",
      "action=resumo&pdm=2640&item=x", "action=resumo&pdm=2640&uf=Paraná", "action=resumo&pdm=2640&uf=P1",
      "action=amostras&pdm=2640&limit=0", "action=amostras&pdm=2640&limit=101", "action=amostras&pdm=2640&page=0",
      "action=amostras&pdm=2640&page=x", "action=resumo&pdm=2640&unidade=U%20N", "action=resumo&pdm=2640&unidade=UN!",
      `action=amostras&pdm=2640&unidade=${"A".repeat(11)}`,
    ]
  ) {
    const { res, body, clientes } = await chamar(qs);
    assertEquals(res.status, 400, qs);
    assert(typeof body.error === "string" && body.error.length > 0, qs);
    assertEquals(body.itens, undefined, qs);
    assertEquals(clientes, 0, qs);
  }
});

Deno.test("CA-4: erro de banco dá 500 com mensagem genérica, nunca lista vazia", async () => {
  const segredo = 'relation "precos_praticados_itens" does not exist';
  const casos: Array<[string, Erros]> = [
    ["action=resumo&pdm=2640", { catalogo: { message: segredo } }],
    ["action=resumo&pdm=2640", { resumo: { message: segredo } }],
    ["action=amostras&pdm=2640", { amostras: { message: segredo } }],
  ];
  for (const [qs, erros] of casos) {
    const { res, body } = await chamar(qs, { erros, resumo: [resumoLinha()] });
    assertEquals(res.status, 500, qs);
    assert(typeof body.error === "string" && !body.error.includes("relation"), qs);
    assertEquals(body.itens, undefined, qs);
    assertEquals(body.n, undefined, qs);
  }
});

Deno.test("CA-4: resposta da função de resumo fora do contrato (0 ou 2 linhas) é 500, não resumo vazio", async () => {
  for (const resumo of [[], [resumoLinha(), resumoLinha()]]) {
    const { res, body } = await chamar("action=resumo&pdm=2640", { resumo });
    assertEquals(res.status, 500);
    assertEquals(body.n, undefined);
  }
});

Deno.test("CA-4: amostras sem contagem é 500 (não verificado)", async () => {
  const fake = criarFake({ linhas: [amostra()] });
  const semCount = {
    ...fake.client,
    from: (t: string) => {
      const q = fake.client.from(t);
      const orig = q.select.bind(q);
      q.select = (cols: string) => orig(cols); // ignora o count pedido
      return q;
    },
  } as unknown as PrecosClient;
  const url = new URL("https://x.supabase.co/functions/v1/api-precos?action=amostras&pdm=2640");
  const res = await responderPrecos(new Request(url), url, {
    requireAuth: () => Promise.resolve(null),
    criarCliente: () => semCount,
    hoje: () => HOJE,
  });
  assertEquals(res.status, 500);
});

Deno.test("CA-2: resumo devolve todas as unidades do recorte, para o front saber que há mistura", async () => {
  const { body } = await chamar("action=resumo&pdm=2640", { resumo: [resumoLinha()] });
  assertEquals(body.unidades, [{ sigla: "UN", nome: "UNIDADE", n: 9 }, { sigla: "PAR", nome: "PAR", n: 1 }]);
  const vazio = await chamar("action=resumo&pdm=2640", { resumo: [resumoLinha({ unidades: null })] });
  assertEquals(vazio.body.unidades, []);
  // sigla nula no recorte aparece na lista (unidade ausente na fonte), nunca inventada
  const nula = await chamar("action=resumo&pdm=2640", {
    resumo: [resumoLinha({ unidades: [{ sigla: null, nome: null, n: 3 }] })],
  });
  assertEquals(nula.body.unidades, [{ sigla: null, nome: null, n: 3 }]);
});

Deno.test("CA-2: unidade filtra no banco (p_unidade) e aparece no filtro, em maiúsculas", async () => {
  const { res, body, chamadas } = await chamar("action=resumo&pdm=2640&unidade=un", { resumo: [resumoLinha()] });
  assertEquals(res.status, 200);
  const rpc = chamadas.find((c) => c.alvo === "precos_praticados_resumo" && c.metodo === "rpc");
  assertEquals((rpc?.args[0] as Record<string, unknown>).p_unidade, "UN");
  assertEquals(body.filtro.unidade, "UN");
});

Deno.test("CA-3: amostras com unidade filtra sigla_unidade_fornecimento no banco", async () => {
  const linhas = [
    amostra({ id_compra: "A", sigla_unidade_fornecimento: "UN" }),
    amostra({ id_compra: "B", sigla_unidade_fornecimento: "PAR" }),
    amostra({ id_compra: "C", sigla_unidade_fornecimento: null }),
  ];
  const { res, body, chamadas } = await chamar("action=amostras&pdm=2640&unidade=PAR", { linhas });
  assertEquals(res.status, 200);
  assert(chamadas.some((c) => c.metodo === "eq" && c.args[0] === "sigla_unidade_fornecimento" && c.args[1] === "PAR"));
  assertEquals(body.total, 1);
  assertEquals(body.itens.map((i: Linha) => i.id_compra), ["B"]);
  assertEquals(body.filtro.unidade, "PAR");
});

Deno.test("CA-4: página além do total é 400 explícito (não 500 nem lista vazia)", async () => {
  const linhas = [amostra({ id_compra: "A" }), amostra({ id_compra: "B" })];
  const { res, body } = await chamar("action=amostras&pdm=2640&limit=2&page=2", { linhas });
  assertEquals(res.status, 400);
  assertEquals(body.codigo, "page_alem_do_total");
  assert(typeof body.error === "string" && body.error.length > 0);
  assertEquals(body.itens, undefined);
  // recorte vazio na página 1 continua 200 com total 0
  const vazio = await chamar("action=amostras&pdm=2640", { linhas: [] });
  assertEquals(vazio.res.status, 200);
  assertEquals(vazio.body.total, 0);
  assertEquals(vazio.body.itens, []);
});

Deno.test("CA-3: CPF de pessoa física não é exibido (LGPD); CNPJ mantido; NI malformado vira ausente", async () => {
  const linhas = [
    amostra({ id_compra: "A", ni_fornecedor: "04372852000160", nome_fornecedor: "W.E.V COMERCIAL LTDA" }),
    amostra({ id_compra: "B", ni_fornecedor: "12345678901", nome_fornecedor: "FULANO DE TAL" }),
    amostra({ id_compra: "C", ni_fornecedor: "0", nome_fornecedor: "EMPRESA X" }),
    amostra({ id_compra: "D", ni_fornecedor: "12", nome_fornecedor: "EMPRESA Y" }),
    amostra({ id_compra: "E", ni_fornecedor: "1234567", nome_fornecedor: "EMPRESA Z" }),
    amostra({ id_compra: "F", ni_fornecedor: "123456789", nome_fornecedor: "EMPRESA W" }),
    amostra({ id_compra: "G", ni_fornecedor: "", nome_fornecedor: "EMPRESA V" }),
    amostra({ id_compra: "H", ni_fornecedor: "04.372.852/0001-60", nome_fornecedor: "EMPRESA FORMATADA" }),
  ];
  const { body } = await chamar("action=amostras&pdm=2640&limit=100", { linhas });
  const por = Object.fromEntries(body.itens.map((i: Linha) => [i.id_compra, i]));

  assertEquals(por.A.ni_fornecedor, "04372852000160");
  assertEquals(por.A.ni_tipo, "cnpj");
  assertEquals(por.A.nome_fornecedor, "W.E.V COMERCIAL LTDA");

  assertEquals(por.B.ni_fornecedor, null);
  assertEquals(por.B.ni_tipo, "cpf");
  assertEquals(por.B.nome_fornecedor, "Pessoa física");
  assert(!JSON.stringify(body).includes("12345678901"));
  assert(!JSON.stringify(body).includes("FULANO"));

  for (const id of ["C", "D", "E", "F", "G", "H"]) {
    assertEquals(por[id].ni_fornecedor, null, id);
    assertEquals(por[id].ni_tipo, null, id);
  }
  assertEquals(por.C.nome_fornecedor, "EMPRESA X");
});
