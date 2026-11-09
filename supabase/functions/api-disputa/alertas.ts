/**
 * Alertas de convocação do chat da sessão (spec 0039, etapa 1b): leitura (K-5c) e marcação como lido (K-5d).
 * Sempre filtrado pelo tenant de quem chama (o cliente é service_role; o tenant vem de lerTenantDoUsuario).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const LIMITE = 50;
const COLUNAS =
  "id,licitacao_id,tipo,identificador_item,fornecedor_razao_social,fornecedor_cnpj,da_empresa,prazo,mensagem_em,lido_em";

export interface AlertaSaida {
  id: number;
  licitacao_id: number;
  tipo: string;
  identificador_item: string | null;
  fornecedor_razao_social: string | null;
  fornecedor_cnpj: string | null;
  da_empresa: boolean;
  prazo: string | null;
  mensagem_em: string;
  lido_em: string | null;
  /** prazo < agora; null quando o texto não trouxe prazo (desconhecido, nunca inventado). */
  vencido: boolean | null;
}

export async function listarAlertas(
  supabase: SupabaseClient,
  tenantId: number,
  opcoes: { naoLidos: boolean; agoraMs: number },
): Promise<AlertaSaida[]> {
  let q = supabase.from("sessao_alertas").select(COLUNAS).eq("tenant_id", tenantId);
  if (opcoes.naoLidos) q = q.is("lido_em", null);
  const { data, error } = await q.order("mensagem_em", { ascending: false }).limit(LIMITE);
  if (error) throw error;
  return ((data ?? []) as Array<Omit<AlertaSaida, "vencido">>).map((a) => ({
    id: a.id,
    licitacao_id: a.licitacao_id,
    tipo: a.tipo,
    identificador_item: a.identificador_item,
    fornecedor_razao_social: a.fornecedor_razao_social,
    fornecedor_cnpj: a.fornecedor_cnpj,
    da_empresa: a.da_empresa,
    prazo: a.prazo,
    mensagem_em: a.mensagem_em,
    lido_em: a.lido_em,
    vencido: a.prazo ? Date.parse(a.prazo) < opcoes.agoraMs : null,
  }));
}

/** Marca como lido só se o alerta for do tenant; devolve false se não achou (inexistente ou de outro tenant). */
export async function marcarAlertaLido(
  supabase: SupabaseClient,
  tenantId: number,
  id: number,
  userId: string,
  agoraMs: number,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("sessao_alertas")
    .update({ lido_em: new Date(agoraMs).toISOString(), lido_por: userId })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}
