import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { DadosRestritos, Empresa, Papel, TipoEmpresa, Usuario, Vinculo } from "./types.ts";

const EMPRESA_COLUMNS = "id,slug,nome,cnpj,tipo,ativo";
/** Páginas de 200 usuários na Admin API do Auth; 50 páginas = 10 mil contas (hoje são 3). */
const USUARIOS_POR_PAGINA = 200;
const MAX_PAGINAS_USUARIOS = 50;

/** Erro de regra já com status HTTP. */
export class ErroTenant extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TenantRepo {
  vinculosDoUsuario(userId: string): Promise<Vinculo[]>;
  /** `ids` nulo = todas (desenvolvedor). */
  empresas(ids: number[] | null): Promise<Empresa[]>;
  empresaPorId(id: number): Promise<Empresa | null>;
  empresaPorCnpj(cnpj: string): Promise<Empresa | null>;
  criarEmpresa(e: { slug: string; nome: string; cnpj: string; tipo: TipoEmpresa; ativo: boolean }): Promise<Empresa>;
  apagarEmpresa(id: number): Promise<void>;
  atualizarEmpresa(id: number, campos: Partial<Pick<Empresa, "nome" | "cnpj" | "ativo">>): Promise<Empresa | null>;
  /** Empresas ativas, fora `excetoId`, sem nenhum membro ativo. */
  ativasSemMembro(excetoId: number): Promise<Empresa[]>;
  vinculos(tenant: number): Promise<Vinculo[]>;
  salvarVinculo(v: Vinculo): Promise<void>;
  usuarioPorEmail(email: string): Promise<Usuario | null>;
  usuarios(ids: string[]): Promise<Usuario[]>;
  dadosRestritos(tenant: number): Promise<DadosRestritos | null>;
  /** Grava só as chaves presentes em `d` (o upsert do PostgREST não toca as colunas ausentes). */
  salvarDadosRestritos(tenant: number, d: Partial<Omit<DadosRestritos, "updated_at">>, userId: string): Promise<DadosRestritos>;
}

function falha(error: { code?: string; message?: string } | null): never {
  if (error?.code === "23505") {
    if ((error.message ?? "").includes("tenants_slug_key")) {
      throw new ErroTenant("Já existe uma empresa com esse slug; informe outro 'slug'.", 409);
    }
    throw new ErroTenant("Já existe um registro igual.", 409);
  }
  throw new Error(error?.message ?? "Erro no cadastro da empresa");
}

const empresa = (r: Record<string, unknown>): Empresa => ({
  id: Number(r.id), slug: String(r.slug), nome: String(r.nome), cnpj: (r.cnpj as string | null) ?? null,
  tipo: r.tipo as TipoEmpresa, ativo: Boolean(r.ativo),
});

const vinculo = (r: Record<string, unknown>): Vinculo => ({
  tenant_id: Number(r.tenant_id), user_id: String(r.user_id), papel: r.papel as Papel, ativo: Boolean(r.ativo),
});

export function createSupabaseRepo(client: SupabaseClient): TenantRepo {
  return {
    async vinculosDoUsuario(userId) {
      const { data, error } = await client.from("tenant_membros").select("tenant_id,user_id,papel,ativo").eq("user_id", userId);
      if (error) falha(error);
      return (data ?? []).map(vinculo);
    },

    async empresas(ids) {
      let q = client.from("tenants").select(EMPRESA_COLUMNS).order("id");
      if (ids !== null) {
        if (ids.length === 0) return [];
        q = q.in("id", ids);
      }
      const { data, error } = await q;
      if (error) falha(error);
      return (data ?? []).map(empresa);
    },

    async empresaPorId(id) {
      const { data, error } = await client.from("tenants").select(EMPRESA_COLUMNS).eq("id", id).maybeSingle();
      if (error) falha(error);
      return data ? empresa(data) : null;
    },

    async empresaPorCnpj(cnpj) {
      // Sem índice único de CNPJ (decisão 4): a unicidade é conferida aqui; limit(1) tolera duplicado antigo.
      const { data, error } = await client.from("tenants").select(EMPRESA_COLUMNS).eq("cnpj", cnpj).order("id").limit(1);
      if (error) falha(error);
      return data && data.length > 0 ? empresa(data[0]) : null;
    },

    async criarEmpresa(e) {
      const { data, error } = await client.from("tenants").insert(e).select(EMPRESA_COLUMNS).single();
      if (error) falha(error);
      return empresa(data);
    },

    async apagarEmpresa(id) {
      const { error } = await client.from("tenants").delete().eq("id", id);
      if (error) falha(error);
    },

    async atualizarEmpresa(id, campos) {
      const { data, error } = await client.from("tenants").update(campos).eq("id", id).select(EMPRESA_COLUMNS).maybeSingle();
      if (error) falha(error);
      return data ? empresa(data) : null;
    },

    async ativasSemMembro(excetoId) {
      const { data: ativas, error } = await client.from("tenants").select(EMPRESA_COLUMNS).eq("ativo", true).neq("id", excetoId);
      if (error) falha(error);
      const lista = (ativas ?? []).map(empresa);
      if (lista.length === 0) return [];
      const { data: membros, error: e2 } = await client
        .from("tenant_membros").select("tenant_id").eq("ativo", true).in("tenant_id", lista.map((x) => x.id));
      if (e2) falha(e2);
      const comMembro = new Set((membros ?? []).map((m) => Number(m.tenant_id)));
      return lista.filter((x) => !comMembro.has(x.id));
    },

    async vinculos(tenant) {
      const { data, error } = await client
        .from("tenant_membros").select("tenant_id,user_id,papel,ativo").eq("tenant_id", tenant).order("created_at");
      if (error) falha(error);
      return (data ?? []).map(vinculo);
    },

    async salvarVinculo(v) {
      const { error } = await client.from("tenant_membros").upsert(v, { onConflict: "tenant_id,user_id" });
      if (error) falha(error);
    },

    async usuarioPorEmail(email) {
      // Só conta existente (decisão 2): procura, não cria nem convida.
      for (let page = 1; page <= MAX_PAGINAS_USUARIOS; page++) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage: USUARIOS_POR_PAGINA });
        if (error) throw new Error(error.message);
        const achado = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
        if (achado) {
          return { id: achado.id, email: achado.email ?? null, desenvolvedor: achado.app_metadata?.licitagym_role === "admin" };
        }
        if (data.users.length < USUARIOS_POR_PAGINA) return null;
      }
      throw new Error("Busca de usuário por e-mail passou do limite de páginas.");
    },

    async usuarios(ids) {
      const out: Usuario[] = [];
      for (const id of ids) {
        const { data, error } = await client.auth.admin.getUserById(id);
        // Conta apagada (404) aparece sem e-mail; qualquer outro erro do Auth é falha, não dado vazio.
        if (error && error.status !== 404) throw new Error(`Auth getUserById: ${error.message}`);
        if (!data?.user) out.push({ id, email: null, desenvolvedor: false });
        else out.push({ id, email: data.user.email ?? null, desenvolvedor: data.user.app_metadata?.licitagym_role === "admin" });
      }
      return out;
    },

    async dadosRestritos(tenant) {
      const { data, error } = await client
        .from("tenant_dados_restritos").select("banco,agencia,conta,updated_at").eq("tenant_id", tenant).maybeSingle();
      if (error) falha(error);
      return data ? { banco: data.banco, agencia: data.agencia, conta: data.conta, updated_at: data.updated_at } : null;
    },

    async salvarDadosRestritos(tenant, d, userId) {
      const { data, error } = await client
        .from("tenant_dados_restritos")
        .upsert({ tenant_id: tenant, ...d, updated_at: new Date().toISOString(), updated_by: userId }, { onConflict: "tenant_id" })
        .select("banco,agencia,conta,updated_at").single();
      if (error) falha(error);
      return { banco: data.banco, agencia: data.agencia, conta: data.conta, updated_at: data.updated_at };
    },
  };
}
