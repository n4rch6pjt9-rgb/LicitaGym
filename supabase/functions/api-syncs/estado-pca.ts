import { jsonResponse } from "../_shared/http.ts";
import { createServiceClient } from "../_shared/pncp/supabase-admin.ts";

type Row = Record<string, unknown>;
const FILA = ["total", "pendentes", "processando", "erros_nao_esgotados", "esgotados", "feitos", "abertos", "reservas_expiradas"] as const;
const CONTAGENS = ["recebidos", "novos", "alterados", "inalterados", "erros", "planos_feitos", "planos_erro", "itens_inativados", "planos_inativados"] as const;

function objeto(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resumo PCA invalido");
  return value as Row;
}

function contador(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Contagem PCA invalida");
  return value;
}

function texto(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Campo PCA invalido");
  return value;
}

function data(value: unknown): string {
  const result = texto(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Data PCA invalida");
  return result;
}

function execucao(value: unknown) {
  if (value === null) return null;
  const row = objeto(value);
  const raw = objeto(row.contagens);
  const contagens = Object.fromEntries(CONTAGENS.map((key) => [key, raw[key] === null ? null : contador(raw[key])]));
  if (typeof row.tem_erro !== "boolean") throw new Error("Estado de erro PCA invalido");
  // Projecao explicita: nunca devolver parametros, erros SQL ou campos extras da RPC.
  return {
    sync_id: texto(row.sync_id), status: texto(row.status), rotina: texto(row.rotina),
    iniciada_em: data(row.iniciada_em),
    finalizada_em: row.finalizada_em === null ? null : data(row.finalizada_em),
    heartbeat_em: row.heartbeat_em === null ? null : data(row.heartbeat_em),
    tem_erro: row.tem_erro, contagens,
  };
}

export function projetarEstadoPca(value: unknown, ano: number) {
  const row = objeto(value);
  if (row.ano !== ano) throw new Error("Ano do resumo PCA divergente");
  const rawFila = objeto(row.fila);
  const fila = Object.fromEntries(FILA.map((key) => [key, contador(rawFila[key])]));
  if (fila.abertos !== fila.pendentes + fila.processando + fila.erros_nao_esgotados ||
    fila.total !== fila.abertos + fila.esgotados + fila.feitos || fila.reservas_expiradas > fila.processando) {
    throw new Error("Fila PCA inconsistente");
  }
  const ultima = execucao(row.ultima_execucao);
  const ultimoLote = execucao(row.ultimo_lote_sem_erros);
  const ativas = contador(row.execucoes_ativas);
  const semHeartbeat = contador(row.execucoes_sem_heartbeat);
  const temPendencias = fila.abertos > 0 || fila.esgotados > 0;
  const estado = ativas > 0 ? "em_execucao"
    : !ultima ? "sem_execucoes"
    : semHeartbeat > 0 || fila.reservas_expiradas > 0 || fila.esgotados > 0 || fila.erros_nao_esgotados > 0 || ultima.tem_erro ? "atencao"
    : temPendencias || ultima.status !== "concluida" ? "parcial" : "atualizado";
  return {
    ano, observado_em: data(row.observado_em), estado,
    atualizacao_parcial: temPendencias || !ultima || ultima.status !== "concluida" || semHeartbeat > 0,
    fila, execucoes_ativas: ativas, execucoes_sem_heartbeat: semHeartbeat,
    ultima_execucao: ultima, ultimo_lote_sem_erros: ultimoLote,
  };
}

async function consultar(ano: number): Promise<unknown> {
  const { data, error } = await createServiceClient().rpc("pca_estado_operacional", { p_ano: ano });
  if (error) throw new Error(error.message);
  return data;
}

export async function responderEstadoPca(body: Row, agora: Date, ler: (ano: number) => Promise<unknown> = consultar) {
  const ano = body.ano === undefined ? agora.getUTCFullYear() : body.ano;
  if (typeof ano !== "number" || !Number.isInteger(ano) || ano < 1900 || ano > 2100) {
    return jsonResponse({ error: "Ano invalido: informe um inteiro entre 1900 e 2100." }, 400);
  }
  try {
    const resumo = projetarEstadoPca(await ler(ano), ano);
    return jsonResponse({ action: "estado_pca", ...resumo }, 200, { "Cache-Control": "no-store" });
  } catch {
    return jsonResponse({ error: "Nao foi possivel consultar o estado do PCA." }, 502, { "Cache-Control": "no-store" });
  }
}
