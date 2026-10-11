import { type Acao, type Status, STATUS } from "./types.ts";

type Corpo = Record<string, unknown>;
type Resultado = Acao | { error: string };

const FASE_RE = /^F\d{2}$/;
const EVENTO_RE = /^[A-Z][A-Z0-9_]{2,60}$/;
/** Data e hora com fuso explícito (Z ou ±hh:mm): data pura viraria meia-noite UTC, um dia antes em Brasília. */
const DATA_HORA_FUSO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idPositivo = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);

const status = (v: unknown): Status | null => (STATUS as readonly unknown[]).includes(v) ? v as Status : null;

/** Exatamente um entre fase (F01..F12) e evento (código de processo_eventos). */
function faseOuEvento(body: Corpo): { fase: string | null; evento: string | null } | { error: string } {
  const fase = body.fase ?? null;
  const evento = body.evento ?? null;
  if ((fase === null) === (evento === null)) return { error: "Informe exatamente um entre 'fase' e 'evento'." };
  if (fase !== null && (typeof fase !== "string" || !FASE_RE.test(fase))) return { error: "'fase' inválida (ex.: F05)." };
  if (evento !== null && (typeof evento !== "string" || !EVENTO_RE.test(evento))) {
    return { error: "'evento' inválido (ex.: ATA_HABILITACAO)." };
  }
  return { fase: fase as string | null, evento: evento as string | null };
}

const erro = (x: unknown): x is { error: string } => typeof x === "object" && x !== null && "error" in x;

export function parseActionFromBody(body: Corpo): Resultado {
  const action = body.action;
  switch (action) {
    case "catalogo_liberadas":
    case "tarefas_liberar": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' é obrigatório." };
      const fe = faseOuEvento(body);
      return erro(fe) ? fe : { action, licitacao_id, ...fe };
    }
    case "tarefas_listar": {
      const licitacao_id = body.licitacao_id === undefined || body.licitacao_id === null ? null : idPositivo(body.licitacao_id);
      if (body.licitacao_id !== undefined && body.licitacao_id !== null && licitacao_id === null) return { error: "'licitacao_id' inválido." };
      const s = body.status === undefined || body.status === null ? null : status(body.status);
      if (body.status !== undefined && body.status !== null && s === null) return { error: `'status' deve ser um de: ${STATUS.join(", ")}.` };
      return { action, licitacao_id, status: s, minhas: body.minhas === true };
    }
    case "tarefa_atualizar": {
      const id = idPositivo(body.id);
      if (!id) return { error: "'id' é obrigatório." };
      const out: { action: "tarefa_atualizar"; id: number; status?: Status; prazo_em?: string } = { action, id };
      if (body.status !== undefined) {
        const s = status(body.status);
        if (!s) return { error: `'status' deve ser um de: ${STATUS.join(", ")}.` };
        out.status = s;
      }
      if (body.prazo_em !== undefined) {
        const ok = typeof body.prazo_em === "string" && DATA_HORA_FUSO_RE.test(body.prazo_em);
        const d = ok ? new Date(body.prazo_em as string) : null;
        if (!d || Number.isNaN(d.getTime())) {
          return { error: "'prazo_em' deve ser data e hora ISO 8601 com fuso (ex.: 2026-10-20T18:00:00-03:00)." };
        }
        out.prazo_em = d.toISOString();
      }
      if (out.status === undefined && out.prazo_em === undefined) return { error: "Nada para atualizar: informe 'status' ou 'prazo_em'." };
      return out;
    }
    case "tarefa_atribuir": {
      const id = idPositivo(body.id);
      if (!id) return { error: "'id' é obrigatório." };
      if (body.user_id === null) return { action, id, user_id: null };
      if (typeof body.user_id !== "string" || !UUID_RE.test(body.user_id)) return { error: "'user_id' deve ser UUID ou null." };
      return { action, id, user_id: body.user_id.toLowerCase() };
    }
    default:
      return { error: "Ação inválida. Use catalogo_liberadas, tarefas_liberar, tarefas_listar, tarefa_atualizar ou tarefa_atribuir." };
  }
}
