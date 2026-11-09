/**
 * Alerta de convocação (spec 0039, etapa 1b, K-5b): detecta no chat da sessão os avisos do sistema que pedem ação
 * com prazo e grava um alerta por tenant que tem a licitação no pipeline.
 *
 * Detecção pelo texto (não há tabela oficial dos códigos de `categoria`; ver docs/compras-gov/integra-compras.md):
 *   - convocacao_anexos: "Sr. Fornecedor <RAZÃO SOCIAL>, CNPJ <cnpj>, você foi convocado para enviar anexos para o
 *     item <X>. Prazo para encerrar o envio: HH:MM:SS do dia DD/MM/AAAA."
 *   - etapa_fechada: "A etapa fechada foi iniciada para o item <X>. Fornecedores convocados poderão enviar um lance
 *     único e fechado até às HH:MM:SS do dia DD/MM/AAAA."
 * O prazo do texto é hora de Brasília (UTC−3, sem horário de verão desde 2019). Prazo ilegível fica null.
 *
 * Geração idempotente: recebe as mensagens lidas (não só as novas) e o insert ignora (tenant_id, chave_mensagem)
 * repetido; só mensagem das últimas 24 h vira alerta (a primeira leitura traz o histórico inteiro).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type TipoAlerta = "convocacao_anexos" | "etapa_fechada";

export interface AlertaDetectado {
  tipo: TipoAlerta;
  identificador_item: string | null;
  fornecedor_razao_social: string | null;
  fornecedor_cnpj: string | null;
  /** ISO 8601 em UTC; null quando o texto não traz prazo legível. */
  prazo: string | null;
}

export interface MensagemParaAlerta {
  chave_mensagem: string;
  texto: string | null;
  identificador_item: string | null;
  data_hora: string;
}

export const JANELA_ALERTA_MS = 24 * 3600_000;
const BRASILIA_UTC_OFFSET_H = 3;

const RE_CONVOCACAO =
  /Sr\.?\s+Fornecedor\s+(.+?),\s*CNPJ\s*([\d./-]{14,18}),\s*voc[eê]\s+foi\s+convocad[oa]\s+para\s+enviar\s+anexos(?:\s+para\s+o\s+item\s+([A-Za-z]{0,2}\d+))?/i;
const RE_PRAZO_ANEXOS =
  /Prazo\s+para\s+encerrar\s+o\s+envio:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+do\s+dia\s+(\d{2})\/(\d{2})\/(\d{4})/i;
const RE_ETAPA_FECHADA = /etapa\s+fechada\s+foi\s+iniciada\s+para\s+o\s+item\s+([A-Za-z]{0,2}\d+)/i;
const RE_PRAZO_FECHADA =
  /lance\s+[uú]nico\s+e\s+fechado\s+at[eé]\s*(?:[àa]s\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s+do\s+dia\s+(\d{2})\/(\d{2})\/(\d{4})/i;

/** "HH:MM[:SS] do dia DD/MM/AAAA" em Brasília → ISO UTC; null se algum campo estiver fora do intervalo. */
function prazoBrasilia(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  const [h, mi, s, d, mes, a] = [m[1], m[2], m[3] ?? "0", m[4], m[5], m[6]].map((x) => Number(x));
  if (h > 23 || mi > 59 || s > 59 || mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  // 31/02 e afins: o Date "rola" para o mês seguinte; recusa em vez de inventar outra data.
  const dia = new Date(Date.UTC(a, mes - 1, d));
  if (dia.getUTCDate() !== d || dia.getUTCMonth() !== mes - 1) return null;
  return new Date(Date.UTC(a, mes - 1, d, h + BRASILIA_UTC_OFFSET_H, mi, s)).toISOString();
}

function soDigitos(cnpj: string | null | undefined): string | null {
  const d = (cnpj ?? "").replace(/\D/g, "");
  return d.length === 14 ? d : null;
}

export function detectarAlerta(m: { texto: string | null; identificador_item: string | null }): AlertaDetectado | null {
  const texto = (m.texto ?? "").replace(/\s+/g, " ");
  if (!texto) return null;

  const conv = texto.match(RE_CONVOCACAO);
  if (conv) {
    return {
      tipo: "convocacao_anexos",
      identificador_item: m.identificador_item ?? conv[3] ?? null,
      fornecedor_razao_social: conv[1].trim(),
      fornecedor_cnpj: soDigitos(conv[2]),
      prazo: prazoBrasilia(texto.match(RE_PRAZO_ANEXOS)),
    };
  }

  const fech = texto.match(RE_ETAPA_FECHADA);
  if (fech) {
    return {
      tipo: "etapa_fechada",
      identificador_item: m.identificador_item ?? fech[1],
      fornecedor_razao_social: null,
      fornecedor_cnpj: null,
      prazo: prazoBrasilia(texto.match(RE_PRAZO_FECHADA)),
    };
  }
  return null;
}

/** Grava os alertas das mensagens recentes para os tenants que têm a licitação no pipeline. Devolve quantos nasceram. */
export async function gerarAlertas(
  supabase: SupabaseClient,
  licitacaoId: number,
  mensagens: MensagemParaAlerta[],
  agoraMs: number,
): Promise<number> {
  const recentes: Array<{ m: MensagemParaAlerta; a: AlertaDetectado }> = [];
  for (const m of mensagens) {
    const quando = Date.parse(m.data_hora);
    if (!Number.isFinite(quando) || quando < agoraMs - JANELA_ALERTA_MS) continue;
    const a = detectarAlerta(m);
    if (a) recentes.push({ m, a });
  }
  if (recentes.length === 0) return 0;

  const { data: destinos, error: erroDestinos } = await supabase
    .schema("private")
    .rpc("sessao_alertas_destinos", { p_licitacao_id: licitacaoId });
  if (erroDestinos) throw erroDestinos;
  const lista = (destinos ?? []) as Array<{ tenant_id: number; cnpj: string | null }>;
  if (lista.length === 0) return 0;

  const linhas = lista.flatMap((t) =>
    recentes.map(({ m, a }) => ({
      tenant_id: t.tenant_id,
      licitacao_id: licitacaoId,
      chave_mensagem: m.chave_mensagem,
      tipo: a.tipo,
      identificador_item: a.identificador_item,
      fornecedor_razao_social: a.fornecedor_razao_social,
      fornecedor_cnpj: a.fornecedor_cnpj,
      da_empresa: a.fornecedor_cnpj !== null && a.fornecedor_cnpj === soDigitos(t.cnpj),
      prazo: a.prazo,
      mensagem_em: m.data_hora,
    }))
  );
  const { data: inseridos, error } = await supabase
    .from("sessao_alertas")
    .upsert(linhas, { onConflict: "tenant_id,chave_mensagem", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  return (inseridos ?? []).length;
}
