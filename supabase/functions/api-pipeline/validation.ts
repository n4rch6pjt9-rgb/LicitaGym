import { type Acao, DESFECHOS, type Desfecho, type Fase, FASES } from "./types.ts";

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

export function parseActionFromBody(body: Corpo): Resultado {
  const action = body.action;
  switch (action) {
    case "etapas_listar":
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
      const ordem = body.ordem === undefined || body.ordem === null ? null : idPositivo(body.ordem);
      if (body.ordem !== undefined && body.ordem !== null && ordem === null) return { error: "'ordem' deve ser inteiro positivo." };
      return { action, nome, fase: f, ordem, desfecho: d, exige_motivo: body.exige_motivo === true };
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
      if (body.ordem !== undefined) {
        const ordem = idPositivo(body.ordem);
        if (!ordem) return { error: "'ordem' deve ser inteiro positivo." };
        out.ordem = ordem;
      }
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
    case "etapa_excluir": {
      const id = idPositivo(body.id);
      if (!id) return { error: "'id' da etapa é obrigatório." };
      const mover_para = body.mover_para === undefined || body.mover_para === null ? null : idPositivo(body.mover_para);
      if (body.mover_para !== undefined && body.mover_para !== null && mover_para === null) {
        return { error: "'mover_para' deve ser o id de uma etapa." };
      }
      return { action, id, mover_para };
    }
    default:
      return { error: "Ação inválida ou ausente." };
  }
}
