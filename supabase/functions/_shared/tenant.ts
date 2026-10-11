import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * Empresa (tenant) do usuário, para as Edge Functions que leem tabelas com tenant_id usando service_role
 * (api-pipeline, api-dashboard-oportunidades). A RLS não protege essas leituras: o filtro por tenant é este.
 *
 * Regras (LicitaGym spec 0017, issue #263):
 *  - vínculo ativo com empresa ativa manda; vínculo ativo com duas empresas ativas → 409;
 *  - vínculo ativo só com empresa desativada → 403: não cai em outra empresa;
 *  - vínculo desligado (tenant_membros.ativo = false) e nenhum ativo → 403: desligar o membro revoga o acesso;
 *  - sem vínculo nenhum: só o desenvolvedor (app_metadata.licitagym_role = 'admin') cai na única empresa ativa, com
 *    papel nulo. Qualquer outra conta sem vínculo → 403.
 */

export type PapelTenant = "admin" | "operacao";

export class ErroTenantAcesso extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface VinculoTenant {
  tenant_id: number;
  papel: PapelTenant;
  /** tenant_membros.ativo */
  ativo: boolean;
  /** tenants.ativo */
  empresa_ativa: boolean;
}

export interface TenantResolvido {
  tenant: number;
  /** Papel na empresa; null só para o desenvolvedor sem vínculo, que caiu na única empresa ativa. */
  papel: PapelTenant | null;
}

/** Regra pura. `vinculos` = todos os vínculos do usuário; `ativas` = ids de empresas ativas (bastam 2). */
export function resolverTenantDoUsuario(vinculos: VinculoTenant[], ativas: number[], desenvolvedor: boolean): TenantResolvido {
  const ligados = vinculos.filter((v) => v.ativo);
  const vivos = ligados.filter((v) => v.empresa_ativa);
  const tenants = [...new Set(vivos.map((v) => v.tenant_id))];
  if (tenants.length > 1) throw new ErroTenantAcesso("Usuário ligado a mais de uma empresa.", 409);
  if (tenants.length === 1) return { tenant: tenants[0], papel: vivos.find((v) => v.tenant_id === tenants[0])!.papel };
  if (ligados.length > 0) throw new ErroTenantAcesso("A empresa do usuário está desativada.", 403);
  if (vinculos.length > 0) throw new ErroTenantAcesso("O acesso do usuário à empresa foi desativado.", 403);
  if (!desenvolvedor) throw new ErroTenantAcesso("Usuário não está ligado a nenhuma empresa.", 403);
  if (ativas.length === 1) return { tenant: ativas[0], papel: null };
  if (ativas.length === 0) throw new ErroTenantAcesso("Nenhuma empresa ativa cadastrada.", 409);
  throw new ErroTenantAcesso("Há mais de uma empresa ativa; o desenvolvedor precisa estar ligado a uma.", 409);
}

/** Lê vínculos e empresas com service_role e aplica resolverTenantDoUsuario. */
export async function lerTenantDoUsuario(
  client: SupabaseClient,
  userId: string,
  desenvolvedor: boolean,
): Promise<TenantResolvido> {
  const { data: membros, error } = await client
    .from("tenant_membros")
    .select("tenant_id,papel,ativo")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const vinculos = (membros ?? []).map((r) => ({
    tenant_id: Number(r.tenant_id),
    papel: r.papel as PapelTenant,
    ativo: Boolean(r.ativo),
  }));
  let ativasLigadas = new Set<number>();
  if (vinculos.length > 0) {
    const { data: vivas, error: erroVivas } = await client
      .from("tenants")
      .select("id")
      .in("id", [...new Set(vinculos.map((v) => v.tenant_id))])
      .eq("ativo", true);
    if (erroVivas) throw new Error(erroVivas.message);
    ativasLigadas = new Set((vivas ?? []).map((r) => Number(r.id)));
  }
  const { data: ativas, error: erroAtivas } = await client
    .from("tenants")
    .select("id")
    .eq("ativo", true)
    .order("id")
    .limit(2);
  if (erroAtivas) throw new Error(erroAtivas.message);
  return resolverTenantDoUsuario(
    vinculos.map((v) => ({ ...v, empresa_ativa: ativasLigadas.has(v.tenant_id) })),
    (ativas ?? []).map((r) => Number(r.id)),
    desenvolvedor,
  );
}
