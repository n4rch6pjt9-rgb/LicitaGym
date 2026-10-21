import { type Acao, DESFECHOS, type Desfecho, type Fase, FASES, type ItemAgente, type ItemModelo, type ResponsavelModelo } from "./types.ts";

export const MAX_LOTE = 200;
const MAX_NOME = 60;
const MAX_MOTIVO = 500;

type Corpo = Record<string, unknown>;
type Resultado = Acao | { error: string };

const idPositivo = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);

function listaIds(v: unknown, campo = "licitacao_ids"): number[] | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: `'${campo}' deve ser uma lista com ao menos um id.` };
  if (v.length > MAX_LOTE) return { error: `'${campo}' aceita no máximo ${MAX_LOTE} ids por chamada.` };
  const ids = v.map(idPositivo);
  if (ids.some((x) => x === null)) return { error: `'${campo}' só aceita ids inteiros positivos.` };
  return [...new Set(ids as number[])];
}

const MAX_VERSAO = 64;
/** A ordem só muda por etapas_reordenar (spec 0034, K-7): lista inteira, com a versão lida, dentro do lock. */
const SO_REORDENAR = "Use etapas_reordenar para mudar a ordem.";

function nomeEtapa(v: unknown): string | { error: string } {
  if (typeof v !== "string" || v.trim().length === 0) return { error: "'nome' da etapa é obrigatório." };
  const nome = v.trim().replace(/\s+/g, " ");
  if (nome.length > MAX_NOME) return { error: `'nome' da etapa aceita até ${MAX_NOME} caracteres.` };
  return nome;
}

const fase = (v: unknown): Fase | null => (FASES as readonly unknown[]).includes(v) ? v as Fase : null;
const desfecho = (v: unknown): Desfecho | null | undefined =>
  v === null ? null : ((DESFECHOS as readonly unknown[]).includes(v) ? v as Desfecho : undefined);

function motivo(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: "'motivo' deve ser texto." };
  const m = v.trim();
  if (m.length > MAX_MOTIVO) return { error: `'motivo' aceita até ${MAX_MOTIVO} caracteres.` };
  return m || null;
}

const erro = (x: unknown): x is { error: string } => typeof x === "object" && x !== null && "error" in x;

const MAX_TAREFAS_ETAPA = 100;
const CODIGO_CATALOGO_RE = /^\d{5}-F\d{2}-T\d{2}$/;
const CHAVE_RE = /^[a-z0-9][a-z0-9-]{2,59}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTE_RE = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_AGENTES_ETAPA = 20;

/** Responsável da tarefa da empresa (spec 0035). O banco confere que o usuário é membro ativo da empresa. */
function responsavel(v: unknown, i: number): ResponsavelModelo | { error: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: `'tarefas[${i}].responsavel' deve ser objeto.` };
  const o = v as Record<string, unknown>;
  if (o.tipo === "papel") {
    const papel = o.papel === undefined || o.papel === null ? null : o.papel;
    if (papel !== null && papel !== "admin" && papel !== "operacao") {
      return { error: `'tarefas[${i}].responsavel.papel' deve ser admin ou operacao.` };
    }
    return { tipo: "papel", papel: papel as "admin" | "operacao" | null };
  }
  if (o.tipo === "usuario") {
    if (typeof o.user_id !== "string" || !UUID_RE.test(o.user_id)) return { error: `'tarefas[${i}].responsavel.user_id' inválido.` };
    return { tipo: "usuario", user_id: o.user_id.toLowerCase() };
  }
  return { error: `'tarefas[${i}].responsavel.tipo' deve ser papel ou usuario (agente vai em etapa_tarefas_agentes_salvar).` };
}

/** Lista completa de agentes de uma etapa (etapa_tarefas_agentes_salvar). O banco confere o catálogo de agentes. */
function itensAgentes(v: unknown): ItemAgente[] | { error: string } {
  if (!Array.isArray(v)) return { error: "'agentes' deve ser a lista completa de agentes da etapa (array)." };
  if (v.length > MAX_AGENTES_ETAPA) return { error: `'agentes' aceita no máximo ${MAX_AGENTES_ETAPA} itens.` };
  const out: ItemAgente[] = [];
  for (const [i, it] of v.entries()) {
    if (typeof it !== "object" || it === null || Array.isArray(it)) return { error: `'agentes[${i}]' deve ser objeto.` };
    const o = it as Record<string, unknown>;
    if (typeof o.agente !== "string" || !AGENTE_RE.test(o.agente)) return { error: `'agentes[${i}].agente' inválido.` };
    const titulo = o.titulo === undefined || o.titulo === null ? null : o.titulo;
    if (titulo !== null && (typeof titulo !== "string" || titulo.trim().length > 200)) {
      return { error: `'agentes[${i}].titulo' deve ser texto (até 200 caracteres).` };
    }
    const descricao = o.descricao === undefined || o.descricao === null ? null : o.descricao;
    if (descricao !== null && (typeof descricao !== "string" || descricao.length > 2000)) {
      return { error: `'agentes[${i}].descricao' deve ser texto (até 2000 caracteres).` };
    }
    const prazo = o.prazo_horas === undefined || o.prazo_horas === null ? null : o.prazo_horas;
    if (prazo !== null && (typeof prazo !== "number" || !Number.isInteger(prazo) || prazo < 1 || prazo > 8760)) {
      return { error: `'agentes[${i}].prazo_horas' deve ser inteiro de 1 a 8760, ou null.` };
    }
    out.push({
      agente: o.agente,
      titulo: (titulo as string | null)?.trim().replace(/\s+/g, " ") || null,
      descricao: (descricao as string | null)?.trim() || null,
      prazo_horas: prazo as number | null,
    });
  }
  return out;
}

/** Lista completa do modelo de uma etapa (etapa_tarefas_salvar). O banco confere o catálogo e a chave. */
function itensModelo(v: unknown): ItemModelo[] | { error: string } {
  if (!Array.isArray(v)) return { error: "'tarefas' deve ser a lista completa da etapa (array)." };
  if (v.length > MAX_TAREFAS_ETAPA) return { error: `'tarefas' aceita no máximo ${MAX_TAREFAS_ETAPA} itens.` };
  const out: ItemModelo[] = [];
  for (const [i, it] of v.entries()) {
    if (typeof it !== "object" || it === null || Array.isArray(it)) return { error: `'tarefas[${i}]' deve ser objeto.` };
    const o = it as Record<string, unknown>;
    if (o.origem === "catalogo") {
      if (typeof o.tarefa_codigo !== "string" || !CODIGO_CATALOGO_RE.test(o.tarefa_codigo)) {
        return { error: `'tarefas[${i}].tarefa_codigo' inválido (ex.: 14133-F04-T01).` };
      }
      out.push({ origem: "catalogo", tarefa_codigo: o.tarefa_codigo });
    } else if (o.origem === "empresa") {
      const titulo = typeof o.titulo === "string" ? o.titulo.trim().replace(/\s+/g, " ") : "";
      if (!titulo || titulo.length > 200) return { error: `'tarefas[${i}].titulo' é obrigatório (até 200 caracteres).` };
      const chave = o.chave === undefined || o.chave === null ? null : o.chave;
      if (chave !== null && (typeof chave !== "string" || !CHAVE_RE.test(chave))) {
        return { error: `'tarefas[${i}].chave' inválida.` };
      }
      const descricao = o.descricao === undefined || o.descricao === null ? null : o.descricao;
      if (descricao !== null && (typeof descricao !== "string" || descricao.length > 2000)) {
        return { error: `'tarefas[${i}].descricao' deve ser texto (até 2000 caracteres).` };
      }
      const prazo = o.prazo_horas === undefined || o.prazo_horas === null ? null : o.prazo_horas;
      if (prazo !== null && (typeof prazo !== "number" || !Number.isInteger(prazo) || prazo < 1 || prazo > 8760)) {
        return { error: `'tarefas[${i}].prazo_horas' deve ser inteiro de 1 a 8760, ou null.` };
      }
      const item: ItemModelo = { origem: "empresa", chave: chave as string | null, titulo, descricao: (descricao as string | null)?.trim() || null, prazo_horas: prazo as number | null };
      if (o.responsavel !== undefined && o.responsavel !== null) {
        const r = responsavel(o.responsavel, i);
        if (erro(r)) return r;
        item.responsavel = r;
      }
      out.push(item);
    } else {
      return { error: `'tarefas[${i}].origem' deve ser catalogo ou empresa.` };
    }
  }
  return out;
}

export function parseActionFromBody(body: Corpo): Resultado {
  const action = body.action;
  switch (action) {
    case "etapas_listar":
    case "catalogo_listar":
      return { action };
    case "pipeline_listar": {
      if (body.etapa_id === undefined || body.etapa_id === null) return { action, etapa_id: null };
      const etapa_id = idPositivo(body.etapa_id);
      return etapa_id ? { action, etapa_id } : { error: "'etapa_id' inválido." };
    }
    case "pipeline_estado":
    case "pipeline_adicionar":
    case "pipeline_remover": {
      const ids = listaIds(body.licitacao_ids);
      return erro(ids) ? ids : { action, licitacao_ids: ids };
    }
    case "pipeline_mover": {
      const ids = listaIds(body.licitacao_ids);
      if (erro(ids)) return ids;
      const etapa_id = idPositivo(body.etapa_id);
      if (!etapa_id) return { error: "'etapa_id' é obrigatório para mover." };
      const m = motivo(body.motivo);
      return erro(m) ? m : { action, licitacao_ids: ids, etapa_id, motivo: m };
    }
    case "pipeline_historico": {
      const licitacao_id = idPositivo(body.licitacao_id);
      return licitacao_id ? { action, licitacao_id } : { error: "'licitacao_id' é obrigatório." };
    }
    case "etapa_criar": {
      const nome = nomeEtapa(body.nome);
      if (erro(nome)) return nome;
      const f = fase(body.fase);
      if (!f) return { error: `'fase' deve ser uma de: ${FASES.join(", ")}.` };
      const d = body.desfecho === undefined ? null : desfecho(body.desfecho);
      if (d === undefined) return { error: `'desfecho' deve ser null ou um de: ${DESFECHOS.join(", ")}.` };
      if (body.ordem !== undefined) return { error: SO_REORDENAR };
      return { action, nome, fase: f, desfecho: d, exige_motivo: body.exige_motivo === true };
    }
    case "etapa_atualizar": {
      const id = idPositivo(body.id);
      if (!id) return { error: "'id' da etapa é obrigatório." };
      const out: Extract<Acao, { action: "etapa_atualizar" }> = { action, id };
      if (body.nome !== undefined) {
        const nome = nomeEtapa(body.nome);
        if (erro(nome)) return nome;
        out.nome = nome;
      }
      if (body.fase !== undefined) {
        const f = fase(body.fase);
        if (!f) return { error: `'fase' deve ser uma de: ${FASES.join(", ")}.` };
        out.fase = f;
      }
      if (body.ordem !== undefined) return { error: SO_REORDENAR };
      if (body.desfecho !== undefined) {
        const d = desfecho(body.desfecho);
        if (d === undefined) return { error: `'desfecho' deve ser null ou um de: ${DESFECHOS.join(", ")}.` };
        out.desfecho = d;
      }
      if (body.exige_motivo !== undefined) {
        if (typeof body.exige_motivo !== "boolean") return { error: "'exige_motivo' deve ser true ou false." };
        out.exige_motivo = body.exige_motivo;
      }
      if (Object.keys(out).length === 2) return { error: "Nada para atualizar na etapa." };
      return out;
    }
    case "etapas_reordenar": {
      // Sem tirar repetidos: id repetido, faltando ou de outra empresa é o banco que recusa (400), e só depois de
      // conferir a versão (409), para uma lista velha não parecer lista errada.
      if (!Array.isArray(body.ids) || body.ids.length === 0) return { error: "'ids' deve ser a lista completa das etapas." };
      if (body.ids.length > MAX_LOTE) return { error: `'ids' aceita no máximo ${MAX_LOTE} etapas.` };
      const ids = body.ids.map(idPositivo);
      if (ids.some((x) => x === null)) return { error: "'ids' só aceita ids inteiros positivos." };
      if (typeof body.versao !== "string" || body.versao.length === 0 || body.versao.length > MAX_VERSAO) {
        return { error: "'versao' é obrigatória: use a que veio em etapas_listar." };
      }
      return { action, ids: ids as number[], versao: body.versao };
    }
    case "etapa_excluir": {
      const id = idPositivo(body.id);
      if (!id) return { error: "'id' da etapa é obrigatório." };
      const mover_para = body.mover_para === undefined || body.mover_para === null ? null : idPositivo(body.mover_para);
      if (body.mover_para !== undefined && body.mover_para !== null && mover_para === null) {
        return { error: "'mover_para' deve ser o id de uma etapa." };
      }
      return { action, id, mover_para };
    }
    case "etapa_tarefas_listar": {
      const etapa_id = idPositivo(body.etapa_id);
      return etapa_id ? { action, etapa_id } : { error: "'etapa_id' é obrigatório." };
    }
    case "etapa_tarefas_salvar": {
      const etapa_id = idPositivo(body.etapa_id);
      if (!etapa_id) return { error: "'etapa_id' é obrigatório." };
      const tarefas = itensModelo(body.tarefas);
      return erro(tarefas) ? tarefas : { action, etapa_id, tarefas };
    }
    case "etapa_tarefas_agentes_salvar": {
      const etapa_id = idPositivo(body.etapa_id);
      if (!etapa_id) return { error: "'etapa_id' é obrigatório." };
      const agentes = itensAgentes(body.agentes);
      return erro(agentes) ? agentes : { action, etapa_id, agentes };
    }
    case "tarefas_reaplicar": {
      const licitacao_id = idPositivo(body.licitacao_id);
      return licitacao_id ? { action, licitacao_id } : { error: "'licitacao_id' é obrigatório." };
    }
    default:
      return { error: "Ação inválida ou ausente." };
  }
}
