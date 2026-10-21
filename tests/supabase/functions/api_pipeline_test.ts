import { assertEquals } from "jsr:@std/assert@1";
import { type ApiPipelineContext, handleRequest } from "../../../supabase/functions/api-pipeline/index.ts";
import { createSupabaseRepo, ErroPipeline, type PipelineRepo } from "../../../supabase/functions/api-pipeline/repo.ts";
import {
  ErroTenantAcesso,
  lerTenantDoUsuario,
  resolverTenantDoUsuario,
} from "../../../supabase/functions/_shared/tenant.ts";
import type { Etapa, EventoHistorico, ItemModelo, ModeloTarefa } from "../../../supabase/functions/api-pipeline/types.ts";
import { MAX_LOTE, parseActionFromBody } from "../../../supabase/functions/api-pipeline/validation.ts";

// Repositório em memória com as mesmas regras de pipeline_mover / pipeline_etapa_excluir
function repoMemoria() {
  let seqEtapa = 0;
  let seqHist = 0;
  const etapas: Etapa[] = [];
  // updated_at simulado por etapa: a versão (spec 0034, K-6) resume id, ordem e esta revisão, como pipeline_etapas_versao
  let seqRev = 0;
  const revs = new Map<number, number>();
  const tocar = (id: number) => revs.set(id, ++seqRev);
  // resumo curto (como o md5 do banco, cabe no limite de 'versao'): hash djb2 do texto id:ordem:revisão
  const versao = () =>
    [...[...etapas].sort((a, b) => a.id - b.id).map((e) => `${e.id}:${e.ordem}:${revs.get(e.id) ?? 0}`).join(",")]
      .reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16);
  const ops = new Map<number, { etapa_id: number; motivo: string | null }>();
  const hist: EventoHistorico[] = [];
  const nova = (nome: string, ordem: number, extra: Partial<Etapa> = {}) => {
    etapas.push({ id: ++seqEtapa, nome, fase: "prospeccao", ordem, desfecho: null, exige_motivo: false, padrao: true, ...extra });
    tocar(seqEtapa);
  };
  nova("Nova", 10);
  nova("Triagem", 20);
  nova("Descartada", 130, { fase: "conclusao", desfecho: "descartada", exige_motivo: true });
  const licitacoes = new Set([101, 102, 103]);
  // modelo de tarefas por etapa (spec 0018): mesmas regras de pipeline_etapa_tarefas_salvar
  let seqModelo = 0;
  const modelo: ModeloTarefa[] = [];
  const catalogoAtivo = new Set(["14133-F01-T01", "14133-F04-T01"]);
  const salvarModelo = (etapaId: number, itens: ItemModelo[]) => {
    if (!etapas.some((e) => e.id === etapaId)) throw new ErroPipeline("Etapa não encontrada.", 404);
    for (const it of itens) {
      if (it.origem === "catalogo" && !catalogoAtivo.has(it.tarefa_codigo)) {
        throw new ErroPipeline(`Tarefa ${it.tarefa_codigo} não existe ou não está ativa no catálogo.`, 400);
      }
    }
    const vistos = new Set<number>();
    itens.forEach((it, i) => {
      const atual = modelo.find((m) => m.etapa_id === etapaId &&
        (it.origem === "catalogo" ? m.tarefa_codigo === it.tarefa_codigo : m.chave !== null && m.chave === it.chave));
      if (atual) {
        Object.assign(atual, { ativo: true, ordem: (i + 1) * 10 }, it.origem === "empresa" ? { titulo: it.titulo } : {});
        vistos.add(atual.id);
      } else {
        const novo: ModeloTarefa = {
          id: ++seqModelo, etapa_id: etapaId, origem: it.origem, tarefa_codigo: it.origem === "catalogo" ? it.tarefa_codigo : null,
          chave: it.origem === "empresa" ? (it.chave ?? `emp-${seqModelo.toString(16).padStart(8, "0")}`) : null,
          titulo: it.origem === "empresa" ? it.titulo : null, descricao: null, prazo_horas: it.origem === "empresa" ? it.prazo_horas : null,
          ordem: (i + 1) * 10, ativo: true, catalogo: null,
        };
        modelo.push(novo);
        vistos.add(novo.id);
      }
    });
    for (const m of modelo) if (m.etapa_id === etapaId && !vistos.has(m.id)) m.ativo = false;
    return itens.length;
  };

  const mover = (ids: number[], etapaId: number | null, motivo: string | null, user: string, soNovos = false) => {
    const destino = etapaId === null ? null : etapas.find((e) => e.id === etapaId);
    if (etapaId !== null && !destino) throw new ErroPipeline(`etapa ${etapaId} não existe`, 404);
    if (destino?.exige_motivo && !motivo) throw new ErroPipeline(`a etapa "${destino.nome}" exige motivo`, 400);
    let n = 0;
    for (const id of ids) {
      if (!licitacoes.has(id)) continue;
      const atual = ops.get(id);
      if (soNovos && atual) continue;
      if (etapaId === null ? !atual : atual?.etapa_id === etapaId) continue;
      if (etapaId === null) ops.delete(id);
      else ops.set(id, { etapa_id: etapaId, motivo: destino?.exige_motivo ? motivo : null });
      hist.push({
        id: ++seqHist, licitacao_id: id, etapa_de: atual?.etapa_id ?? null, etapa_para: etapaId,
        nome_de: etapas.find((e) => e.id === atual?.etapa_id)?.nome ?? null, nome_para: destino?.nome ?? null,
        motivo, user_id: user, em: new Date(seqHist * 1000).toISOString(),
      });
      n++;
    }
    return n;
  };

  const listar = () => ({
    etapas: [...etapas].sort((a, b) => a.ordem - b.ordem || a.id - b.id).map((e) => ({ ...e, total: [...ops.values()].filter((o) => o.etapa_id === e.id).length })),
    versao: versao(),
  });

  const repo: PipelineRepo = {
    tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel: null }),
    listarEtapas: () => Promise.resolve(listar()),
    // mesmas regras de pipeline_etapas_reordenar: versão primeiro (409), depois a lista (400); nada muda em erro
    reordenarEtapas: (_t, ids, versaoLida, _u) =>
      Promise.resolve().then(() => {
        if (versaoLida !== versao()) throw new ErroPipeline("A ordem das etapas mudou desde a leitura. Recarregue a lista.", 409, "versao_desatualizada");
        const atuais = new Set(etapas.map((e) => e.id));
        if (new Set(ids).size !== ids.length || ids.length !== atuais.size || ids.some((id) => !atuais.has(id))) {
          throw new ErroPipeline("A lista deve trazer todas as etapas da empresa, uma vez cada.", 400, "lista_invalida");
        }
        ids.forEach((id, i) => {
          const e = etapas.find((x) => x.id === id)!;
          if (e.ordem !== (i + 1) * 10) {
            e.ordem = (i + 1) * 10;
            tocar(id);
          }
        });
        return listar();
      }),
    listarPipeline: (_t, etapaId) =>
      Promise.resolve({
        truncado: false,
        avisos: [],
        itens: [...ops.entries()].filter(([, o]) => !etapaId || o.etapa_id === etapaId).map(([id, o]) => ({
          licitacao_id: id, etapa_id: o.etapa_id, motivo: o.motivo, atualizada_em: "t", atualizada_por: "u", licitacao: { id },
        })),
      }),
    estado: (_t, ids) => Promise.resolve(ids.filter((id) => ops.has(id)).map((id) => ({ licitacao_id: id, etapa_id: ops.get(id)!.etapa_id }))),
    mover: (_t, ids, etapaId, motivo, user, soNovos) => Promise.resolve().then(() => mover(ids, etapaId, motivo, user, soNovos)),
    historico: (_t, id) => Promise.resolve(hist.filter((h) => h.licitacao_id === id).reverse()),
    criarEtapa: (_t, e) => {
      if (etapas.some((x) => x.nome === e.nome)) return Promise.reject(new ErroPipeline("Já existe uma etapa com esse nome.", 409));
      const etapa: Etapa = { id: ++seqEtapa, nome: e.nome, fase: e.fase, ordem: Math.max(0, ...etapas.map((x) => x.ordem)) + 10, desfecho: e.desfecho, exige_motivo: e.exige_motivo, padrao: false };
      etapas.push(etapa);
      tocar(etapa.id);
      return Promise.resolve(etapa);
    },
    atualizarEtapa: (_t, id, campos) => {
      const e = etapas.find((x) => x.id === id);
      if (!e) return Promise.resolve(null);
      Object.assign(e, campos);
      tocar(id);
      return Promise.resolve(e);
    },
    excluirEtapa: (_t, id, moverPara, user) =>
      Promise.resolve().then(() => {
        if (!etapas.some((e) => e.id === id)) throw new ErroPipeline("etapa não existe", 404);
        if (etapas.length <= 1) throw new ErroPipeline("o pipeline precisa de pelo menos uma etapa", 400);
        const ids = [...ops.entries()].filter(([, o]) => o.etapa_id === id).map(([lid]) => lid);
        let n = 0;
        if (ids.length) {
          if (!moverPara || moverPara === id) throw new ErroPipeline(`a etapa tem ${ids.length} oportunidade(s); informe para qual etapa movê-las`, 400);
          n = mover(ids, moverPara, "Etapa excluída", user);
        }
        etapas.splice(etapas.findIndex((e) => e.id === id), 1);
        return n;
      }),
    listarModelo: (_t, etapaId) =>
      Promise.resolve(etapas.some((e) => e.id === etapaId) ? modelo.filter((m) => m.etapa_id === etapaId) : null),
    salvarModelo: (_t, etapaId, itens) => Promise.resolve().then(() => salvarModelo(etapaId, itens)),
    reaplicarTarefas: (_t, licitacaoId) =>
      Promise.resolve(ops.has(licitacaoId) ? { criadas: 2, existentes: 1, bloqueio: null } : { criadas: 0, existentes: 0, bloqueio: "fora_do_pipeline" }),
    listarCatalogo: () =>
      Promise.resolve([{
        codigo: "14133-F01-T01", fase_codigo: "F01", fase_nome: "Edital publicado", fase_ordem: 1, parent_codigo: null, ordem: 10,
        titulo: "Registrar edital e anexos", natureza: "acompanhamento", ator: "licitante", prazo_unidade: "sem_prazo_legal",
        base_legal: "art. 54 (caput)",
      }]),
  };
  return { repo, ops, hist, etapas, modelo };
}

const USUARIO = { id: "u-1", app_metadata: {} };
const ADMIN = { id: "u-admin", app_metadata: { licitagym_role: "admin" } };

function ctx(repo: PipelineRepo, user: typeof USUARIO | null = USUARIO): ApiPipelineContext {
  return { getRepo: () => repo, getUser: () => Promise.resolve(user) };
}

async function chamar(c: ApiPipelineContext, body: unknown) {
  const res = await handleRequest(new Request("http://x/api-pipeline", { method: "POST", body: JSON.stringify(body) }), c);
  return { status: res.status, json: await res.json() };
}

Deno.test("api-pipeline: sem sessão 401; GET 405; ação inválida 400", async () => {
  const { repo } = repoMemoria();
  assertEquals((await chamar(ctx(repo, null), { action: "etapas_listar" })).status, 401);
  const get = await handleRequest(new Request("http://x", { method: "GET" }), ctx(repo));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  assertEquals((await chamar(ctx(repo), { action: "qualquer" })).status, 400);
});

Deno.test("api-pipeline: adicionar entra na primeira etapa e não muda quem já está", async () => {
  const { repo, ops } = repoMemoria();
  const c = ctx(repo);
  const r1 = await chamar(c, { action: "pipeline_adicionar", licitacao_ids: [101, 102] });
  assertEquals(r1.status, 200);
  assertEquals(r1.json.adicionadas, 2);
  assertEquals(r1.json.etapa.nome, "Nova");
  await chamar(c, { action: "pipeline_mover", licitacao_ids: [101], etapa_id: 2 });
  const r2 = await chamar(c, { action: "pipeline_adicionar", licitacao_ids: [101, 103] });
  assertEquals(r2.json.adicionadas, 1);
  assertEquals(r2.json.ja_no_pipeline, 1);
  assertEquals(ops.get(101)?.etapa_id, 2); // continua em Triagem
});

Deno.test("api-pipeline: mover direto para qualquer etapa; Descartada exige motivo", async () => {
  const { repo, ops, hist } = repoMemoria();
  const c = ctx(repo);
  await chamar(c, { action: "pipeline_adicionar", licitacao_ids: [101] });
  const sem = await chamar(c, { action: "pipeline_mover", licitacao_ids: [101], etapa_id: 3 });
  assertEquals(sem.status, 400);
  assertEquals(sem.json.error, 'a etapa "Descartada" exige motivo');
  const com = await chamar(c, { action: "pipeline_mover", licitacao_ids: [101], etapa_id: 3, motivo: "Preço" });
  assertEquals(com.json.movidas, 1);
  assertEquals(ops.get(101), { etapa_id: 3, motivo: "Preço" });
  const h = await chamar(c, { action: "pipeline_historico", licitacao_id: 101 });
  assertEquals(h.json.eventos.map((e: EventoHistorico) => e.nome_para), ["Descartada", "Nova"]);
  assertEquals(hist.length, 2);
});

Deno.test("api-pipeline: remover em lote e estado", async () => {
  const { repo } = repoMemoria();
  const c = ctx(repo);
  await chamar(c, { action: "pipeline_adicionar", licitacao_ids: [101, 102, 103] });
  const est = await chamar(c, { action: "pipeline_estado", licitacao_ids: [101, 999] });
  assertEquals(est.json.estado, [{ licitacao_id: 101, etapa_id: 1 }]);
  const rem = await chamar(c, { action: "pipeline_remover", licitacao_ids: [101, 102] });
  assertEquals(rem.json.removidas, 2);
  const lista = await chamar(c, { action: "pipeline_listar" });
  assertEquals(lista.json.itens.map((i: { licitacao_id: number }) => i.licitacao_id), [103]);
  assertEquals(lista.json.truncado, false);
});

Deno.test("api-pipeline: configurar etapas só admin; criar, renomear, excluir movendo", async () => {
  const { repo, ops } = repoMemoria();
  const negado = await chamar(ctx(repo), { action: "etapa_criar", nome: "Visita técnica", fase: "proposta" });
  assertEquals(negado.status, 403);

  const a = ctx(repo, ADMIN);
  const criada = await chamar(a, { action: "etapa_criar", nome: "  Visita   técnica ", fase: "proposta" });
  assertEquals(criada.status, 201);
  assertEquals(criada.json.etapa.nome, "Visita técnica");
  assertEquals(criada.json.etapa.ordem, 140);
  assertEquals((await chamar(a, { action: "etapa_criar", nome: "Visita técnica", fase: "proposta" })).status, 409);

  const ren = await chamar(a, { action: "etapa_atualizar", id: criada.json.etapa.id, nome: "Visita" });
  assertEquals(ren.json.etapa.nome, "Visita");

  await chamar(a, { action: "pipeline_adicionar", licitacao_ids: [101] });
  const sem = await chamar(a, { action: "etapa_excluir", id: 1 });
  assertEquals(sem.status, 400);
  const exc = await chamar(a, { action: "etapa_excluir", id: 1, mover_para: 2 });
  assertEquals(exc.json, { action: "etapa_excluir", excluida: 1, movidas: 1 });
  assertEquals(ops.get(101)?.etapa_id, 2);
  const etapas = await chamar(a, { action: "etapas_listar" });
  assertEquals(etapas.json.etapas.map((e: { nome: string }) => e.nome), ["Triagem", "Descartada", "Visita"]);
});

Deno.test("api-pipeline: admin da empresa configura etapas sem ser desenvolvedor; operação não", async () => {
  const { repo } = repoMemoria();
  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "admin" });
  assertEquals((await chamar(ctx(repo), { action: "etapa_criar", nome: "Visita", fase: "proposta" })).status, 201);

  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "operacao" });
  const negado = await chamar(ctx(repo), { action: "etapa_excluir", id: 1, mover_para: 2 });
  assertEquals(negado.status, 403);
  // operação movimenta o pipeline normalmente
  assertEquals((await chamar(ctx(repo), { action: "pipeline_adicionar", licitacao_ids: [101] })).status, 200);
});

Deno.test("api-pipeline: vínculo só com empresa desativada responde 403 (#263), sem cair em outra empresa", async () => {
  const { repo } = repoMemoria();
  repo.tenantDoUsuario = () => Promise.reject(new ErroTenantAcesso("A empresa do usuário está desativada.", 403));
  const r = await chamar(ctx(repo), { action: "etapas_listar" });
  assertEquals(r.status, 403);
  assertEquals(r.json.error, "A empresa do usuário está desativada.");
});

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    return e instanceof ErroTenantAcesso ? e.status : -1;
  }
  return 0;
}

const v = (tenant_id: number, papel: "admin" | "operacao", ativo: boolean, empresa_ativa: boolean) =>
  ({ tenant_id, papel, ativo, empresa_ativa });

Deno.test("resolverTenantDoUsuario: vínculo ativo com empresa ativa manda, com o papel", () => {
  assertEquals(resolverTenantDoUsuario([v(7, "operacao", true, true)], [1, 7], false), { tenant: 7, papel: "operacao" });
  assertEquals(resolverTenantDoUsuario([v(7, "admin", true, true), v(8, "admin", true, false)], [1, 7], false), { tenant: 7, papel: "admin" });
  assertEquals(status(() => resolverTenantDoUsuario([v(7, "admin", true, true), v(8, "operacao", true, true)], [7, 8], false)), 409);
});

Deno.test("resolverTenantDoUsuario: empresa desativada não cai na única empresa ativa (#263)", () => {
  assertEquals(status(() => resolverTenantDoUsuario([v(8, "admin", true, false)], [1], false)), 403);
  assertEquals(status(() => resolverTenantDoUsuario([v(8, "admin", true, false)], [1], true)), 403);
});

Deno.test("resolverTenantDoUsuario: vínculo desligado revoga o acesso, mesmo com uma só empresa", () => {
  assertEquals(status(() => resolverTenantDoUsuario([v(1, "operacao", false, true)], [1], false)), 403);
});

Deno.test("resolverTenantDoUsuario: sem vínculo, só o desenvolvedor cai na única empresa ativa", () => {
  assertEquals(status(() => resolverTenantDoUsuario([], [1], false)), 403);
  assertEquals(resolverTenantDoUsuario([], [1], true), { tenant: 1, papel: null });
  assertEquals(status(() => resolverTenantDoUsuario([], [1, 2], true)), 409);
  assertEquals(status(() => resolverTenantDoUsuario([], [], true)), 409);
});

/** Cliente falso só com o que lerTenantDoUsuario usa (from/select/eq/in/order/limit). */
function clienteFalso(tabelas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(tabela: string) {
      let linhas = [...(tabelas[tabela] ?? [])];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((linhas = linhas.filter((l) => l[c] === v)), q),
        in: (c: string, vs: unknown[]) => ((linhas = linhas.filter((l) => vs.includes(l[c]))), q),
        order: () => q,
        limit: (n: number) => ((linhas = linhas.slice(0, n)), q),
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: linhas, error: null }).then(ok),
      };
      return q;
    },
  };
}

Deno.test("lerTenantDoUsuario: duas empresas ativas e dois usuários, cada um na sua", async () => {
  const tabelas = {
    tenants: [{ id: 1, ativo: true }, { id: 2, ativo: true }, { id: 3, ativo: false }],
    tenant_membros: [
      { tenant_id: 1, user_id: "u-konnen", papel: "admin", ativo: true },
      { tenant_id: 2, user_id: "u-teste", papel: "operacao", ativo: true },
      { tenant_id: 3, user_id: "u-inativa", papel: "admin", ativo: true },
      { tenant_id: 1, user_id: "u-desligado", papel: "operacao", ativo: false },
    ],
  };
  // deno-lint-ignore no-explicit-any
  const c = clienteFalso(tabelas) as any;
  assertEquals(await lerTenantDoUsuario(c, "u-konnen", false), { tenant: 1, papel: "admin" });
  assertEquals(await lerTenantDoUsuario(c, "u-teste", false), { tenant: 2, papel: "operacao" });
  for (const [u, esperado] of [["u-inativa", 403], ["u-desligado", 403], ["u-sem-vinculo", 403]] as const) {
    let st = 0;
    try {
      await lerTenantDoUsuario(c, u, false);
    } catch (e) {
      st = e instanceof ErroTenantAcesso ? e.status : -1;
    }
    assertEquals(st, esperado, u);
  }
});

Deno.test("validação: limites e tipos", () => {
  const muitos = Array.from({ length: MAX_LOTE + 1 }, (_, i) => i + 1);
  assertEquals("error" in parseActionFromBody({ action: "pipeline_adicionar", licitacao_ids: muitos }), true);
  assertEquals("error" in parseActionFromBody({ action: "pipeline_adicionar", licitacao_ids: [1, -2] }), true);
  assertEquals(parseActionFromBody({ action: "pipeline_adicionar", licitacao_ids: [3, "3", 4] }), { action: "pipeline_adicionar", licitacao_ids: [3, 4] });
  assertEquals("error" in parseActionFromBody({ action: "pipeline_mover", licitacao_ids: [1] }), true);
  assertEquals("error" in parseActionFromBody({ action: "etapa_criar", nome: "x".repeat(61), fase: "proposta" }), true);
  assertEquals("error" in parseActionFromBody({ action: "etapa_criar", nome: "X", fase: "outra" }), true);
  assertEquals("error" in parseActionFromBody({ action: "etapa_atualizar", id: 1 }), true);
  assertEquals(parseActionFromBody({ action: "etapa_atualizar", id: 1, desfecho: null }), { action: "etapa_atualizar", id: 1, desfecho: null });
});

// --- Tarefas por etapa (spec 0018, PR 3) -------------------------------------------------------------------------

Deno.test("CA-9: operação lê o modelo mas não salva (403); admin da empresa salva", async () => {
  const { repo, modelo } = repoMemoria();
  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "operacao" });
  const lista = await chamar(ctx(repo), { action: "etapa_tarefas_listar", etapa_id: 2 });
  assertEquals(lista.status, 200);
  const negado = await chamar(ctx(repo), { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas: [{ origem: "catalogo", tarefa_codigo: "14133-F01-T01" }] });
  assertEquals(negado.status, 403);
  assertEquals(modelo.length, 0);
  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "admin" });
  const ok = await chamar(ctx(repo), {
    action: "etapa_tarefas_salvar", etapa_id: 2,
    tarefas: [{ origem: "catalogo", tarefa_codigo: "14133-F01-T01" }, { origem: "empresa", titulo: "Pedir cotação", prazo_horas: 48 }],
  });
  assertEquals(ok.status, 200);
  assertEquals(ok.json.salvas, 2);
  assertEquals(ok.json.tarefas.length, 2);
});

Deno.test("CA-10: tarefa_codigo inexistente/inativo, origem ou prazo inválidos → 400 e nada gravado", async () => {
  const { repo, modelo } = repoMemoria();
  const c = ctx(repo, ADMIN);
  const inativo = await chamar(c, { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas: [{ origem: "catalogo", tarefa_codigo: "14133-F99-T99" }] });
  assertEquals(inativo.status, 400);
  assertEquals(modelo.length, 0);
  for (const tarefas of [
    [{ origem: "catalogo", tarefa_codigo: "F04-T01" }],
    [{ origem: "outro" }],
    [{ origem: "empresa", titulo: "" }],
    [{ origem: "empresa", titulo: "x", prazo_horas: "48" }],
    [{ origem: "empresa", titulo: "x", chave: "Com Espaço" }],
    "nao-e-lista",
  ]) {
    assertEquals((await chamar(c, { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas })).status, 400, JSON.stringify(tarefas));
  }
  assertEquals(modelo.length, 0);
});

Deno.test("etapa_tarefas_salvar: lista completa — renomear mantém o modelo, o que sai é desligado (nunca apagado)", async () => {
  const { repo, modelo } = repoMemoria();
  const c = ctx(repo, ADMIN);
  await chamar(c, { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas: [{ origem: "empresa", titulo: "A" }, { origem: "empresa", titulo: "B" }] });
  const [a, b] = modelo;
  await chamar(c, { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas: [{ origem: "empresa", chave: a.chave, titulo: "A renomeada" }] });
  assertEquals(modelo.length, 2);
  assertEquals([a.titulo, a.ativo, b.ativo], ["A renomeada", true, false]);
  const etapaInexistente = await chamar(c, { action: "etapa_tarefas_listar", etapa_id: 999 });
  assertEquals(etapaInexistente.status, 404);
});

Deno.test("tarefas_reaplicar: no pipeline devolve criadas/existentes; fora do pipeline 404", async () => {
  const { repo } = repoMemoria();
  const c = ctx(repo);
  await chamar(c, { action: "pipeline_adicionar", licitacao_ids: [101] });
  const r = await chamar(c, { action: "tarefas_reaplicar", licitacao_id: 101 });
  assertEquals([r.status, r.json.criadas, r.json.existentes, r.json.bloqueio], [200, 2, 1, null]);
  const fora = await chamar(c, { action: "tarefas_reaplicar", licitacao_id: 102 });
  assertEquals([fora.status, fora.json.bloqueio], [404, "fora_do_pipeline"]);
});

Deno.test("repo real: erro do banco em salvar/reaplicar vira 400 (22023) e 404 (P0002), não 500", async () => {
  const rpcCom = (code: string) => ({
    rpc: () => Promise.resolve({ data: null, error: { code, message: `motivo ${code}` } }),
  }) as unknown as Parameters<typeof createSupabaseRepo>[0];
  for (const [code, status] of [["22023", 400], ["P0002", 404], ["23514", 400]] as const) {
    const repo = createSupabaseRepo(rpcCom(code));
    for (const chamada of [
      () => repo.salvarModelo(1, 2, [{ origem: "catalogo", tarefa_codigo: "14133-F01-T01" }], "u"),
      () => repo.reaplicarTarefas(1, 101, "u"),
    ]) {
      const e = await chamada().then(() => null, (x) => x);
      assertEquals(e instanceof ErroPipeline ? e.status : e, status, `${code}`);
    }
  }
  // pela handleRequest, o status chega ao cliente
  const repo = createSupabaseRepo(rpcCom("22023"));
  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "admin" });
  const r = await chamar(ctx(repo), { action: "etapa_tarefas_salvar", etapa_id: 2, tarefas: [] });
  assertEquals([r.status, r.json.error], [400, "motivo 22023"]);
});

// Cliente falso mínimo do supabase-js para listarPipeline: consulta encadeável que resolve com `resultado`.
type RespostaRpc = () => Promise<{ data: unknown; error: unknown }>;
function clienteListar(rpcEstado: RespostaRpc, rpcAbertas?: RespostaRpc) {
  const consulta = (resultado: { data: unknown; error: unknown }) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, falha);
    return q;
  };
  const linhas = [101, 102].map((id) => ({ licitacao_id: id, etapa_id: 2, motivo: null, atualizada_em: "2026-10-11T12:00:00Z", atualizada_por: null, licitacao: { id } }));
  return {
    from: () => consulta({ data: linhas, error: null }),
    schema: () => ({ from: () => consulta({ data: [], error: null }) }),
    rpc: (nome: string) =>
      nome === "pipeline_preparacao_estado"
        ? rpcEstado()
        : nome === "pipeline_tarefas_abertas" && rpcAbertas
        ? rpcAbertas()
        : Promise.resolve({ data: [], error: null }),
  } as unknown as Parameters<typeof createSupabaseRepo>[0];
}

Deno.test("CA-17: pipeline_listar traz preparacao do último pedido; sem pedido fica null", async () => {
  const repo = createSupabaseRepo(clienteListar(() => Promise.resolve({
    data: [{ licitacao_id: 101, status: "processing", resultado: null, erro: null, atualizado_em: "2026-10-11T12:05:00Z" }],
    error: null,
  })));
  const { itens, avisos } = await repo.listarPipeline(1, null);
  assertEquals(itens.map((i) => [i.licitacao_id, i.preparacao?.status ?? null]), [[101, "processing"], [102, null]]);
  assertEquals(avisos, []);
});

Deno.test("CA-17: erro ao ler a preparação não derruba o Kanban nem vira 'sem pedido': campo ausente + aviso", async () => {
  const repo = createSupabaseRepo(clienteListar(() => Promise.resolve({ data: null, error: { code: "PGRST202", message: "função não existe" } })));
  const r = await repo.listarPipeline(1, null);
  assertEquals(r.avisos, ["preparacao_indisponivel"]);
  assertEquals(r.itens.map((i) => "preparacao" in i), [false, false]);
});

Deno.test("spec 0018 seção 5: pipeline_listar traz tarefas_abertas por card (0 quando não há)", async () => {
  const repo = createSupabaseRepo(clienteListar(
    () => Promise.resolve({ data: [], error: null }),
    () => Promise.resolve({ data: [{ licitacao_id: 102, abertas: 3 }], error: null }),
  ));
  const { itens } = await repo.listarPipeline(1, null);
  assertEquals(itens.map((i) => [i.licitacao_id, i.tarefas_abertas]), [[101, 0], [102, 3]]);
});

Deno.test("spec 0018 seção 5: erro ao contar tarefas não vira 0 nem derruba o Kanban: campo ausente + aviso", async () => {
  const repo = createSupabaseRepo(clienteListar(
    () => Promise.resolve({ data: [], error: null }),
    () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "sem contagem" } }),
  ));
  const r = await repo.listarPipeline(1, null);
  assertEquals(r.avisos, ["tarefas_abertas_indisponivel"]);
  assertEquals(r.itens.map((i) => "tarefas_abertas" in i), [false, false]);
});

Deno.test("catalogo_listar: qualquer usuário da empresa lê o catálogo para o modelo da etapa", async () => {
  const { repo } = repoMemoria();
  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "operacao" });
  const r = await chamar(ctx(repo), { action: "catalogo_listar" });
  assertEquals([r.status, r.json.tarefas[0].codigo, r.json.tarefas[0].base_legal], [200, "14133-F01-T01", "art. 54 (caput)"]);
});

// Cliente falso de uma consulta só (tarefas_catalogo com fase e base embutidas), registrando os filtros.
function clienteCatalogo(resultado: { data: unknown; error: unknown }, filtros: string[] = []) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.order = () => q;
  q.eq = (c: string, v: unknown) => (filtros.push(`${c}=${v}`), q);
  q.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, falha);
  return { from: () => q } as unknown as Parameters<typeof createSupabaseRepo>[0];
}

Deno.test("catalogo_listar (repo real): base legal ordenada e unida como no banco; sem base = null; fase do embed", async () => {
  const filtros: string[] = [];
  const repo = createSupabaseRepo(clienteCatalogo({
    data: [
      {
        codigo: "14133-F01-T01", fase_codigo: "F01", parent_codigo: null, ordem: 10, titulo: "Registrar edital", natureza: "acompanhamento",
        ator: "licitante", prazo_unidade: "sem_prazo_legal", fase: { nome: "Edital publicado", ordem: 1 },
        base: [{ artigo: 54, dispositivo: "§ 1º" }, { artigo: 54, dispositivo: "caput" }],
      },
      {
        codigo: "14133-FX-T01", fase_codigo: "FX", parent_codigo: "14133-F01-T01", ordem: 5, titulo: "Transversal", natureza: "obrigacao",
        ator: "licitante", prazo_unidade: "imediato", fase: { nome: "Trilha", ordem: null }, base: [],
      },
    ],
    error: null,
  }, filtros));
  const cat = await repo.listarCatalogo();
  assertEquals(cat.map((c) => [c.codigo, c.base_legal, c.fase_nome, c.fase_ordem, c.parent_codigo]), [
    // produção (en_US.UTF-8, 11/10): string_agg dá "art. 54 (§ 1º); art. 54 (caput)" para 14133-F01-T01
    ["14133-F01-T01", "art. 54 (§ 1º); art. 54 (caput)", "Edital publicado", 1, null],
    ["14133-FX-T01", null, "Trilha", null, "14133-F01-T01"],
  ]);
  assertEquals(filtros, ["ativo=true", "norma=LEI_14133_2021"]);
});

Deno.test("catalogo_listar (repo real): erro do banco rejeita (não vira catálogo vazio); lista cheia acusa corte", async () => {
  const e = await createSupabaseRepo(clienteCatalogo({ data: null, error: { message: "sem catálogo" } })).listarCatalogo()
    .then(() => null, (x) => x);
  assertEquals(e instanceof Error ? e.message : e, "sem catálogo");
  const cheia = Array.from({ length: 1000 }, (_, i) => ({ codigo: `c${i}`, fase_codigo: "F01", ordem: i, base: [] }));
  const e2 = await createSupabaseRepo(clienteCatalogo({ data: cheia, error: null })).listarCatalogo().then(() => null, (x) => x);
  assertEquals(e2 instanceof Error, true);
});

// --- Etapas editáveis (spec 0034: K-5 reordenar, K-6 versão, K-7 lock e ordem só por reordenar) -------------------

/** Repositório em memória com as 13 etapas padrão (3 da semente do teste + 10 criadas no fim). */
async function com13Etapas() {
  const r = repoMemoria();
  const a = ctx(r.repo, ADMIN);
  for (let i = 1; i <= 10; i++) assertEquals((await chamar(a, { action: "etapa_criar", nome: `Etapa ${i}`, fase: "proposta" })).status, 201);
  return { ...r, a };
}

const ids = (etapas: Array<{ id: number }>) => etapas.map((e) => e.id);
const ordens = (etapas: Array<{ ordem: number }>) => etapas.map((e) => e.ordem);

Deno.test("CA-3a: admin reordena as 13 etapas com a versão lida; ordem = posição × 10 e versão nova", async () => {
  const { a } = await com13Etapas();
  const lida = await chamar(a, { action: "etapas_listar" });
  assertEquals(lida.json.etapas.length, 13);
  assertEquals(typeof lida.json.versao, "string");
  const nova = ids(lida.json.etapas).reverse();
  const r = await chamar(a, { action: "etapas_reordenar", ids: nova, versao: lida.json.versao });
  assertEquals(r.status, 200);
  assertEquals(ids(r.json.etapas), nova);
  assertEquals(ordens(r.json.etapas), Array.from({ length: 13 }, (_, i) => (i + 1) * 10));
  assertEquals(r.json.versao !== lida.json.versao, true);
  // a versão devolvida é a que a próxima leitura mostra
  assertEquals((await chamar(a, { action: "etapas_listar" })).json.versao, r.json.versao);
});

Deno.test("CA-3b: lista com id repetido, faltando etapa ou com etapa de fora → 400 lista_invalida e nada muda", async () => {
  const { a } = await com13Etapas();
  const lida = await chamar(a, { action: "etapas_listar" });
  const todos = ids(lida.json.etapas);
  for (const lista of [[...todos.slice(0, 12), todos[0]], todos.slice(1), [...todos.slice(0, 12), 999]]) {
    const r = await chamar(a, { action: "etapas_reordenar", ids: lista, versao: lida.json.versao });
    assertEquals([r.status, r.json.codigo], [400, "lista_invalida"], JSON.stringify(lista));
  }
  const depois = await chamar(a, { action: "etapas_listar" });
  assertEquals([ids(depois.json.etapas), depois.json.versao], [todos, lida.json.versao]);
});

Deno.test("CA-3c: versão antiga depois de outra reordenação → 409 versao_desatualizada; operação → 403", async () => {
  const { a, repo } = await com13Etapas();
  const lida = await chamar(a, { action: "etapas_listar" });
  const todos = ids(lida.json.etapas);
  const outro = await chamar(a, { action: "etapas_reordenar", ids: [todos[1], todos[0], ...todos.slice(2)], versao: lida.json.versao });
  assertEquals(outro.status, 200);
  const atrasado = await chamar(a, { action: "etapas_reordenar", ids: [...todos].reverse(), versao: lida.json.versao });
  assertEquals([atrasado.status, atrasado.json.codigo], [409, "versao_desatualizada"]);
  const depois = (await chamar(a, { action: "etapas_listar" })).json;
  assertEquals([ids(depois.etapas), depois.versao], [ids(outro.json.etapas), outro.json.versao]);

  repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel: "operacao" });
  const negado = await chamar(ctx(repo), { action: "etapas_reordenar", ids: todos, versao: outro.json.versao });
  assertEquals(negado.status, 403);
});

Deno.test("CA-3d: etapa criada ou excluída depois da leitura → 409 (não 400), mesmo com a lista incompleta", async () => {
  const { a } = await com13Etapas();
  const lida = await chamar(a, { action: "etapas_listar" });
  const todos = ids(lida.json.etapas);
  await chamar(a, { action: "etapa_criar", nome: "Visita técnica", fase: "proposta" });
  const aposCriar = await chamar(a, { action: "etapas_reordenar", ids: [...todos].reverse(), versao: lida.json.versao });
  assertEquals([aposCriar.status, aposCriar.json.codigo], [409, "versao_desatualizada"]);

  const relida = await chamar(a, { action: "etapas_listar" });
  await chamar(a, { action: "etapa_excluir", id: todos[1] });
  const aposExcluir = await chamar(a, { action: "etapas_reordenar", ids: ids(relida.json.etapas), versao: relida.json.versao });
  assertEquals([aposExcluir.status, aposExcluir.json.codigo], [409, "versao_desatualizada"]);
});

Deno.test("CA-3f: ordem em etapa_criar ou etapa_atualizar → 400 (usar etapas_reordenar) e nada muda; criar vai para o fim", async () => {
  const { repo, etapas } = repoMemoria();
  const a = ctx(repo, ADMIN);
  const criar = await chamar(a, { action: "etapa_criar", nome: "Visita", fase: "proposta", ordem: 5 });
  assertEquals([criar.status, criar.json.error], [400, "Use etapas_reordenar para mudar a ordem."]);
  assertEquals(etapas.length, 3);
  const atualizar = await chamar(a, { action: "etapa_atualizar", id: 2, nome: "Triagem 2", ordem: 5 });
  assertEquals([atualizar.status, atualizar.json.error], [400, "Use etapas_reordenar para mudar a ordem."]);
  assertEquals(etapas.find((e) => e.id === 2)?.nome, "Triagem");
  const fim = await chamar(a, { action: "etapa_criar", nome: "Visita", fase: "proposta" });
  assertEquals([fim.status, fim.json.etapa.ordem], [201, 140]);
});

Deno.test("validação etapas_reordenar: tipos e limite; repetido passa para o banco decidir (400 só com versão certa)", () => {
  assertEquals(parseActionFromBody({ action: "etapas_reordenar", ids: [3, 1, 3], versao: "abc" }), { action: "etapas_reordenar", ids: [3, 1, 3], versao: "abc" });
  for (const corpo of [
    { ids: [1, 2] },
    { ids: [1, 2], versao: "" },
    { ids: [1, 2], versao: 7 },
    { ids: [], versao: "v" },
    { ids: [1, -2], versao: "v" },
    { ids: "1,2", versao: "v" },
    { ids: Array.from({ length: MAX_LOTE + 1 }, (_, i) => i + 1), versao: "v" },
  ]) {
    assertEquals("error" in parseActionFromBody({ action: "etapas_reordenar", ...corpo }), true, JSON.stringify(corpo));
  }
});

/** Cliente falso que registra tabelas lidas por PostgREST e as RPCs chamadas, com resposta por RPC. */
function clienteEtapas(respostas: Record<string, { data: unknown; error: unknown }>, chamadas: string[]) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "insert", "single"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return {
    from: (t: string) => (chamadas.push(`from:${t}`), q),
    rpc: (nome: string, args: unknown) => {
      chamadas.push(`rpc:${nome}:${JSON.stringify(args)}`);
      return Promise.resolve(respostas[nome] ?? { data: null, error: { code: "PGRST202", message: `sem ${nome}` } });
    },
  } as unknown as Parameters<typeof createSupabaseRepo>[0];
}

const LINHA = { id: 1, nome: "Nova", fase: "prospeccao", ordem: 10, desfecho: null, exige_motivo: false, padrao: true, total: 2, versao: "v1" };

Deno.test("CA-3g: etapas_listar (repo real) lê etapas e versão numa RPC só (pipeline_etapas_listar), sem PostgREST", async () => {
  const chamadas: string[] = [];
  const repo = createSupabaseRepo(clienteEtapas({ pipeline_etapas_listar: { data: [LINHA, { ...LINHA, id: 2, nome: "Triagem", ordem: 20, total: 0 }], error: null } }, chamadas));
  const r = await repo.listarEtapas(1);
  assertEquals(r.versao, "v1");
  assertEquals(r.etapas.map((e) => [e.id, e.total, "versao" in e]), [[1, 2, false], [2, 0, false]]);
  assertEquals(chamadas, ['rpc:pipeline_etapas_listar:{"p_tenant":1}']);
  // erro do banco não vira lista vazia
  const e = await createSupabaseRepo(clienteEtapas({ pipeline_etapas_listar: { data: null, error: { code: "XX000", message: "falhou" } } }, []))
    .listarEtapas(1).then(() => null, (x) => x);
  assertEquals(e instanceof Error && !(e instanceof ErroPipeline), true);
});

Deno.test("K-5/K-7 (repo real): reordenar e criar usam as funções com lock; códigos do banco viram 400/409 com o motivo", async () => {
  const chamadas: string[] = [];
  const repo = createSupabaseRepo(clienteEtapas({
    pipeline_etapas_reordenar: { data: [{ ...LINHA, versao: "v2" }], error: null },
    pipeline_etapa_criar: { data: [{ ...LINHA, id: 9, nome: "Visita", ordem: 140, padrao: false }], error: null },
  }, chamadas));
  assertEquals(await repo.reordenarEtapas(1, [1], "v1", "u"), { etapas: [{ id: 1, nome: "Nova", fase: "prospeccao", ordem: 10, desfecho: null, exige_motivo: false, padrao: true, total: 2 }], versao: "v2" });
  const criada = await repo.criarEtapa(1, { nome: "Visita", fase: "proposta", desfecho: null, exige_motivo: false }, "u");
  assertEquals([criada.id, criada.ordem, "total" in criada, "versao" in criada], [9, 140, false, false]);
  assertEquals(chamadas, [
    'rpc:pipeline_etapas_reordenar:{"p_tenant":1,"p_ids":[1],"p_versao":"v1","p_user":"u"}',
    'rpc:pipeline_etapa_criar:{"p_tenant":1,"p_nome":"Visita","p_fase":"proposta","p_desfecho":null,"p_exige_motivo":false,"p_user":"u"}',
  ]);

  for (const [code, status, codigo] of [["LG001", 400, "lista_invalida"], ["LG002", 409, "versao_desatualizada"]] as const) {
    const r = createSupabaseRepo(clienteEtapas({ pipeline_etapas_reordenar: { data: null, error: { code, message: `pipeline_etapas_reordenar: motivo ${code}` } } }, []));
    const e = await r.reordenarEtapas(1, [1], "v1", "u").then(() => null, (x) => x);
    assertEquals(e instanceof ErroPipeline ? [e.status, e.codigo, e.message] : e, [status, codigo, `motivo ${code}`]);
  }
  const dup = createSupabaseRepo(clienteEtapas({ pipeline_etapa_criar: { data: null, error: { code: "23505", message: "duplicate key" } } }, []));
  const e = await dup.criarEtapa(1, { nome: "Nova", fase: "proposta", desfecho: null, exige_motivo: false }, "u").then(() => null, (x) => x);
  assertEquals(e instanceof ErroPipeline ? e.status : e, 409);
});
