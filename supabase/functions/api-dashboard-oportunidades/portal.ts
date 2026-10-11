import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "../_shared/pncp/hash.ts";
import {
  alertaPortal,
  codigoRespostaPortal,
  consultarPortal,
  decidirAtualizacaoPortal,
  parsePortalProcessoUrl,
  situacaoPortal,
  type PortalAlerta,
  type PortalSecao,
} from "../_shared/portal-compras.ts";

interface ConsultaGravada {
  consultado_em: string | null;
  situacao: string | null;
  codigo_licitacao: string | null;
  erro: string | null;
  payload_hash: string | null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function consultaDe(row: unknown): ConsultaGravada | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  return {
    consultado_em: texto(r.consultado_em),
    situacao: texto(r.situacao),
    codigo_licitacao: texto(r.codigo_licitacao),
    erro: texto(r.erro),
    payload_hash: texto(r.payload_hash),
  };
}

async function lerConsulta(client: SupabaseClient, licitacaoId: number): Promise<ConsultaGravada | null> {
  const { data, error } = await client
    .from("portal_consulta")
    .select("consultado_em,situacao,codigo_licitacao,erro,payload_hash")
    .eq("licitacao_id", licitacaoId)
    .maybeSingle();
  if (error) return null;
  return consultaDe(data);
}

/**
 * Empresa (tenant) de quem chama, resolvida só quando a seção do Portal precisa dela. null = sem empresa resolvida:
 * nada conta como "no pipeline". pipeline_oportunidades é por tenant e é lido com service_role; sem este filtro a tela
 * mostraria o pipeline de outra empresa.
 */
export type TenantDoUsuario = () => Promise<number | null>;

async function estaNoPipeline(client: SupabaseClient, licitacaoId: number, tenant: number | null): Promise<boolean> {
  if (tenant === null) return false;
  const { data, error } = await client
    .from("pipeline_oportunidades")
    .select("licitacao_id")
    .eq("tenant_id", tenant)
    .eq("licitacao_id", licitacaoId)
    .limit(1);
  if (error || !Array.isArray(data)) return false;
  return data.length > 0;
}

async function gravarConsulta(
  client: SupabaseClient,
  licitacaoId: number,
  url: string,
  codigo: string,
  situacao: string | null,
  consultadoEm: string | null,
  httpStatus: number,
  erro: string | null,
  payloadHash: string | null,
): Promise<void> {
  const { error } = await client.from("portal_consulta").upsert({
    licitacao_id: licitacaoId,
    url_pagina: url,
    codigo_licitacao: codigo,
    situacao,
    consultado_em: consultadoEm,
    http_status: httpStatus,
    erro,
    payload_hash: payloadHash,
  }, { onConflict: "licitacao_id" });
  if (error) console.error("[portal-compras] falha ao gravar consulta");
}

/**
 * Seção `portal` do acompanhamento. Sem `atualizar`, só lê o snapshot.
 * `atualizar` chama a API só com a licitação no pipeline e fora da janela de 30 s.
 */
export async function secaoPortal(
  client: SupabaseClient,
  licitacaoId: number,
  link: unknown,
  atualizar: boolean,
  tenantDoUsuario: TenantDoUsuario,
  agora = new Date(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PortalSecao | null> {
  const processo = parsePortalProcessoUrl(link);
  if (!processo) return null;

  const gravada = await lerConsulta(client, licitacaoId);
  const foraDoPipeline = !(await estaNoPipeline(client, licitacaoId, await tenantDoUsuario()));
  const decisao = decidirAtualizacaoPortal(atualizar, foraDoPipeline, gravada?.consultado_em ?? null, agora);

  if (decisao !== "consultado") {
    const alerta = alertaPortal(
      processo,
      gravada?.consultado_em ?? null,
      gravada?.situacao ?? null,
      foraDoPipeline,
      agora,
    );
    return {
      ...alerta,
      codigo_licitacao: gravada?.codigo_licitacao ?? processo.codigoLicitacao,
      familia: "portaldecompraspublicas",
      atualizacao: decisao,
      erro: decisao === "fora_do_pipeline" ? null : gravada?.erro ?? null,
    };
  }

  const resposta = await consultarPortal(processo.api, fetchImpl);
  if (resposta.erro || !resposta.body) {
    await gravarConsulta(
      client,
      licitacaoId,
      processo.pagina,
      gravada?.codigo_licitacao ?? processo.codigoLicitacao,
      gravada?.situacao ?? null,
      gravada?.consultado_em ?? null,
      resposta.httpStatus,
      resposta.erro,
      gravada?.payload_hash ?? null,
    );
    const alerta = alertaPortal(processo, gravada?.consultado_em ?? null, gravada?.situacao ?? null, false, agora);
    return {
      ...alerta,
      familia: "portaldecompraspublicas",
      atualizacao: "erro",
      erro: "Falha ao consultar o portal",
    };
  }

  const situacao = situacaoPortal(resposta.body);
  const codigo = codigoRespostaPortal(resposta.body, processo.codigoLicitacao);
  const consultadoEm = agora.toISOString();
  await gravarConsulta(
    client,
    licitacaoId,
    processo.pagina,
    codigo,
    situacao,
    consultadoEm,
    resposta.httpStatus,
    null,
    await hashPayload(resposta.body),
  );
  return {
    ...alertaPortal(processo, consultadoEm, situacao, false, agora),
    codigo_licitacao: codigo,
    familia: "portaldecompraspublicas",
    atualizacao: "consultado",
    erro: null,
  };
}

/** Acrescenta `portal` só nas linhas cujo link é o Portal de Compras Públicas. */
export async function anexarAlertaPortal(
  client: SupabaseClient,
  items: Array<Record<string, unknown>>,
  tenantDoUsuario: TenantDoUsuario,
  agora = new Date(),
): Promise<Array<Record<string, unknown>>> {
  const ids = items
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return items;

  const links = await client
    .from("licitacoes_externas")
    .select("id,link_sistema_origem")
    .in("id", ids);
  if (links.error || !Array.isArray(links.data)) return items;

  const processos = new Map<number, NonNullable<ReturnType<typeof parsePortalProcessoUrl>>>();
  for (const row of links.data as Array<Record<string, unknown>>) {
    const processo = parsePortalProcessoUrl(row.link_sistema_origem);
    const id = Number(row.id);
    if (processo && Number.isInteger(id)) processos.set(id, processo);
  }
  if (processos.size === 0) return items;

  const portalIds = [...processos.keys()];
  const tenant = await tenantDoUsuario();
  const [consultas, pipeline] = await Promise.all([
    client
      .from("portal_consulta")
      .select("licitacao_id,consultado_em,situacao,codigo_licitacao")
      .in("licitacao_id", portalIds),
    tenant === null
      ? Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null })
      : client.from("pipeline_oportunidades").select("licitacao_id").eq("tenant_id", tenant).in("licitacao_id", portalIds),
  ]);

  const porConsulta = new Map<number, ConsultaGravada>();
  if (!consultas.error && Array.isArray(consultas.data)) {
    for (const row of consultas.data as Array<Record<string, unknown>>) {
      const id = Number(row.licitacao_id);
      const consulta = consultaDe(row);
      if (consulta && Number.isInteger(id)) porConsulta.set(id, consulta);
    }
  }
  const idsEmPipeline = new Set<number>();
  if (!pipeline.error && Array.isArray(pipeline.data)) {
    for (const row of pipeline.data as Array<Record<string, unknown>>) {
      const id = Number(row.licitacao_id);
      if (Number.isInteger(id)) idsEmPipeline.add(id);
    }
  }

  return items.map((item) => {
    const id = Number(item.id);
    const processo = processos.get(id);
    if (!processo) return item;
    const consulta = porConsulta.get(id) ?? null;
    const alerta: PortalAlerta = alertaPortal(
      processo,
      consulta?.consultado_em ?? null,
      consulta?.situacao ?? null,
      !idsEmPipeline.has(id),
      agora,
    );
    if (consulta?.codigo_licitacao) alerta.codigo_licitacao = consulta.codigo_licitacao;
    return { ...item, portal: alerta };
  });
}
