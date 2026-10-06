import { assertEquals } from "jsr:@std/assert@1";
import { type ApiPipelineContext, handleRequest } from "../../../supabase/functions/api-pipeline/index.ts";
import { ErroPipeline, type PipelineRepo } from "../../../supabase/functions/api-pipeline/repo.ts";
import type { Etapa, EventoHistorico } from "../../../supabase/functions/api-pipeline/types.ts";
import { MAX_LOTE, parseActionFromBody } from "../../../supabase/functions/api-pipeline/validation.ts";

// Repositório em memória com as mesmas regras de pipeline_mover / pipeline_etapa_excluir
function repoMemoria() {
  let seqEtapa = 0;
  let seqHist = 0;
  const etapas: Etapa[] = [];
  const ops = new Map<number, { etapa_id: number; motivo: string | null }>();
  const hist: EventoHistorico[] = [];
  const nova = (nome: string, ordem: number, extra: Partial<Etapa> = {}) =>
    etapas.push({ id: ++seqEtapa, nome, fase: "prospeccao", ordem, desfecho: null, exige_motivo: false, padrao: true, ...extra });
  nova("Nova", 10);
  nova("Triagem", 20);
  nova("Descartada", 130, { fase: "conclusao", desfecho: "descartada", exige_motivo: true });
  const licitacoes = new Set([101, 102, 103]);

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

  const repo: PipelineRepo = {
    tenantDoUsuario: () => Promise.resolve(1),
    listarEtapas: () =>
      Promise.resolve([...etapas].sort((a, b) => a.ordem - b.ordem).map((e) => ({ ...e, total: [...ops.values()].filter((o) => o.etapa_id === e.id).length }))),
    listarPipeline: (_t, etapaId) =>
      Promise.resolve({
        truncado: false,
        itens: [...ops.entries()].filter(([, o]) => !etapaId || o.etapa_id === etapaId).map(([id, o]) => ({
          licitacao_id: id, etapa_id: o.etapa_id, motivo: o.motivo, atualizada_em: "t", atualizada_por: "u", licitacao: { id },
        })),
      }),
    estado: (_t, ids) => Promise.resolve(ids.filter((id) => ops.has(id)).map((id) => ({ licitacao_id: id, etapa_id: ops.get(id)!.etapa_id }))),
    mover: (_t, ids, etapaId, motivo, user, soNovos) => Promise.resolve().then(() => mover(ids, etapaId, motivo, user, soNovos)),
    historico: (_t, id) => Promise.resolve(hist.filter((h) => h.licitacao_id === id).reverse()),
    criarEtapa: (_t, e) => {
      if (etapas.some((x) => x.nome === e.nome)) return Promise.reject(new ErroPipeline("Já existe uma etapa com esse nome.", 409));
      const etapa: Etapa = { id: ++seqEtapa, nome: e.nome, fase: e.fase, ordem: e.ordem ?? Math.max(...etapas.map((x) => x.ordem)) + 10, desfecho: e.desfecho, exige_motivo: e.exige_motivo, padrao: false };
      etapas.push(etapa);
      return Promise.resolve(etapa);
    },
    atualizarEtapa: (_t, id, campos) => {
      const e = etapas.find((x) => x.id === id);
      if (!e) return Promise.resolve(null);
      Object.assign(e, campos);
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
  };
  return { repo, ops, hist, etapas };
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

  const ren = await chamar(a, { action: "etapa_atualizar", id: criada.json.etapa.id, nome: "Visita", ordem: 45 });
  assertEquals(ren.json.etapa.nome, "Visita");

  await chamar(a, { action: "pipeline_adicionar", licitacao_ids: [101] });
  const sem = await chamar(a, { action: "etapa_excluir", id: 1 });
  assertEquals(sem.status, 400);
  const exc = await chamar(a, { action: "etapa_excluir", id: 1, mover_para: 2 });
  assertEquals(exc.json, { action: "etapa_excluir", excluida: 1, movidas: 1 });
  assertEquals(ops.get(101)?.etapa_id, 2);
  const etapas = await chamar(a, { action: "etapas_listar" });
  assertEquals(etapas.json.etapas.map((e: { nome: string }) => e.nome), ["Triagem", "Visita", "Descartada"]);
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
