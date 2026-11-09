/**
 * Alerta de convocação (spec 0039, etapa 1b, K-5b): detecta no chat da sessão os avisos do sistema que pedem ação
 * com prazo e grava um alerta por tenant que tem a compra no pipeline.
 *
 * Detecção pelo texto (não há tabela oficial dos códigos de `categoria`; ver docs/compras-gov/integra-compras.md):
 *   - convocacao_anexos: "Sr. Fornecedor <RAZÃO SOCIAL>, CNPJ <cnpj>, você foi convocado para enviar anexos para o
 *     item <X>. Prazo para encerrar o envio: HH:MM:SS do dia DD/MM/AAAA."
 *   - etapa_fechada: "A etapa fechada foi iniciada para o item <X>. Fornecedores convocados poderão enviar um lance
 *     único e fechado até às HH:MM:SS do dia DD/MM/AAAA."
 * Só vale mensagem do Sistema (tipo_remetente "0", mapa deduzido do conteúdo): texto igual escrito por licitante ou
 * pregoeiro no chat não vira alerta (um concorrente poderia forjar uma convocação).
 * O prazo do texto é hora de Brasília (UTC−3, sem horário de verão desde 2019). Prazo ilegível fica null.
 * Convocado por CPF (pessoa física): o alerta nasce sem nome nem documento (dado pessoal não é guardado).
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
  /** 14 posições sem máscara (numérico ou alfanumérico, Receita desde jul/2026); null se não for CNPJ válido. */
  fornecedor_cnpj: string | null;
  /** ISO 8601 em UTC; null quando o texto não traz prazo legível. */
  prazo: string | null;
}

export interface MensagemParaAlerta {
  chave_mensagem: string;
  texto: string | null;
  identificador_item: string | null;
  tipo_remetente: string | null;
  data_hora: string;
}

export const JANELA_ALERTA_MS = 24 * 3600_000;
export const REMETENTE_SISTEMA = "0";
const BRASILIA_UTC_OFFSET_H = 3;
/** Os avisos do sistema têm algumas centenas de caracteres; o corte deixa as regex lineares em texto de terceiro. */
const MAX_TEXTO = 4000;

const ITEM = String.raw`(?:\s+para\s+o\s+item\s+([A-Za-z]{0,2}\d+))?`;
const RE_CONVOCACAO = new RegExp(
  String.raw`Sr(?:\(a\))?\.?\s+Fornecedor\s+(.{1,200}?),\s*(CNPJ|CPF)\s*:?\s*([0-9A-Za-z./-]{11,18}),\s*` +
    String.raw`voc[eê]\s+foi\s+convocad[oa]\s+para\s+enviar\s+anexos` + ITEM,
  "i",
);
const RE_CONVOCACAO_SEM_FORNECEDOR = new RegExp(String.raw`foi\s+convocad[oa]\s+para\s+enviar\s+anexos` + ITEM, "i");
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

/** CNPJ sem máscara: 12 posições alfanuméricas + 2 dígitos verificadores (cobre o numérico de sempre). */
export function normalizarCnpj(cnpj: string | null | undefined): string | null {
  const s = (cnpj ?? "").replace(/[\s./-]/g, "").toUpperCase();
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(s) ? s : null;
}

export function detectarAlerta(m: { texto: string | null; identificador_item: string | null }): AlertaDetectado | null {
  const texto = (m.texto ?? "").slice(0, MAX_TEXTO).replace(/\s+/g, " ");
  if (!texto) return null;

  const conv = texto.match(RE_CONVOCACAO);
  if (conv) {
    const cpf = conv[2].toUpperCase() === "CPF";
    return {
      tipo: "convocacao_anexos",
      identificador_item: m.identificador_item ?? conv[4] ?? null,
      fornecedor_razao_social: cpf ? null : conv[1].trim(),
      fornecedor_cnpj: cpf ? null : normalizarCnpj(conv[3]),
      prazo: prazoBrasilia(texto.match(RE_PRAZO_ANEXOS)),
    };
  }
  // Convocação com cabeçalho diferente do conhecido: o alerta nasce sem fornecedor em vez de se perder.
  const generica = texto.match(RE_CONVOCACAO_SEM_FORNECEDOR);
  if (generica) {
    return {
      tipo: "convocacao_anexos",
      identificador_item: m.identificador_item ?? generica[1] ?? null,
      fornecedor_razao_social: null,
      fornecedor_cnpj: null,
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

/**
 * Grava os alertas das mensagens recentes do Sistema para os tenants que têm a compra no pipeline. `licitacaoIds`
 * são todas as licitações com a mesma chave de compra (registros de fontes diferentes); cada tenant recebe o alerta
 * ligado à licitação do pipeline dele. Devolve quantos alertas nasceram.
 */
export async function gerarAlertas(
  supabase: SupabaseClient,
  licitacaoIds: number[],
  mensagens: MensagemParaAlerta[],
  agoraMs: number,
): Promise<number> {
  const recentes: Array<{ m: MensagemParaAlerta; a: AlertaDetectado }> = [];
  for (const m of mensagens) {
    if (m.tipo_remetente !== REMETENTE_SISTEMA) continue;
    const quando = Date.parse(m.data_hora);
    if (!Number.isFinite(quando) || quando < agoraMs - JANELA_ALERTA_MS) continue;
    const a = detectarAlerta(m);
    if (a) recentes.push({ m, a });
  }
  if (recentes.length === 0 || licitacaoIds.length === 0) return 0;

  const { data: destinos, error: erroDestinos } = await supabase
    .schema("private")
    .rpc("sessao_alertas_destinos", { p_licitacao_ids: [...new Set(licitacaoIds)] });
  if (erroDestinos) throw erroDestinos;
  const lista = (destinos ?? []) as Array<{ tenant_id: number; cnpj: string | null; licitacao_id: number }>;
  if (lista.length === 0) return 0;

  const linhas = lista.flatMap((t) =>
    recentes.map(({ m, a }) => ({
      tenant_id: t.tenant_id,
      licitacao_id: t.licitacao_id,
      chave_mensagem: m.chave_mensagem,
      tipo: a.tipo,
      identificador_item: a.identificador_item,
      fornecedor_razao_social: a.fornecedor_razao_social,
      fornecedor_cnpj: a.fornecedor_cnpj,
      // Calculado no insert: se o CNPJ do tenant for corrigido depois, alertas antigos não mudam.
      da_empresa: a.fornecedor_cnpj !== null && a.fornecedor_cnpj === normalizarCnpj(t.cnpj),
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
