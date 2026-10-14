import { assertEquals } from "jsr:@std/assert@1";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";
import { handleRequest, LIMITE_CATALOGO } from "../../../supabase/functions/api-catalogo-ficha/index.ts";
import { type AtributoFicha, ATRIBUTOS_ONTOLOGIA_FICHA, familiaDe, fichaTecnica, planejar, validarFicha, type ProdutoExistente } from "../../../supabase/functions/api-catalogo-ficha/ficha.ts";
import { createSupabaseRepo, type FichaRepo } from "../../../supabase/functions/api-catalogo-ficha/repo.ts";
import type { LinhaProduto } from "../../../supabase/functions/api-catalogo-ficha/ficha.ts";

const USER: AuthenticatedUser = { id: "u-1", email: "a@konnen.test", app_metadata: {} };

const AIR = {
  action: "gravar",
  nome: "Arc Runner",
  codigo: "HR007",
  url: "https://www.konnenfitness.com.br/produto/cardio-arc-runner/",
  categorias: ["Cardio", "Profissional"],
  medidas: null,
  destaques: [{ titulo: "Painel", texto: "Leitura rápida no treino." }],
  imagens: ["https://www.konnenfitness.com.br/wp-content/uploads/2026/06/hr007.jpg"],
  post_id: "8473",
};

function repoMemoria() {
  const linhas = new Map<number, LinhaProduto & { id: number }>();
  const medidas = new Map<number, string>();
  const atributos = new Map<number, AtributoFicha[]>();
  let seq = 0;
  const achar = (pred: (l: LinhaProduto & { id: number }) => boolean): ProdutoExistente | null => {
    for (const l of linhas.values()) {
      if (!pred(l)) continue;
      return { id: l.id, tenant_id: l.tenant_id, codigo: l.codigo, url: l.url, atributos: l.atributos, descricao: l.descricao, no_taxonomia: l.no_taxonomia ?? null };
    }
    return null;
  };
  const repo: FichaRepo = {
    porUrl: (url) => Promise.resolve(achar((l) => l.url === url)),
    porCodigo: (tenant, codigo) => Promise.resolve(achar((l) => l.tenant_id === tenant && l.codigo === codigo)),
    inserir: (linha) => {
      const id = ++seq;
      linhas.set(id, { ...linha, id });
      return Promise.resolve(id);
    },
    atualizar: (id, linha) => {
      // UPDATE só mexe nas colunas enviadas: no_taxonomia corrigido à mão não some quando a ficha não o manda.
      linhas.set(id, { ...linhas.get(id), ...linha, id });
      return Promise.resolve();
    },
    gravarMedida: (id, texto) => {
      medidas.set(id, texto);
      return Promise.resolve();
    },
    gravarAtributos: (id, itens) => {
      const vieram = new Set(itens.map((i) => i.atributo));
      const mantidos = (atributos.get(id) ?? []).filter((a) =>
        !(ATRIBUTOS_ONTOLOGIA_FICHA as readonly string[]).includes(a.atributo) || vieram.has(a.atributo)
      );
      atributos.set(id, [...mantidos.filter((a) => !vieram.has(a.atributo)), ...itens]);
      return Promise.resolve();
    },
    listar: (tenant, limite) => {
      const minhas = [...linhas.values()].filter((l) => l.tenant_id === tenant)
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
      const itens = minhas.slice(0, limite).map((l) => ({
        id: l.id, marca: l.marca, codigo: l.codigo, nome: l.nome, url: l.url, categorias: l.categorias,
        familia_equipamento: l.familia_equipamento, no_taxonomia: l.no_taxonomia ?? null,
        carga_maxima_kg: l.carga_maxima_kg ?? null, peso_equipamento_kg: l.peso_equipamento_kg ?? null,
        ativo: l.ativo, last_seen_at: l.last_seen_at,
        imagens: (l.atributos.imagens as string[] | undefined) ?? [],
        atributos: [
          ...(medidas.has(l.id) ? [{ atributo: "medida", valor_texto: medidas.get(l.id)!, valor_num: null }] : []),
          ...(atributos.get(l.id) ?? []),
        ],
      }));
      return Promise.resolve({ itens, truncado: minhas.length > limite });
    },
  };
  return { repo, linhas, medidas };
}

function post(body: unknown, user: AuthenticatedUser | null = USER) {
  const mem = repoMemoria();
  return {
    mem,
    res: handleRequest(new Request("https://local/api-catalogo-ficha", {
      method: "POST",
      body: JSON.stringify(body),
    }), {
      getUser: () => Promise.resolve(user),
      getRepo: () => mem.repo,
      tenantDe: () => Promise.resolve({ tenant: 7, papel: "operacao" }),
      agora: () => "2026-10-12T22:00:00.000Z",
    }),
  };
}

Deno.test("familia cardio não usa a categoria Profissional", () => {
  assertEquals(familiaDe(["Cardio", "Profissional"]), "cardio");
  assertEquals(familiaDe(["Profissional"]), null);
});

Deno.test("host fora da lista não grava", () => {
  let status = 0;
  try {
    validarFicha({ ...AIR, url: "https://exemplo.com/produto/x/" });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});

Deno.test("grava Arc Runner na empresa de quem chama", async () => {
  const { res, mem } = post(AIR);
  const resposta = await res;
  assertEquals(resposta.status, 200);
  const corpo = await resposta.json();
  assertEquals(corpo.atualizado, false);
  assertEquals(corpo.codigo, "HR007");
  const linha = mem.linhas.get(corpo.id)!;
  assertEquals(linha.tenant_id, 7);
  assertEquals(linha.marca, "Konnen");
  assertEquals(linha.familia_equipamento, "cardio");
  assertEquals(linha.nome, "Arc Runner");
  assertEquals((linha.atributos.destaques as { titulo: string }[])[0].titulo, "Painel");
});

Deno.test("a mesma URL atualiza a ficha e não cria outra linha", async () => {
  const mem = repoMemoria();
  const ctx = {
    getUser: () => Promise.resolve(USER),
    getRepo: () => mem.repo,
    tenantDe: () => Promise.resolve({ tenant: 7, papel: "admin" as const }),
    agora: () => "2026-10-12T22:00:00.000Z",
  };
  const req = () => new Request("https://local/api-catalogo-ficha", { method: "POST", body: JSON.stringify(AIR) });
  await handleRequest(req(), ctx);
  const segunda = await handleRequest(req(), ctx);
  assertEquals(segunda.status, 200);
  assertEquals((await segunda.json()).atualizado, true);
  assertEquals(mem.linhas.size, 1);
});

Deno.test("página de outra empresa responde 409", () => {
  const outra: ProdutoExistente = {
    id: 3, tenant_id: 9, codigo: "HR007", url: "https://www.konnenfitness.com.br/produto/cardio-arc-runner/",
    atributos: {}, descricao: null,
  };
  const entrada = validarFicha(AIR);
  let status = 0;
  try {
    planejar(7, entrada, outra, null, "2026-10-12T22:00:00.000Z");
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 409);
});

Deno.test("sem sessão responde 401", async () => {
  const { res } = post(AIR, null);
  assertEquals((await res).status, 401);
});

const FOTOS_K_RUN = [
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/Image_20240319142857.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.2.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.3.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.4.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.6.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.7.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/tela-5.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/piso.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/impacto.jpg",
];

const K_RUN = {
  ...AIR,
  nome: "ESTEIRA K-RUN",
  codigo: "K-RUN",
  url: "https://www.konnenfitness.com.br/produto/cardio-esteira-k/",
  medidas: "2048 x 955 x 1545 mm",
  destaques: [{
    titulo: "Sensor de Batimentos Cardíacos e Níveis de Inclinação",
    texto: "A K-RUN conta com um painel de fácil visualização que exibe velocidade, tempo, distância, calorias e frequência cardíaca. " +
      "Motor de 3.0 PHP, velocidades de até 20 km/h, área de corrida de 1550 x 580 mm e usuários de até 180 kg.",
  }],
};

Deno.test("ESTEIRA K-RUN: slug do dicionário e atributos nos nomes da ontologia", () => {
  const entrada = validarFicha({
    ...K_RUN,
    especificacoes: [
      { rotulo: "Velocidade", valor: "0.8 – 20 Km/h" },
      { rotulo: "Motor", valor: "3.0 PHP" },
      { rotulo: "Área de corrida", valor: "1550 X 580 mm" },
      { rotulo: "Peso Máx. usuário", valor: "180 kg" },
      { rotulo: "Inclinação", valor: "0 a 15%" },
    ],
  });
  const tecnica = fichaTecnica(entrada);
  assertEquals(tecnica.no_taxonomia, "esteira_eletrica");
  assertEquals(tecnica.carga_maxima_kg, 180);
  assertEquals(tecnica.peso_equipamento_kg, null);
  const por = new Map(tecnica.atributos.map((a) => [a.atributo, a]));
  assertEquals([...por.keys()].sort(), [
    "area_corrida", "capacidade_usuario_kg_min", "inclinacao", "motor_hp_min", "velocidade_kmh_min",
  ]);
  assertEquals(por.get("capacidade_usuario_kg_min"), { atributo: "capacidade_usuario_kg_min", valor_texto: "180 kg", valor_num: 180 });
  assertEquals(por.get("velocidade_kmh_min"), { atributo: "velocidade_kmh_min", valor_texto: "0.8 – 20 Km/h", valor_num: 20 });
  assertEquals(por.get("motor_hp_min"), { atributo: "motor_hp_min", valor_texto: "3.0 PHP", valor_num: 3 });
  assertEquals(por.get("area_corrida")!.valor_texto, "1550 X 580 mm");
  assertEquals(por.get("inclinacao")!.valor_texto, "0 a 15%");
  const plano = planejar(7, entrada, null, null, "2026-10-13T03:07:35.000Z");
  assertEquals(plano.linha.no_taxonomia, "esteira_eletrica");
  assertEquals(plano.linha.carga_maxima_kg, 180);
  assertEquals("taxonomia" in plano.linha.atributos, false);
});

Deno.test("sem especificacoes (o Dashboard de hoje), só o número com unidade dos destaques entra", () => {
  const tecnica = fichaTecnica(validarFicha(K_RUN));
  const por = new Map(tecnica.atributos.map((a) => [a.atributo, a]));
  assertEquals([...por.keys()].sort(), ["area_corrida", "capacidade_usuario_kg_min", "motor_hp_min", "velocidade_kmh_min"]);
  assertEquals(por.get("capacidade_usuario_kg_min")!.valor_num, 180);
  assertEquals(por.get("velocidade_kmh_min")!.valor_num, 20);
  assertEquals(por.get("motor_hp_min")!.valor_num, 3);
  assertEquals(por.get("area_corrida")!.valor_texto, "1550 x 580 mm");
  // "Níveis de Inclinação" e "painel" são marketing sem valor: não viram atributo.
  assertEquals(por.has("inclinacao"), false);
});

Deno.test("esteira curva é esteira_nao_eletrica e não ganha atributo da ontologia da elétrica", () => {
  const entrada = validarFicha({ ...K_RUN, nome: "Esteira Curva K-CURVE", codigo: "K-CURVE",
    url: "https://www.konnenfitness.com.br/produto/cardio-esteira-curva/", especificacoes: [{ rotulo: "Peso máximo usuário", valor: "200 kg" }] });
  const tecnica = fichaTecnica(entrada);
  assertEquals(tecnica.no_taxonomia, "esteira_nao_eletrica");
  assertEquals(tecnica.carga_maxima_kg, 200);
  assertEquals(tecnica.atributos, []);
});

Deno.test("regras do dicionário: sem motor, esteira ambígua e esteira de yoga", () => {
  const nome = (n: string, esp: { rotulo: string; valor: string }[] = []) =>
    fichaTecnica(validarFicha({ ...K_RUN, nome: n, destaques: [], especificacoes: esp }));
  assertEquals(nome("Esteira sem motor K-FLOW").no_taxonomia, "esteira_nao_eletrica");
  assertEquals(nome("Esteira Profissional Curva").no_taxonomia, "esteira_nao_eletrica");
  // "esteira" sozinha é ambígua no dicionário: sem evidência de motor/velocidade, não classifica.
  assertEquals(nome("Esteira K-RUN").no_taxonomia, null);
  assertEquals(nome("Esteira de yoga 10 mm").no_taxonomia, null);
  // Evidência nas especificações basta.
  const comMotor = nome("Esteira K-RUN", [{ rotulo: "Motor", valor: "2.5 HP (5.0 HP pico)" }]);
  assertEquals(comMotor.no_taxonomia, "esteira_eletrica");
  assertEquals(comMotor.atributos.find((a) => a.atributo === "motor_hp_min")!.valor_num, 2.5);
});

Deno.test("Codex #359: 'sem motor' nas especificações vence a evidência de motor; 'manual' no destaque não nega", () => {
  const semMotor = fichaTecnica(validarFicha({ ...K_RUN, nome: "Esteira X", destaques: [],
    especificacoes: [{ rotulo: "Motor", valor: "sem motor" }, { rotulo: "Velocidade", valor: "até 20 km/h" }] }));
  assertEquals(semMotor.no_taxonomia, "esteira_nao_eletrica");
  assertEquals(semMotor.atributos, []);
  const tipoManual = fichaTecnica(validarFicha({ ...K_RUN, nome: "Esteira X", destaques: [],
    especificacoes: [{ rotulo: "Tipo", valor: "manual" }] }));
  assertEquals(tipoManual.no_taxonomia, "esteira_nao_eletrica");
  const manualNoDestaque = fichaTecnica(validarFicha({ ...K_RUN, nome: "Esteira X", especificacoes: [],
    destaques: [{ titulo: "Documentação", texto: "Acompanha manual do usuário. Motor de 3.0 PHP." }] }));
  assertEquals(manualNoDestaque.no_taxonomia, "esteira_eletrica");
});

Deno.test("Codex #359: o número da velocidade e do motor é o que está junto da unidade", () => {
  const t = fichaTecnica(validarFicha({ ...K_RUN, destaques: [], especificacoes: [
    { rotulo: "Velocidade", valor: "1–20 km/h, 220 V" },
    { rotulo: "Motor", valor: "2.5 HP (5.0 HP pico), 220 V" },
  ] }));
  const por = new Map(t.atributos.map((a) => [a.atributo, a.valor_num]));
  assertEquals(por.get("velocidade_kmh_min"), 20);
  assertEquals(por.get("motor_hp_min"), 2.5);
});

Deno.test("Codex #359: corrigir à mão para não elétrica apaga os atributos da elétrica na regravação", async () => {
  const mem = repoMemoria();
  const ctx = ctxDe(mem, 7);
  const primeira = await (await handleRequest(pedido(K_RUN), ctx)).json();
  let lista = (await (await handleRequest(pedido({ action: "listar" }), ctx)).json()).itens[0];
  assertEquals(lista.atributos.some((a: { atributo: string }) => a.atributo === "motor_hp_min"), true);
  // admin corrige a taxonomia à mão
  mem.linhas.get(primeira.id)!.no_taxonomia = "esteira_nao_eletrica";
  await handleRequest(pedido(K_RUN), ctx);
  lista = (await (await handleRequest(pedido({ action: "listar" }), ctx)).json()).itens[0];
  assertEquals(lista.no_taxonomia, "esteira_nao_eletrica");
  assertEquals(lista.atributos.map((a: { atributo: string }) => a.atributo), ["medida"]);
});

Deno.test("produto corrigido à mão para não elétrica não ganha atributos da elétrica", () => {
  const existente: ProdutoExistente = {
    id: 3, tenant_id: 7, codigo: "K-RUN", url: K_RUN.url, atributos: {}, descricao: null, no_taxonomia: "esteira_nao_eletrica",
  };
  const plano = planejar(7, validarFicha(K_RUN), existente, null, "2026-10-13T03:07:35.000Z");
  assertEquals(plano.atributosFicha, []);
  assertEquals(plano.linha.carga_maxima_kg, 180);
});

Deno.test("produto que não é esteira não ganha taxonomia nem colunas", () => {
  const plano = planejar(7, validarFicha(AIR), null, null, "2026-10-13T03:07:35.000Z");
  assertEquals(plano.linha.no_taxonomia, undefined);
  assertEquals(plano.linha.carga_maxima_kg, undefined);
  assertEquals(plano.atributosFicha, []);
});

Deno.test("regravar a ficha não sobrescreve a taxonomia corrigida à mão", () => {
  const existente: ProdutoExistente = {
    id: 3, tenant_id: 7, codigo: "K-RUN", url: K_RUN.url, atributos: {}, descricao: null, no_taxonomia: "esteira_nao_eletrica",
  };
  const plano = planejar(7, validarFicha(K_RUN), existente, null, "2026-10-13T03:07:35.000Z");
  assertEquals(plano.linha.no_taxonomia, undefined);
  assertEquals(plano.linha.carga_maxima_kg, 180);
});

Deno.test("o handler grava os atributos da ontologia na tabela de atributos", async () => {
  const mem = repoMemoria();
  const gravados: { atributo: string; valor_num: number | null }[] = [];
  mem.repo.gravarAtributos = (_id, itens) => {
    gravados.push(...itens.map((i) => ({ atributo: i.atributo, valor_num: i.valor_num })));
    return Promise.resolve();
  };
  const res = await handleRequest(new Request("https://local/api-catalogo-ficha", { method: "POST", body: JSON.stringify(K_RUN) }), {
    getUser: () => Promise.resolve(USER),
    getRepo: () => mem.repo,
    tenantDe: () => Promise.resolve({ tenant: 7, papel: "admin" as const }),
    agora: () => "2026-10-13T03:07:35.000Z",
  });
  assertEquals(res.status, 200);
  assertEquals(gravados.map((g) => g.atributo).sort(), ["area_corrida", "capacidade_usuario_kg_min", "motor_hp_min", "velocidade_kmh_min"]);
  assertEquals(gravados.find((g) => g.atributo === "capacidade_usuario_kg_min")!.valor_num, 180);
});

Deno.test("K-RUN e as 9 fotos da esteira passam", () => {
  const entrada = validarFicha({
    ...AIR,
    nome: "ESTEIRA K-RUN",
    codigo: "K-RUN",
    url: "https://www.konnenfitness.com.br/produto/cardio-esteira-k/",
    imagens: FOTOS_K_RUN,
  });
  assertEquals(entrada.codigo, "K-RUN");
  assertEquals(entrada.imagens.length, 9);
});

Deno.test("palavra sem dígito nem hífen não vira código", () => {
  let status = 0;
  try {
    validarFicha({ ...AIR, codigo: "Cardio" });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});

Deno.test("mais de 12 imagens é recusado", () => {
  const imagens = Array.from(
    { length: 13 },
    (_, i) => `https://www.konnenfitness.com.br/wp-content/uploads/2025/03/foto-${i}.jpg`,
  );
  let status = 0;
  try {
    validarFicha({ ...AIR, imagens });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});

function ctxDe(mem: ReturnType<typeof repoMemoria>, tenant = 7) {
  return {
    getUser: () => Promise.resolve(USER),
    getRepo: () => mem.repo,
    tenantDe: () => Promise.resolve({ tenant, papel: "admin" as const }),
    agora: () => "2026-10-13T20:00:00.000Z",
  };
}

function pedido(body: unknown) {
  return new Request("https://local/api-catalogo-ficha", { method: "POST", body: JSON.stringify(body) });
}

Deno.test("listar devolve só os produtos da empresa de quem chama, com os atributos da ficha", async () => {
  const mem = repoMemoria();
  await handleRequest(pedido(K_RUN), ctxDe(mem, 7));
  await handleRequest(pedido(AIR), ctxDe(mem, 7));
  await handleRequest(pedido({ ...AIR, codigo: "HR009", url: "https://www.konnenfitness.com.br/produto/outra/" }), ctxDe(mem, 9));
  const res = await handleRequest(pedido({ action: "listar" }), ctxDe(mem, 7));
  assertEquals(res.status, 200);
  const corpo = await res.json();
  assertEquals(corpo.truncado, false);
  assertEquals(corpo.itens.length, 2);
  const krun = corpo.itens.find((i: { codigo: string }) => i.codigo === "K-RUN");
  assertEquals(krun.nome, "ESTEIRA K-RUN");
  assertEquals(krun.no_taxonomia, "esteira_eletrica");
  assertEquals(krun.carga_maxima_kg, 180);
  assertEquals(krun.familia_equipamento, "cardio");
  assertEquals(krun.imagens.length, 1);
  assertEquals(krun.atributos.find((a: { atributo: string }) => a.atributo === "capacidade_usuario_kg_min").valor_num, 180);
  const air = corpo.itens.find((i: { codigo: string }) => i.codigo === "HR007");
  assertEquals(air.no_taxonomia, null);
  assertEquals(air.atributos, []);
});

Deno.test("listar com catálogo vazio devolve lista vazia, não erro", async () => {
  const res = await handleRequest(pedido({ action: "listar" }), ctxDe(repoMemoria(), 7));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { itens: [], truncado: false });
});

Deno.test("listar avisa truncado quando a empresa tem mais produtos que o limite", async () => {
  const mem = repoMemoria();
  for (let i = 0; i < LIMITE_CATALOGO + 1; i++) {
    mem.repo.inserir({
      marca: "Konnen", codigo: `P${i}`, nome: `Produto ${i}`, url: `https://www.konnenfitness.com.br/produto/p${i}/`,
      tenant_id: 7, categorias: [], familia_equipamento: null, descricao: null, atributos: {}, ativo: true,
      last_seen_at: `2026-10-13T20:${String(i % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  const corpo = await (await handleRequest(pedido({ action: "listar" }), ctxDe(mem, 7))).json();
  assertEquals(corpo.itens.length, LIMITE_CATALOGO);
  assertEquals(corpo.truncado, true);
});

Deno.test("ação desconhecida responde 400 e sem sessão 401 também no listar", async () => {
  const mem = repoMemoria();
  assertEquals((await handleRequest(pedido({ action: "apagar" }), ctxDe(mem))).status, 400);
  assertEquals((await handleRequest(pedido({}), ctxDe(mem))).status, 400);
  const semSessao = await handleRequest(pedido({ action: "listar" }), { ...ctxDe(mem), getUser: () => Promise.resolve(null) });
  assertEquals(semSessao.status, 401);
});

// Cliente falso mínimo do supabase-js para repo.listar: cada tabela resolve com o resultado dado.
function clienteCatalogo(produtos: Record<string, unknown>[], atributos: Record<string, unknown>[]) {
  const consulta = (resultado: { data: unknown; error: unknown }) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, falha);
    return q;
  };
  return {
    from: (tabela: string) =>
      consulta(tabela === "catalogo_produtos" ? { data: produtos, error: null } : { data: atributos, error: null }),
  } as unknown as Parameters<typeof createSupabaseRepo>[0];
}

Deno.test("repo real: listar corta no limite, avisa truncado, converte numeric e junta os atributos por produto", async () => {
  const produtos = Array.from({ length: LIMITE_CATALOGO + 1 }, (_, i) => ({
    id: i + 1, marca: "Konnen", codigo: `P${i + 1}`, nome: `Produto ${i + 1}`, url: null, categorias: ["Cardio"],
    familia_equipamento: "cardio", no_taxonomia: i === 0 ? "esteira_eletrica" : null,
    carga_maxima_kg: i === 0 ? "180.00" : null, peso_equipamento_kg: null, ativo: true,
    last_seen_at: "2026-10-13T20:00:00+00:00",
    atributos: i === 0 ? { imagens: ["https://www.konnenfitness.com.br/a.jpg", 7], origem: "html" } : {},
  }));
  const atributos = [
    { produto_id: 1, atributo: "capacidade_usuario_kg_min", valor_texto: "180 kg", valor_num: "180" },
    { produto_id: 1, atributo: "medida", valor_texto: "2048 x 955 x 1545 mm", valor_num: null },
    { produto_id: 2, atributo: "medida", valor_texto: "1 x 1 m", valor_num: null },
  ];
  const repo = createSupabaseRepo(clienteCatalogo(produtos, atributos));
  const { itens, truncado } = await repo.listar(7, LIMITE_CATALOGO);
  assertEquals(truncado, true);
  assertEquals(itens.length, LIMITE_CATALOGO);
  assertEquals(itens[0].carga_maxima_kg, 180);
  assertEquals(itens[0].imagens, ["https://www.konnenfitness.com.br/a.jpg"]);
  assertEquals(itens[0].atributos, [
    { atributo: "capacidade_usuario_kg_min", valor_texto: "180 kg", valor_num: 180 },
    { atributo: "medida", valor_texto: "2048 x 955 x 1545 mm", valor_num: null },
  ]);
  assertEquals(itens[1].atributos.map((a) => a.atributo), ["medida"]);
  assertEquals(itens[2].atributos, []);
  assertEquals(itens[2].no_taxonomia, null);
});

Deno.test("repo real: erro do banco no listar vira exceção, não lista vazia", async () => {
  const falha = { data: null, error: { message: "permission denied" } };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown, f?: (e: unknown) => unknown) => Promise.resolve(falha).then(ok, f);
  const repo = createSupabaseRepo({ from: () => q } as unknown as Parameters<typeof createSupabaseRepo>[0]);
  const erro = await repo.listar(7, LIMITE_CATALOGO).then(() => null, (e) => e);
  assertEquals(erro instanceof Error && erro.message, "permission denied");
});
