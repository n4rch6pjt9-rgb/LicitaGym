import { assertEquals } from "jsr:@std/assert@1";
import type { Achado } from "../../../supabase/functions/_shared/agentes/tipos.ts";
import { type ApiAgentesContext, contextos, handleRequest } from "../../../supabase/functions/api-agentes/index.ts";
import {
  type AgentesRepo,
  createSupabaseRepo,
  type Dossie,
  ErroAgentes,
  type Execucao,
  type Preparacao,
} from "../../../supabase/functions/api-agentes/repo.ts";
import { ErroTenantAcesso } from "../../../supabase/functions/_shared/tenant.ts";
import type { PropostaItem } from "../../../supabase/functions/_shared/agentes/preco.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";

function ambiente() {
  let seq = 0;
  const execucoes: Execucao[] = [];
  const dossie: Dossie = {
    licitacao: { id: 101, payload_hash: "h1", data_abertura: "2026-10-21T09:00:00-03:00" },
    documentos_sha256: ["d1"],
    chunks: [{ id: 1, documento_id: 9, pagina: 1, texto: "Apresentar amostra do equipamento." }],
    natureza: null,
    itens: [{ numero_item: 1, unidade: "UN", estimado_centavos: 1_000_000, amostras: [], piso_centavos: 600_000 }],
    dispositivos: [
      { norma: "LEI_14133_2021", artigo: 59, texto: "texto 59", conferido_oficial: false },
      { norma: "LEI_14133_2021", artigo: 164, texto: "texto 164", conferido_oficial: false },
    ],
  };

  const estado: { preparacao: Preparacao | null | Error; solicitacoes: number; falhaSolicitar: Error | null } = {
    preparacao: null,
    solicitacoes: 0,
    falhaSolicitar: null,
  };
  const repo: AgentesRepo = {
    tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel: null }),
    preparacao: () => (estado.preparacao instanceof Error ? Promise.reject(estado.preparacao) : Promise.resolve(estado.preparacao)),
    // Como a RPC fila_preparacao_solicitar: pedido aberto não duplica; sem pedido ou failed, cria um pending.
    solicitarPreparacao: () => {
      if (estado.falhaSolicitar) return Promise.reject(estado.falhaSolicitar);
      estado.solicitacoes++;
      const atual = estado.preparacao instanceof Error ? null : estado.preparacao;
      if (atual && (atual.status === "pending" || atual.status === "processing")) return Promise.resolve("ja_na_fila" as const);
      estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "agora" };
      return Promise.resolve("enfileirado" as const);
    },
    carregarDossie: (_t, id) => Promise.resolve(id === dossie.licitacao.id ? dossie : null),
    buscarExecucao: (_t, licitacaoId, agente, contextoHash) =>
      Promise.resolve(execucoes.find((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.contexto_hash === contextoHash) ?? null),
    gravarExecucao: (_t, userId, licitacaoId, contextoHash, proposta, r) => {
      const row: Execucao = {
        id: ++seq,
        licitacao_id: licitacaoId,
        agente: r.agente,
        situacao: r.situacao,
        contexto_hash: contextoHash,
        regra_versao: r.regra_versao,
        entrada: { proposta },
        achados: r.achados,
        revisao: "aguardando",
        revisao_nota: null,
        revisado_por: null,
        revisado_em: null,
        solicitado_por: userId,
        created_at: new Date(seq * 1000).toISOString(),
      };
      execucoes.push(row);
      return Promise.resolve(row);
    },
    ultimasExecucoes: (_t, licitacaoId) => {
      const ordem = ["edital", "preco", "juridico"] as const;
      return Promise.resolve(ordem.flatMap((agente) => {
        const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente);
        const ultima = lista[lista.length - 1];
        return ultima ? [ultima] : [];
      }));
    },
    obterExecucao: (_t, id) => Promise.resolve(execucoes.find((e) => e.id === id) ?? null),
    ultimaAprovada: (_t, licitacaoId, agente) => {
      const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.revisao === "aprovada");
      return Promise.resolve(lista[lista.length - 1] ?? null);
    },
    revisar: (_t, id, decisao, nota, userId) => {
      const row = execucoes.find((e) => e.id === id);
      if (!row) return Promise.reject(new ErroAgentes("Execução não encontrada.", 404));
      if (row.revisao !== "aguardando") return Promise.resolve(null);
      row.revisao = decisao;
      row.revisao_nota = nota;
      row.revisado_por = userId;
      row.revisado_em = "t";
      return Promise.resolve(row);
    },
  };
  return { repo, dossie, execucoes, estado };
}

const USUARIO = { id: "u-1", app_metadata: {} };

function ctx(repo: AgentesRepo, user: typeof USUARIO | null = USUARIO): ApiAgentesContext {
  return { getRepo: () => repo, getUser: () => Promise.resolve(user) };
}

async function chamar(c: ApiAgentesContext, body: unknown) {
  const res = await handleRequest(new Request("http://x/api-agentes", { method: "POST", body: JSON.stringify(body) }), c);
  return { status: res.status, json: await res.json() };
}

const P: PropostaItem[] = [{ numero_item: 1, preco_unitario_centavos: 400_000 }];

Deno.test("api-agentes: sem sessão 401; GET 405; ação inválida 400; licitação inexistente 404", async () => {
  const { repo } = ambiente();
  assertEquals((await chamar(ctx(repo, null), { action: "analise_obter", licitacao_id: 101 })).status, 401);
  const get = await handleRequest(new Request("http://x", { method: "GET" }), ctx(repo));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  assertEquals((await chamar(ctx(repo), { action: "qualquer" })).status, 400);
  assertEquals((await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 999 })).status, 404);
});

Deno.test("api-agentes: executar roda os três em ordem e o jurídico recebe os sinais", async () => {
  const { repo } = ambiente();
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  assertEquals(r.json.execucoes.map((e: Execucao) => e.agente), ["edital", "preco", "juridico"]);
  // Natureza da contratação desconhecida: sem faixa de exequibilidade, só o aviso; o piso segue.
  assertEquals(r.json.execucoes[1].achados.map((a: Achado) => a.codigo), ["preco.abaixo_do_piso", "preco.natureza_nao_verificada"]);
  assertEquals(r.json.execucoes[2].achados.map((a: Achado) => a.codigo).sort(), [
    "juridico.exigencia_amostra",
    "juridico.prazo_impugnacao",
  ]);
  assertEquals(r.json.execucoes.every((e: Execucao) => e.revisao === "aguardando"), true);
  assertEquals(JSON.stringify(r.json).includes("600000"), false);
});

Deno.test("api-agentes: mesma entrada reaproveita as execuções", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(b.json.execucoes.map((e: Execucao) => e.id), a.json.execucoes.map((e: Execucao) => e.id));
  assertEquals(execucoes.length, 3);
});

Deno.test("api-agentes: proposta nova refaz preço e jurídico, não o edital", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }] });
  assertEquals(b.json.execucoes[0].id, a.json.execucoes[0].id);
  assertEquals(execucoes.length, 5);
});

Deno.test("api-agentes: preço de amostra alterado refaz preço e jurídico", async () => {
  const { repo, dossie, execucoes } = ambiente();
  const c = ctx(repo);
  dossie.itens[0].amostras = [{ id_compra_item: "amostra-1", preco_centavos: 500_000, unidade: "UN" }];
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  dossie.itens[0].amostras[0].preco_centavos = 550_000;
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(b.json.execucoes[0].id, a.json.execucoes[0].id);
  assertEquals(b.json.execucoes[1].id === a.json.execucoes[1].id, false);
  assertEquals(b.json.execucoes[2].id === a.json.execucoes[2].id, false);
  assertEquals(execucoes.length, 5);
});

Deno.test("api-agentes: edital retificado marca desatualizada e bloqueia a revisão", async () => {
  const { repo, dossie } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  dossie.documentos_sha256 = ["d1", "d2"];
  const o = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
  assertEquals(o.json.execucoes.map((e: { desatualizada: boolean }) => e.desatualizada), [true, false, true]);
  const rev = await chamar(c, { action: "analise_revisar", execucao_id: a.json.execucoes[0].id, decisao: "aprovada" });
  assertEquals(rev.status, 409);
});

Deno.test("api-agentes: sem edital indexado, edital é sem_documento e os outros seguem", async () => {
  const { repo, dossie } = ambiente();
  dossie.chunks = [];
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.json.execucoes.map((e: Execucao) => e.situacao), ["sem_documento", "ok", "ok"]);
});

Deno.test("api-agentes: revisão registra quem aprovou; rejeitar exige nota; não revisa duas vezes", async () => {
  const { repo } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const id = a.json.execucoes[1].id;
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "rejeitada" })).status, 400);
  const ok = await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "rejeitada", nota: "Preço errado" });
  assertEquals([ok.json.execucao.revisao, ok.json.execucao.revisado_por, ok.json.execucao.revisao_nota], ["rejeitada", "u-1", "Preço errado"]);
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "aprovada" })).status, 409);
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: 999, decisao: "aprovada" })).status, 404);
});

Deno.test("api-agentes: revisão concorrente que perde a atualização condicional é 409", async () => {
  const { repo } = ambiente();
  const concorrente: AgentesRepo = { ...repo, revisar: () => Promise.resolve(null) };
  const c = ctx(concorrente);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const r = await chamar(c, { action: "analise_revisar", execucao_id: a.json.execucoes[0].id, decisao: "aprovada" });
  assertEquals(r.status, 409);
});

Deno.test("api-agentes: execução nova não apaga a aprovada e aponta para ela", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const aprovada = a.json.execucoes[1].id;
  await chamar(c, { action: "analise_revisar", execucao_id: aprovada, decisao: "aprovada" });
  await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }] });
  const o = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
  assertEquals(o.json.execucoes.map((e: { substitui_aprovada_id: number | null }) => e.substitui_aprovada_id), [null, aprovada, null]);
  assertEquals(execucoes.find((e) => e.id === aprovada)!.revisao, "aprovada");
});

Deno.test("api-agentes: erro de tenant vira 403/409", async () => {
  const { repo } = ambiente();
  for (const status of [403, 409]) {
    const quebrado: AgentesRepo = { ...repo, tenantDoUsuario: () => Promise.reject(new ErroTenantAcesso("x", status)) };
    assertEquals((await chamar(ctx(quebrado), { action: "analise_obter", licitacao_id: 101 })).status, status);
  }
});

/** Cliente falso: eq/in/limit filtram; order e limit ficam registrados por tabela. */
function clienteFalso(tabelas: Record<string, Array<Record<string, unknown>>>) {
  const chamadas: Array<{ tabela: string; metodo: string; args: unknown[] }> = [];
  const client = {
    from(tabela: string) {
      let linhas = [...(tabelas[tabela] ?? [])];
      const reg = (metodo: string, args: unknown[]) => chamadas.push({ tabela, metodo, args });
      const q = {
        select: () => q,
        not: () => q,
        gte: () => q,
        lte: () => q,
        eq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => l[c] === v)), q),
        in: (c: string, vs: unknown[]) => ((linhas = linhas.filter((l) => vs.includes(l[c]))), q),
        order: (...args: unknown[]) => (reg("order", args), q),
        limit: (n: number) => (reg("limit", [n]), (linhas = linhas.slice(0, n)), q),
        maybeSingle: () => Promise.resolve({ data: linhas[0] ?? null, error: null }),
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: linhas, error: null }).then(ok),
      };
      return q;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, chamadas };
}

Deno.test("api-agentes: tenant vem do vínculo do usuário, não da única empresa ativa", async () => {
  const { repo } = ambiente();
  const vistos: number[] = [];
  const comTenant = (tabelas: Record<string, Array<Record<string, unknown>>>): AgentesRepo => ({
    ...repo,
    tenantDoUsuario: createSupabaseRepo(clienteFalso(tabelas).client).tenantDoUsuario,
    carregarDossie: (t, id) => (vistos.push(t), repo.carregarDossie(t, id)),
  });
  const obter = (r: AgentesRepo, user: typeof USUARIO) => chamar(ctx(r, user), { action: "analise_obter", licitacao_id: 101 });

  // Uma empresa ativa só: quem não tem vínculo não cai nela.
  const uma = comTenant({ tenants: [{ id: 1, ativo: true }], tenant_membros: [] });
  assertEquals((await obter(uma, { id: "u-sem-vinculo", app_metadata: {} })).status, 403);
  assertEquals(vistos, []);
  // O desenvolvedor sem vínculo cai na única empresa ativa.
  assertEquals((await obter(uma, { id: "u-dev", app_metadata: { licitagym_role: "admin" } })).status, 200);
  assertEquals(vistos, [1]);

  // Duas empresas ativas: cada membro na sua, sem 409.
  const duas = comTenant({
    tenants: [{ id: 1, ativo: true }, { id: 2, ativo: true }],
    tenant_membros: [
      { tenant_id: 1, user_id: "u-konnen", papel: "admin", ativo: true },
      { tenant_id: 2, user_id: "u-outra", papel: "operacao", ativo: true },
    ],
  });
  vistos.length = 0;
  assertEquals((await obter(duas, { id: "u-outra", app_metadata: {} })).status, 200);
  assertEquals((await obter(duas, { id: "u-konnen", app_metadata: {} })).status, 200);
  assertEquals(vistos, [2, 1]);
  assertEquals((await obter(duas, { id: "u-sem-vinculo", app_metadata: {} })).status, 403);
});

Deno.test("api-agentes: hash do edital muda com os chunks, mesmo com os mesmos documentos", async () => {
  const { dossie } = ambiente();
  const base: Dossie = { ...dossie, chunks: [] };
  const chunk = (pagina: number, texto: string) => [{ id: 1, documento_id: 9, pagina, texto }];
  const vazio = await contextos(base, P);
  const comChunk = await contextos({ ...base, chunks: chunk(1, "Apresentar amostra.") }, P);
  const outroTexto = await contextos({ ...base, chunks: chunk(1, "Apresentar laudo.") }, P);
  const outraPagina = await contextos({ ...base, chunks: chunk(2, "Apresentar amostra.") }, P);
  assertEquals(vazio.edital === comChunk.edital, false);
  assertEquals(vazio.juridico === comChunk.juridico, false);
  assertEquals(comChunk.edital === outroTexto.edital, false);
  assertEquals(comChunk.edital === outraPagina.edital, false);
  assertEquals(vazio.preco, comChunk.preco);
  const mesmos = await contextos({ ...base, chunks: chunk(1, "Apresentar amostra.") }, P);
  assertEquals(mesmos.edital, comChunk.edital);
  assertEquals(mesmos.juridico, comChunk.juridico);
});

Deno.test("api-agentes: sem_documento não fica em cache depois que o indexador grava os chunks", async () => {
  const { repo, dossie } = ambiente();
  const c = ctx(repo);
  dossie.chunks = [];
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(a.json.execucoes[0].situacao, "sem_documento");
  dossie.chunks = [{ id: 1, documento_id: 9, pagina: 1, texto: "Apresentar amostra do equipamento." }];
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(b.json.execucoes[0].situacao, "ok");
});

Deno.test("repo: amostra de preço praticado é estável (mais recentes, desempate por id) e a natureza fica desconhecida", async () => {
  const { client, chamadas } = clienteFalso({
    licitacoes_externas: [{ id: 101 }],
    licitacao_itens: [{ id: 5, licitacao_id: 101, numero_item: 1, unidade_medida: "UN", valor_unitario_estimado: 10, catalogo_codigo_item: 123 }],
    precos_praticados_itens: [{ codigo_item_catalogo: 123, id_compra_item: "a", preco_unitario: 9.5, sigla_unidade_fornecimento: "UN" }],
  });
  const d = await createSupabaseRepo(client).carregarDossie(1, 101);
  assertEquals(d?.natureza, null);
  assertEquals(d?.itens[0].amostras, [{ id_compra_item: "a", preco_centavos: 950, unidade: "UN" }]);
  assertEquals(
    chamadas.filter((x) => x.tabela === "precos_praticados_itens").map((x) => [x.metodo, ...x.args]),
    [
      ["order", "data_resultado", { ascending: false }],
      ["order", "id_compra_item", { ascending: true }],
      ["limit", 200],
    ],
  );
});

Deno.test("validação: proposta", () => {
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 0 }), true);
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 1, proposta: [{ numero_item: 1, preco_unitario_centavos: 10.5 }] }), true);
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 1, proposta: [{ numero_item: 1, preco_unitario_centavos: 0 }] }), true);
  assertEquals("error" in parseActionFromBody({
    action: "analise_executar",
    licitacao_id: 1,
    proposta: [{ numero_item: 1, preco_unitario_centavos: 5 }, { numero_item: 1, preco_unitario_centavos: 6 }],
  }), true);
  assertEquals(parseActionFromBody({ action: "analise_executar", licitacao_id: 1 }), { action: "analise_executar", licitacao_id: 1, proposta: null });
  assertEquals("error" in parseActionFromBody({ action: "analise_revisar", execucao_id: 1, decisao: "talvez" }), true);
});

// Spec 0032, fase 1: "Analisar" com o edital ainda na fila de preparação mostra "em preparação", não "sem documento".
Deno.test("api-agentes (0032 CA-1): sem chunks e preparação pendente, a resposta traz a preparação pendente", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "2026-10-19T16:08:03Z" };
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  assertEquals(r.json.preparacao, { status: "pending", resultado: null, erro: null, atualizado_em: "2026-10-19T16:08:03Z" });
  assertEquals(r.json.em_preparacao, true);
  assertEquals(r.json.execucoes[0].situacao, "sem_documento");
});

Deno.test("api-agentes (0032 CA-1): sem chunks e sem pedido na fila, Analisar pede a preparação e fica em preparação", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 1);
  assertEquals(r.json.preparacao_solicitada, true);
  assertEquals(r.json.preparacao.status, "pending");
  assertEquals(r.json.em_preparacao, true);
  assertEquals(r.json.execucoes[0].situacao, "sem_documento");
});

Deno.test("api-agentes (0032 CA-1): com pedido pendente, Analisar não pede de novo", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 0);
  assertEquals("preparacao_solicitada" in r.json, false);
  assertEquals(r.json.em_preparacao, true);
});

Deno.test("api-agentes (0032 CA-1): com edital indexado, Analisar não pede preparação", async () => {
  const { repo, estado } = ambiente();
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 0);
  assertEquals(r.json.preparacao, null);
  assertEquals(r.json.em_preparacao, false);
});

Deno.test("api-agentes (0032 CA-1): analise_obter nunca pede preparação", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  const r = await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 101 });
  assertEquals(estado.solicitacoes, 0);
  assertEquals(r.json.preparacao, null);
  assertEquals(r.json.em_preparacao, false);
});

Deno.test("api-agentes (0032 CA-1): falha ao pedir a preparação não derruba a análise e vira aviso", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.falhaSolicitar = new Error("rpc fora");
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  assertEquals(r.json.avisos, ["preparacao_nao_solicitada"]);
  assertEquals(r.json.em_preparacao, false);
  assertEquals("preparacao_solicitada" in r.json, false);
  assertEquals(r.json.execucoes.length, 3);
});

Deno.test("api-agentes (0032 CA-1): estado da fila ilegível não pede às cegas", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = new Error("rpc fora");
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 0);
  assertEquals(r.json.avisos, ["preparacao_indisponivel"]);
});

Deno.test("api-agentes (0032): preparação concluída sem documento não é 'em preparação'", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "completed", resultado: "sem_documento", erro: null, atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 0);
  assertEquals(r.json.em_preparacao, false);
  assertEquals(r.json.preparacao.resultado, "sem_documento");
});

Deno.test("api-agentes (0032): com edital indexado, não está em preparação mesmo com pedido antigo na fila", async () => {
  const { repo, estado } = ambiente();
  estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.json.em_preparacao, false);
  assertEquals(r.json.execucoes[0].situacao, "ok");
});

Deno.test("api-agentes (0032): falha ao ler a preparação não derruba a análise", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = new Error("rpc fora");
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  assertEquals("preparacao" in r.json, false);
  assertEquals("em_preparacao" in r.json, false);
  assertEquals(r.json.avisos, ["preparacao_indisponivel"]);
  assertEquals(r.json.execucoes.length, 3);
});

Deno.test("api-agentes (0032): analise_obter também informa a preparação", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "processing", resultado: null, erro: null, atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 101 });
  assertEquals(r.json.em_preparacao, true);
  assertEquals(r.json.preparacao, { status: "processing", resultado: null, erro: null, atualizado_em: "t" });
});

Deno.test("api-agentes (0032): pedido failed sem chunks, analise_obter não está em preparação e devolve o erro", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "failed", resultado: null, erro: "download: HTTP 504", atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 101 });
  assertEquals(r.json.em_preparacao, false);
  assertEquals(r.json.preparacao.erro, "download: HTTP 504");
});

Deno.test("api-agentes (0032 CA-1): pedido failed, Analisar pede de novo", async () => {
  const { repo, dossie, estado } = ambiente();
  dossie.chunks = [];
  estado.preparacao = { status: "failed", resultado: null, erro: "download: HTTP 504", atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(estado.solicitacoes, 1);
  assertEquals(r.json.preparacao_solicitada, true);
  assertEquals(r.json.em_preparacao, true);
  assertEquals(r.json.preparacao.erro, null);
});

Deno.test("api-agentes (0032): analise_obter com chunks e pedido pending não está em preparação", async () => {
  const { repo, estado } = ambiente();
  estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "t" };
  const r = await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 101 });
  assertEquals(r.json.em_preparacao, false);
});

Deno.test("api-agentes (0032): analise_obter com a RPC fora omite a preparação e avisa", async () => {
  const { repo, estado } = ambiente();
  estado.preparacao = new Error("rpc fora");
  const r = await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 101 });
  assertEquals(r.status, 200);
  assertEquals("em_preparacao" in r.json, false);
  assertEquals(r.json.avisos, ["preparacao_indisponivel"]);
});

Deno.test("repo (0032): preparação vem da RPC pipeline_preparacao_estado da empresa", async () => {
  const chamadas: unknown[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      chamadas.push([fn, args]);
      return Promise.resolve({
        data: [{ licitacao_id: 101, status: "pending", resultado: null, erro: null, atualizado_em: "t" }],
        error: null,
      });
    },
  };
  // deno-lint-ignore no-explicit-any
  const p = await createSupabaseRepo(client as any).preparacao(1, 101);
  assertEquals(chamadas, [["pipeline_preparacao_estado", { p_tenant: 1, p_licitacoes: [101] }]]);
  assertEquals(p, { status: "pending", resultado: null, erro: null, atualizado_em: "t" });
});

Deno.test("repo (0032): sem pedido na fila, preparação é null", async () => {
  const client = { rpc: () => Promise.resolve({ data: [], error: null }) };
  // deno-lint-ignore no-explicit-any
  assertEquals(await createSupabaseRepo(client as any).preparacao(1, 101), null);
});

Deno.test("repo (0032 CA-1): solicitar preparação chama fila_preparacao_solicitar da empresa", async () => {
  const chamadas: unknown[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      chamadas.push([fn, args]);
      return Promise.resolve({ data: "enfileirado", error: null });
    },
  };
  // deno-lint-ignore no-explicit-any
  assertEquals(await createSupabaseRepo(client as any).solicitarPreparacao(1, 101), "enfileirado");
  assertEquals(chamadas, [["fila_preparacao_solicitar", { p_tenant: 1, p_licitacao: 101 }]]);
});

Deno.test("repo (0032 CA-1): resposta inesperada da RPC de solicitar vira erro", async () => {
  const client = { rpc: () => Promise.resolve({ data: "talvez", error: null }) };
  let erro = "";
  try {
    // deno-lint-ignore no-explicit-any
    await createSupabaseRepo(client as any).solicitarPreparacao(1, 101);
  } catch (e) {
    erro = (e as Error).message;
  }
  assertEquals(erro, "fila_preparacao_solicitar devolveu talvez");
});

Deno.test("api-agentes (0032 CA-4): edital com potência só de pico em perfil profissional roda e grava os achados", async () => {
  const { repo, dossie } = ambiente();
  dossie.chunks = [{
    id: 7,
    documento_id: 9,
    pagina: 12,
    texto: "ESTEIRA PROFISSIONAL: MOTOR DE CORRENTE ALTERNADA (AC) COM POTENCIA MINIMA DE 3.0 HP PEAK POWER. CAPACIDADE DE PESO DO USUARIO: NO MINIMO 180 KG",
  }];
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  const edital = r.json.execucoes.find((e: Execucao) => e.agente === "edital");
  assertEquals(edital.achados.some((a: Achado) => a.codigo === "especificacao.inconsistente"), true);
  const juridico = r.json.execucoes.find((e: Execucao) => e.agente === "juridico");
  assertEquals(
    juridico.achados.some((a: Achado) => a.dados.sinal_origem === "especificacao.inconsistente" && a.dados.peca_a_avaliar === "pedido_esclarecimento"),
    true,
  );
});
