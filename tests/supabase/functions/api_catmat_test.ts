import { assertEquals } from "jsr:@std/assert@1";
import { type ApiCatmatContext, handleRequest } from "../../../supabase/functions/api-catmat/index.ts";
import { estadoDoNo, indexarRegras } from "../../../supabase/functions/api-catmat/catalog.ts";
import type { CatmatRepo, ItemPdmInput, RegraInput } from "../../../supabase/functions/api-catmat/repo.ts";
import { limparCacheMemoria } from "../../../supabase/functions/api-catmat/tree.ts";
import type { CatmatPalavra, CatmatRegra } from "../../../supabase/functions/api-catmat/types.ts";

// ------------------------------------------------------------------------------------------------
// Dublês: repositório em memória e Compras.gov falso
// ------------------------------------------------------------------------------------------------

function repoMemoria() {
  let seq = 0;
  const regras: CatmatRegra[] = [];
  const grupos = new Map<number, { nome: string }>();
  const classes = new Map<number, { nome: string; grupo: number }>();
  const pdms = new Map<number, { nome: string; classe: number; grupo: number }>();
  const itens = new Map<number, ItemPdmInput>();
  const cache = new Map<string, { payload: unknown; total: number | null; expira_em: string }>();
  const palavras: CatmatPalavra[] = [];
  const chave = (r: RegraInput) => `${r.nivel}:${r.codigo_item ?? r.codigo_pdm ?? r.codigo_classe ?? r.codigo_grupo}`;
  const repo: CatmatRepo = {
    listarRegras: () => Promise.resolve([...regras]),
    obterRegraPorChave: (c) => Promise.resolve(regras.find((r) => r.chave === c) ?? null),
    obterRegra: (id) => Promise.resolve(regras.find((r) => r.id === id) ?? null),
    inserirRegra: (row, userId) => {
      const r = { ...row, id: ++seq, chave: chave(row), created_by: userId, updated_by: userId, created_at: "t", updated_at: "t" } as CatmatRegra;
      regras.push(r);
      return Promise.resolve(r);
    },
    atualizarRegra: (id, row, userId) => {
      const i = regras.findIndex((r) => r.id === id);
      regras[i] = { ...regras[i], ...row, updated_by: userId };
      return Promise.resolve(regras[i]);
    },
    removerRegra: (id) => {
      const i = regras.findIndex((r) => r.id === id);
      if (i < 0) return Promise.resolve(false);
      regras.splice(i, 1);
      return Promise.resolve(true);
    },
    upsertGrupo: (r) => (grupos.set(r.codigo_grupo, { nome: r.nome }), Promise.resolve()),
    upsertClasse: (r) => (classes.set(r.codigo_classe, { nome: r.nome, grupo: r.codigo_grupo }), Promise.resolve()),
    upsertPdm: (r) => (pdms.set(r.codigo_pdm, { nome: r.nome_pdm, classe: r.codigo_classe, grupo: r.codigo_grupo }), Promise.resolve()),
    upsertItensPdm: (rows) => (rows.forEach((r) => itens.set(r.codigo_item, r)), Promise.resolve()),
    pdmExiste: (c) => Promise.resolve(pdms.has(c)),
    pdmsEfetivos: () => {
      // Mesma herança da função SQL: regra mais específica vence, só incluídos
      const idx = indexarRegras(regras);
      const out = [];
      for (const [codigo, p] of pdms) {
        const r = idx.get(`pdm:${codigo}`) ?? idx.get(`classe:${p.classe}`) ?? idx.get(`grupo:${p.grupo}`);
        if (r?.incluido) out.push({ codigo_pdm: codigo, codigo_classe: p.classe, codigo_grupo: p.grupo, origem_nivel: r.nivel, regra_id: r.id });
      }
      return Promise.resolve(out);
    },
    nomesGrupos: (cs) => Promise.resolve(cs.filter((c) => grupos.has(c)).map((c) => ({ codigo: c, nome: grupos.get(c)!.nome, codigo_pai: null }))),
    nomesClasses: (cs) => Promise.resolve(cs.filter((c) => classes.has(c)).map((c) => ({ codigo: c, nome: classes.get(c)!.nome, codigo_pai: classes.get(c)!.grupo }))),
    nomesPdms: (cs) => Promise.resolve(cs.filter((c) => pdms.has(c)).map((c) => ({ codigo: c, nome: pdms.get(c)!.nome, codigo_pai: pdms.get(c)!.classe }))),
    itensDosPdms: (cs, limite) =>
      Promise.resolve([...itens.values()].filter((i) => cs.includes(i.codigo_pdm)).slice(0, limite)
        .map((i) => ({ codigo_item: i.codigo_item, codigo_pdm: i.codigo_pdm, descricao: i.descricao }))),
    cacheLer: (c) => Promise.resolve(cache.get(c) ?? null),
    cacheGravar: (c, payload, total, expira) => (cache.set(c, { payload, total, expira_em: expira.toISOString() }), Promise.resolve()),
    listarPalavras: (c) => Promise.resolve(palavras.filter((p) => p.codigo_pdm === c)),
    contarPalavrasPorPdm: (cs) => {
      const m = new Map<number, number>();
      for (const p of palavras) if (p.ativo && cs.includes(p.codigo_pdm)) m.set(p.codigo_pdm, (m.get(p.codigo_pdm) ?? 0) + 1);
      return Promise.resolve(m);
    },
    obterPalavra: (id) => Promise.resolve(palavras.find((p) => p.id === id) ?? null),
    inserirPalavra: (c, padrao, ativo) => {
      const p = { id: ++seq, codigo_pdm: c, padrao, ativo };
      palavras.push(p);
      return Promise.resolve(p);
    },
    atualizarPalavra: (id, padrao, ativo) => {
      const p = palavras.find((x) => x.id === id)!;
      Object.assign(p, { padrao, ativo });
      return Promise.resolve(p);
    },
    removerPalavra: (id) => {
      const i = palavras.findIndex((p) => p.id === id);
      if (i < 0) return Promise.resolve(false);
      palavras.splice(i, 1);
      return Promise.resolve(true);
    },
    regexValido: (p) => {
      try {
        new RegExp(p);
        return Promise.resolve(p.length <= 300);
      } catch {
        return Promise.resolve(false);
      }
    },
  };
  return { repo, regras, grupos, classes, pdms, itens, cache, palavras };
}

const G78 = { codigoGrupo: 78, nomeGrupo: "EQUIPAMENTOS PARA RECREAÇÃO E DESPORTOS", statusGrupo: true };
const CLASSES_78 = [
  { codigoGrupo: 78, codigoClasse: 7810, nomeClasse: "EQUIPAMENTO PARA ATLETISMO E DESPORTO", statusClasse: true },
  { codigoGrupo: 78, codigoClasse: 7820, nomeClasse: "JOGOS, BRINQUEDOS", statusClasse: true },
  { codigoGrupo: 78, codigoClasse: 7830, nomeClasse: "EQUIPAMENTO PARA GINÁSTICA E RECREAÇÃO", statusClasse: true },
];
const PDMS_7830 = [
  { codigoGrupo: 78, codigoClasse: 7830, codigoPdm: 7115, nomePdm: "ESTEIRA ELÉTRICA", statusPdm: true },
  { codigoGrupo: 78, codigoClasse: 7830, codigoPdm: 2638, nomePdm: "APARELHO / ACESSÓRIO", statusPdm: true },
  { codigoGrupo: 78, codigoClasse: 7830, codigoPdm: 2746, nomePdm: "APARELHO DE TREINAMENTO FISICO", statusPdm: false },
];
const ITENS_7115 = [
  { codigoItem: 373980, codigoGrupo: 78, codigoClasse: 7830, codigoPdm: 7115, descricaoItem: "ESTEIRA ELÉTRICA 150 KG", statusItem: true },
  { codigoItem: 319134, codigoGrupo: 78, codigoClasse: 7830, codigoPdm: 7115, descricaoItem: "ESTEIRA ELÉTRICA 18 KM/H", statusItem: true },
];

/** Compras.gov falso: responde por endpoint e parâmetro; registra as URLs chamadas. */
function comprasGovFalso(opts: { falhar?: boolean; paginarPdms?: boolean } = {}) {
  const chamadas: string[] = [];
  const fetchFn = ((input: string | URL) => {
    const url = new URL(String(input));
    chamadas.push(url.pathname + url.search);
    if (opts.falhar) return Promise.resolve(new Response("erro", { status: 503 }));
    const pagina = Number(url.searchParams.get("pagina") ?? 1);
    const corpo = (resultado: unknown[], paginasRestantes = 0) =>
      Promise.resolve(new Response(JSON.stringify({ resultado, totalRegistros: resultado.length, totalPaginas: 1, paginasRestantes })));
    if (url.pathname.endsWith("1_consultarGrupoMaterial")) return corpo([G78]);
    if (url.pathname.endsWith("2_consultarClasseMaterial")) return corpo(CLASSES_78);
    if (url.pathname.endsWith("3_consultarPdmMaterial")) {
      if (url.searchParams.get("codigoClasse") !== "7830") return corpo([]);
      if (opts.paginarPdms) return pagina === 1 ? corpo(PDMS_7830.slice(0, 2), 1) : corpo(PDMS_7830.slice(2), 0);
      return corpo(PDMS_7830);
    }
    if (url.pathname.endsWith("4_consultarItemMaterial")) {
      return corpo(url.searchParams.get("codigoPdm") === "7115" ? ITENS_7115 : []);
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return { fetchFn, chamadas };
}

const ADMIN = { id: "u-admin", app_metadata: { licitagym_role: "admin" } };
const COMUM = { id: "u-comum", app_metadata: {}, };

function ctx(mem: ReturnType<typeof repoMemoria>, gov = comprasGovFalso(), user: unknown = ADMIN, agora = () => 1_000_000): ApiCatmatContext {
  return {
    getRepo: () => mem.repo,
    getUser: () => Promise.resolve(user as never),
    fetchFn: gov.fetchFn,
    agora,
    dormir: () => Promise.resolve(),
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api-catmat", { method: "POST", body: JSON.stringify(body) });
}

// ------------------------------------------------------------------------------------------------
// Autenticação, validação e autorização
// ------------------------------------------------------------------------------------------------

Deno.test("api-catmat: sem usuário 401, GET 405, ação inválida 400", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  assertEquals((await handleRequest(post({ action: "catalogo_listar" }), { ...ctx(mem), getUser: () => Promise.resolve(null) })).status, 401);
  assertEquals((await handleRequest(new Request("http://localhost/api-catmat"), ctx(mem))).status, 405);
  assertEquals((await handleRequest(post({ action: "apagar_tudo" }), ctx(mem))).status, 400);
  assertEquals((await handleRequest(post({ action: "arvore", nivel: "classes" }), ctx(mem))).status, 400);
  assertEquals((await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, incluido: true }), ctx(mem))).status, 400);
});

Deno.test("api-catmat: usuário comum lê, mas não altera o catálogo nem força refresh (403)", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const c = ctx(mem, comprasGovFalso(), COMUM);
  assertEquals((await handleRequest(post({ action: "catalogo_listar" }), c)).status, 200);
  assertEquals((await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), c)).status, 200);
  for (const body of [
    { action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true },
    { action: "catalogo_remover", id: 1 },
    { action: "palavras_salvar", codigo_pdm: 7115, padrao: "esteira" },
    { action: "palavras_remover", id: 1 },
    { action: "arvore", nivel: "classes", codigo: 78, refresh: true },
  ]) {
    assertEquals((await handleRequest(post(body), c)).status, 403, JSON.stringify(body));
  }
  // user_metadata não conta como papel
  const falso = ctx(mem, comprasGovFalso(), { id: "x", app_metadata: {}, user_metadata: { licitagym_role: "admin" } });
  assertEquals((await handleRequest(post({ action: "catalogo_remover", id: 1 }), falso)).status, 403);
});

// ------------------------------------------------------------------------------------------------
// Árvore, cache e paginação
// ------------------------------------------------------------------------------------------------

Deno.test("api-catmat: árvore do grupo 78 lista as 3 classes e anota o estado das regras", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  await mem.repo.inserirRegra({
    nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: null, codigo_item: null,
    nome_snapshot: "GINÁSTICA", ancestrais_snapshot: {}, incluido: true, observacao: null,
  }, "u");
  const res = await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(mem));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.nos.map((n: { codigo: number }) => n.codigo).sort(), [7810, 7820, 7830]);
  assertEquals(body.nos.find((n: { codigo: number }) => n.codigo === 7830).estado, "incluido");
  assertEquals(body.nos.find((n: { codigo: number }) => n.codigo === 7810).estado, "nenhum");

  const pdms = await (await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7830 }), ctx(mem))).json();
  assertEquals(pdms.total, 2); // o inativo 2746 fica oculto
  assertEquals(pdms.inativos_ocultos, 1);
  assertEquals(pdms.nos.every((n: { estado: string; origem_nivel: string }) => n.estado === "herdado" && n.origem_nivel === "classe"), true);

  const comInativos = await (await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7830, incluir_inativos: true }), ctx(mem))).json();
  assertEquals(comInativos.total, 3);
});

Deno.test("api-catmat: cache em memória e no banco; Compras.gov fora do ar usa cache vencido (stale) ou 504", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const gov = comprasGovFalso();
  const primeira = await (await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(mem, gov))).json();
  assertEquals(primeira.fonte, "compras.gov");
  const segunda = await (await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(mem, gov))).json();
  assertEquals(segunda.fonte, "memoria");
  assertEquals(gov.chamadas.length, 1);
  assertEquals(mem.cache.has("classes:78"), true);

  // Memória limpa e cache do banco vencido (25 h depois): Compras.gov falha -> devolve o vencido marcado stale
  limparCacheMemoria();
  const depois = () => 1_000_000 + 25 * 3600_000;
  const stale = await (await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(mem, comprasGovFalso({ falhar: true }), ADMIN, depois))).json();
  assertEquals(stale.stale, true);
  assertEquals(stale.total, 3);

  // Sem cache nenhum e Compras.gov fora -> 504
  limparCacheMemoria();
  const vazio = repoMemoria();
  const res = await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(vazio, comprasGovFalso({ falhar: true })));
  assertEquals(res.status, 504);
});

Deno.test("api-catmat: percorre todas as páginas do Compras.gov (tamanhoPagina 500)", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const gov = comprasGovFalso({ paginarPdms: true });
  const body = await (await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7830, incluir_inativos: true }), ctx(mem, gov))).json();
  assertEquals(body.total, 3);
  assertEquals(gov.chamadas.filter((c) => c.includes("3_consultarPdmMaterial")).length, 2);
  assertEquals(gov.chamadas.every((c) => c.includes("tamanhoPagina=500")), true);
});

// ------------------------------------------------------------------------------------------------
// Catálogo: salvar, excluir, remover, listar
// ------------------------------------------------------------------------------------------------

Deno.test("api-catmat: registrar a classe 7830 grava ancestrais, materializa os PDMs e aparece nas opções", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const res = await handleRequest(post({ action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true }), ctx(mem));
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.regra.chave, "classe:7830");
  assertEquals(body.regra.created_by, "u-admin");
  assertEquals(body.pdms_materializados, 3);
  assertEquals(mem.grupos.has(78), true);
  assertEquals(mem.classes.has(7830), true);
  assertEquals([...mem.pdms.keys()].sort(), [2638, 2746, 7115]);

  const lista = await (await handleRequest(post({ action: "catalogo_listar" }), ctx(mem))).json();
  assertEquals(lista.resumo.regras, 1);
  assertEquals(lista.opcoes.grupos.map((g: { codigo: number }) => g.codigo), [78]);
  assertEquals(lista.opcoes.classes.map((c: { codigo: number }) => c.codigo), [7830]);
  assertEquals(lista.opcoes.pdms.length, 3);
  assertEquals(lista.resumo.pdms_sem_palavras, 3);

  // Salvar de novo atualiza (200), não duplica
  const de_novo = await handleRequest(post({ action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true, observacao: "núcleo" }), ctx(mem));
  assertEquals(de_novo.status, 200);
  assertEquals(mem.regras.length, 1);
});

Deno.test("api-catmat: catalogo_salvar recusa árvore vencida (stale) com 503 e não grava nada", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  // Aquece o cache do banco (classes e PDMs de 7830) e depois deixa vencer
  await handleRequest(post({ action: "arvore", nivel: "grupos", codigo: 78 }), ctx(mem));
  await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), ctx(mem));
  await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7830 }), ctx(mem));
  limparCacheMemoria();
  const depois = () => 1_000_000 + 25 * 3600_000;
  const c = ctx(mem, comprasGovFalso({ falhar: true }), ADMIN, depois);
  // Navegar continua possível com o vencido...
  assertEquals((await (await handleRequest(post({ action: "arvore", nivel: "classes", codigo: 78 }), c)).json()).stale, true);
  // ...mas registrar não
  const res = await handleRequest(post({ action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true }), c);
  assertEquals(res.status, 503);
  assertEquals(mem.regras.length, 0);
  assertEquals(mem.pdms.size, 0);
});

Deno.test("api-catmat: hierarquia gravada sem data_atualizacao_origem (não apaga a data do sync)", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const linhas: Record<string, unknown>[] = [];
  const orig = { g: mem.repo.upsertGrupo, c: mem.repo.upsertClasse, p: mem.repo.upsertPdm };
  mem.repo.upsertGrupo = (r) => (linhas.push(r), orig.g(r));
  mem.repo.upsertClasse = (r) => (linhas.push(r), orig.c(r));
  mem.repo.upsertPdm = (r) => (linhas.push(r), orig.p(r));
  const res = await handleRequest(post({ action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true }), ctx(mem));
  assertEquals(res.status, 201);
  assertEquals(linhas.length > 0, true);
  assertEquals(linhas.some((r) => "data_atualizacao_origem" in r), false);
});

Deno.test("api-catmat: lista vazia do Compras.gov não vai para o cache", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const gov = comprasGovFalso();
  const r1 = await (await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7810 }), ctx(mem, gov))).json();
  assertEquals(r1.total, 0);
  assertEquals(mem.cache.has("pdms:7810"), false);
  await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7810 }), ctx(mem, gov));
  assertEquals(gov.chamadas.filter((u) => u.includes("codigoClasse=7810")).length, 2);
});

Deno.test("api-catmat: exclusão só vale para nó herdado; o mais específico vence nas opções", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  // Excluir sem ancestral incluído -> 409
  const semPai = await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 2638, incluido: false }), ctx(mem));
  assertEquals(semPai.status, 409);

  await handleRequest(post({ action: "catalogo_salvar", nivel: "classe", codigo_grupo: 78, codigo_classe: 7830, incluido: true }), ctx(mem));
  const exclui = await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 2638, incluido: false }), ctx(mem));
  assertEquals(exclui.status, 201);

  const lista = await (await handleRequest(post({ action: "catalogo_listar" }), ctx(mem))).json();
  assertEquals(lista.opcoes.pdms.map((p: { codigo: number }) => p.codigo).sort(), [2746, 7115]);
  assertEquals(lista.resumo.exclusoes, 1);

  const arvore = await (await handleRequest(post({ action: "arvore", nivel: "pdms", codigo: 7830 }), ctx(mem))).json();
  assertEquals(arvore.nos.find((n: { codigo: number }) => n.codigo === 2638).estado, "excluido");
  assertEquals(arvore.nos.find((n: { codigo: number }) => n.codigo === 7115).estado, "herdado");
});

Deno.test("api-catmat: registrar PDM hidrata os itens; item avulso entra nas opções; nó inexistente 404; remover", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const pdm = await (await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 7115, incluido: true }), ctx(mem))).json();
  assertEquals(pdm.itens_hidratados, 2);
  assertEquals([...mem.itens.keys()].sort(), [319134, 373980]);

  const itemEx = await handleRequest(post({ action: "catalogo_salvar", nivel: "item", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 7115, codigo_item: 319134, incluido: false }), ctx(mem));
  assertEquals(itemEx.status, 201);
  const lista = await (await handleRequest(post({ action: "catalogo_listar" }), ctx(mem))).json();
  assertEquals(lista.opcoes.itens.map((i: { codigo: number }) => i.codigo), [373980]);

  const inexistente = await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 999999, incluido: true }), ctx(mem));
  assertEquals(inexistente.status, 404);

  const id = mem.regras.find((r) => r.chave === "item:319134")!.id;
  assertEquals((await handleRequest(post({ action: "catalogo_remover", id }), ctx(mem))).status, 200);
  assertEquals((await handleRequest(post({ action: "catalogo_remover", id }), ctx(mem))).status, 404);
});

// ------------------------------------------------------------------------------------------------
// Padrões de texto por PDM
// ------------------------------------------------------------------------------------------------

Deno.test("api-catmat: padrões exigem PDM registrado e regex válida", async () => {
  limparCacheMemoria();
  const mem = repoMemoria();
  const semPdm = await handleRequest(post({ action: "palavras_salvar", codigo_pdm: 7115, padrao: "esteira eletrica" }), ctx(mem));
  assertEquals(semPdm.status, 409);

  await handleRequest(post({ action: "catalogo_salvar", nivel: "pdm", codigo_grupo: 78, codigo_classe: 7830, codigo_pdm: 7115, incluido: true }), ctx(mem));
  const invalido = await handleRequest(post({ action: "palavras_salvar", codigo_pdm: 7115, padrao: "(esteira" }), ctx(mem));
  assertEquals(invalido.status, 400);

  const ok = await handleRequest(post({ action: "palavras_salvar", codigo_pdm: 7115, padrao: "esteira eletrica" }), ctx(mem));
  assertEquals(ok.status, 201);
  const { palavra } = await ok.json();
  const lista = await (await handleRequest(post({ action: "palavras_listar", codigo_pdm: 7115 }), ctx(mem, comprasGovFalso(), COMUM))).json();
  assertEquals(lista.palavras.length, 1);

  const outroPdm = await handleRequest(post({ action: "palavras_salvar", id: palavra.id, codigo_pdm: 2638, padrao: "x" }), ctx(mem));
  assertEquals(outroPdm.status, 400);
  assertEquals((await handleRequest(post({ action: "palavras_remover", id: palavra.id }), ctx(mem))).status, 200);
});

// ------------------------------------------------------------------------------------------------
// Unidade: estado de um nó
// ------------------------------------------------------------------------------------------------

Deno.test("estadoDoNo: regra própria vence; senão o ancestral mais próximo", () => {
  const r = (id: number, nivel: string, chave: string, incluido: boolean) => ({ id, nivel, chave, incluido }) as CatmatRegra;
  const idx = indexarRegras([r(1, "grupo", "grupo:78", true), r(2, "pdm", "pdm:2638", false), r(3, "item", "item:602725", true)]);
  const no = (nivel: string, codigo: number, pdm: number | null = null, classe: number | null = 7830) =>
    ({ nivel, codigo, codigo_grupo: 78, codigo_classe: classe, codigo_pdm: pdm }) as never;
  assertEquals(estadoDoNo(no("classe", 7830, null), idx).estado, "herdado");
  assertEquals(estadoDoNo(no("pdm", 2638, 2638), idx).estado, "excluido");
  assertEquals(estadoDoNo(no("item", 111, 2638), idx).estado, "excluido_herdado");
  assertEquals(estadoDoNo(no("item", 602725, 2638), idx).estado, "incluido");
  assertEquals(estadoDoNo(no("item", 222, 7115), idx).origem_nivel, "grupo");
});
