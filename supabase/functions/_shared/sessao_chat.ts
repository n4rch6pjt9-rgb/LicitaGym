/**
 * Chat da sessão (spec 0039, etapa 1): consulta uma compra no Integra Compras e grava o resultado.
 * Usado pela rota manual `POST /api-disputa/sync-chat` e pela coleta agendada `sync-sessao-chat`.
 *
 * - K-1: grava em public.sessao_mensagens sem duplicar (chave_mensagem); nada é apagado nem sobrescrito.
 * - K-2: uma linha em private.integra_compras_run por consulta, com as chamadas por código HTTP, uma por página
 *   (200, 206 e 404 são cobrados) e a licitação de onde veio a chave (base da retenção, K-7).
 * - 403/502/timeout: registra o erro e para a compra (não consulta as diligências depois de uma falha).
 * Erro de banco sobe para o chamador, com o registro da execução fechado como erro.
 * - K-5b (etapa 1b): as mensagens lidas passam pela detecção de convocação (`_shared/sessao_alertas.ts`); o alerta é
 *   idempotente, então falha aqui fecha a execução como erro e a consulta seguinte refaz.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  consultarChatSerpro,
  consultarDiligenciasSerpro,
  ErroIntegraCompras,
  type MensagemIntegra,
  type ResultadoConsultaIntegra,
} from "./serpro.ts";
import { gerarAlertas } from "./sessao_alertas.ts";

export interface ConsultasIntegra {
  consultarChat?: (chave: string) => Promise<ResultadoConsultaIntegra>;
  consultarDiligencias?: (chave: string) => Promise<ResultadoConsultaIntegra>;
  /** Relógio injetável (janela de 24 h do alerta). */
  agora?: () => number;
}

export interface ResultadoSincronizacao {
  ok: boolean;
  total_lidas: number;
  novas_inseridas: number;
  /** Alertas de convocação gravados nesta consulta (K-5b). */
  alertas_gerados: number;
  /** {"200": n, "404": n, "sem_resposta": n, ...} */
  chamadas: Record<string, number>;
  /** Mensagem do erro da fonte, ou aviso de leitura incompleta (nunca o corpo da resposta). */
  erro: string | null;
  /** Status HTTP do erro da fonte; null = sem resposta (timeout, rede). */
  status_erro: number | null;
}

/** Extrai estritamente a chaveCompra oficial de 17 dígitos do Compras.gov.br. */
export function extrairChaveCompra17Digitos(licitacao: {
  codigo_externo?: string | null;
  link_sistema_origem?: string | null;
  raw?: Record<string, unknown> | null;
}): string | null {
  const COMPRAS_KEY_RE = /^\d{17}$/;
  const rawObj = (licitacao.raw && typeof licitacao.raw === "object") ? licitacao.raw : {};

  // 1. Campo explícito em raw (chaveCompra, chave_compra, idCompra, id_compra, compra)
  const rawCands = [rawObj.chaveCompra, rawObj.chave_compra, rawObj.idCompra, rawObj.id_compra, rawObj.compra];
  for (const c of rawCands) {
    if (typeof c === "string" && COMPRAS_KEY_RE.test(c.trim())) {
      return c.trim();
    }
  }

  // 2. codigo_externo (ex: "COMPRASGOV-PP-15300005000012026" ou direto "15300005000012026")
  if (typeof licitacao.codigo_externo === "string") {
    const cod = licitacao.codigo_externo.trim();
    if (COMPRAS_KEY_RE.test(cod)) return cod;
    if (cod.startsWith("COMPRASGOV-PP-")) {
      const semPrefixo = cod.slice("COMPRASGOV-PP-".length).trim();
      if (COMPRAS_KEY_RE.test(semPrefixo)) return semPrefixo;
    }
  }

  // 3. link_sistema_origem (ex: https://cnetmobile.estaleiro.serpro.gov.br/...compra=15300005000012026)
  if (typeof licitacao.link_sistema_origem === "string") {
    try {
      const url = new URL(licitacao.link_sistema_origem);
      const compraParam = url.searchParams.get("compra");
      if (compraParam && COMPRAS_KEY_RE.test(compraParam.trim())) {
        return compraParam.trim();
      }
    } catch {
      // Ignora erro de parsing de URL
    }
  }

  return null;
}

function paraLinha(chaveCompra: string, m: MensagemIntegra) {
  return {
    chave_compra: chaveCompra,
    id_uasg: m.chaveCompra?.idUasgIdentificacao ?? null,
    id_modalidade: m.chaveCompra?.idModalidade ?? null,
    numero: m.chaveCompra?.numero ?? null,
    ano: m.chaveCompra?.ano ?? null,
    numero_uasg: m.chaveCompra?.numeroUasg ?? null,
    identificador_item: m.identificadorItem,
    chave_mensagem: m.chaveMensagem,
    tipo: m.tipo,
    categoria: m.categoria,
    tipo_remetente: m.tipoRemetente,
    texto: m.texto,
    data_hora: m.dataHora,
    data_hora_fonte: m.dataHoraFonte,
    fonte: "integra_compras",
  };
}

/** Consulta chat e diligências de uma compra e grava mensagens novas e o registro da execução. */
export async function sincronizarCompra(
  supabase: SupabaseClient,
  alvo: { chaveCompra: string; licitacaoId: number; origem: "cron" | "usuario" },
  consultas: ConsultasIntegra = {},
): Promise<ResultadoSincronizacao> {
  const { data: run, error: erroRun } = await supabase
    .schema("private")
    .from("integra_compras_run")
    .insert({ chave_compra: alvo.chaveCompra, origem: alvo.origem, licitacao_id: alvo.licitacaoId })
    .select("id")
    .single();
  if (erroRun) throw erroRun;

  const chamadas: Record<string, number> = {};
  const contar = (status: number | null) => {
    const k = status === null ? "sem_resposta" : String(status);
    chamadas[k] = (chamadas[k] ?? 0) + 1;
  };

  const fnChat = consultas.consultarChat ?? consultarChatSerpro;
  const fnDiligencias = consultas.consultarDiligencias ?? consultarDiligenciasSerpro;

  const lidas: MensagemIntegra[] = [];
  let erroFonte: ErroIntegraCompras | null = null;
  let aviso: string | null = null;
  for (const fn of [fnChat, fnDiligencias]) {
    try {
      const r = await fn(alvo.chaveCompra);
      for (const st of r.statusPaginas ?? [r.status]) contar(st);
      lidas.push(...r.mensagens);
      if (r.aviso) aviso = r.aviso;
    } catch (e) {
      if (!(e instanceof ErroIntegraCompras)) throw e;
      // Páginas lidas antes da falha foram cobradas: conta e grava o que veio delas.
      for (const st of e.statusPaginasAnteriores) contar(st);
      lidas.push(...e.mensagensAnteriores);
      contar(e.status);
      erroFonte = e;
      break; // 403/502: registra e para a compra (K-3)
    }
  }

  let novas = 0;
  if (lidas.length > 0) {
    const { data: inseridas, error: erroUpsert } = await supabase
      .from("sessao_mensagens")
      .upsert(lidas.map((m) => paraLinha(alvo.chaveCompra, m)), {
        onConflict: "chave_mensagem",
        ignoreDuplicates: true,
      })
      .select("chave_mensagem");
    if (erroUpsert) {
      await supabase.schema("private").from("integra_compras_run")
        .update({
          terminado_em: new Date().toISOString(),
          chamadas,
          mensagens_lidas: lidas.length,
          erro: "falha ao gravar mensagens",
        })
        .eq("id", run.id);
      throw erroUpsert;
    }
    novas = (inseridas ?? []).length;
  }

  let alertas = 0;
  try {
    alertas = await gerarAlertas(
      supabase,
      alvo.licitacaoId,
      lidas.map((m) => ({
        chave_mensagem: m.chaveMensagem,
        texto: m.texto,
        identificador_item: m.identificadorItem,
        data_hora: m.dataHora,
      })),
      consultas.agora ? consultas.agora() : Date.now(),
    );
  } catch (e) {
    await supabase.schema("private").from("integra_compras_run")
      .update({
        terminado_em: new Date().toISOString(),
        chamadas,
        mensagens_lidas: lidas.length,
        mensagens_novas: novas,
        erro: "falha ao gerar alertas de convocação",
      })
      .eq("id", run.id);
    throw e;
  }

  const { error: erroFim } = await supabase
    .schema("private")
    .from("integra_compras_run")
    .update({
      terminado_em: new Date().toISOString(),
      chamadas,
      mensagens_lidas: lidas.length,
      mensagens_novas: novas,
      erro: erroFonte ? erroFonte.message : aviso,
    })
    .eq("id", run.id);
  if (erroFim) throw erroFim;

  return {
    ok: erroFonte === null,
    total_lidas: lidas.length,
    novas_inseridas: novas,
    alertas_gerados: alertas,
    chamadas,
    erro: erroFonte ? erroFonte.message : aviso,
    status_erro: erroFonte ? erroFonte.status : null,
  };
}
