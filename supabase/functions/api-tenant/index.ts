import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { type ConsultaCnpj, consultarCnpjBrasilApi, cnpjValido, ErroCnpj } from "./cnpj.ts";
import { createSupabaseRepo, ErroTenant, type TenantRepo } from "./repo.ts";
import { ACOES_ADMIN, type Empresa, type Papel } from "./types.ts";
import { parseActionFromBody, slugDe } from "./validation.ts";

/**
 * api-tenant: cadastro da empresa (tenant) e dos usuários ligados a ela (spec 0017, Dashboard #29/#68).
 *   - desenvolvedor (app_metadata.licitagym_role = 'admin'): cria empresa e age como admin em qualquer empresa;
 *   - admin da empresa (tenant_membros.papel = 'admin'): edita empresa, usuários e dados bancários;
 *   - operação: lê a empresa e os usuários; não lê dados bancários.
 * O banco é acessado com service_role; o JWT só identifica e autoriza. user_metadata nunca decide papel.
 * Empresa nova nasce inativa: com a Konnen ainda sem membros, uma segunda empresa ativa faria a api-pipeline
 * responder 409 a todos (salvaguarda da spec 0017, CA-17).
 */

export interface ApiTenantContext {
  getRepo?: () => TenantRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  consultarCnpj?: (cnpj: string) => Promise<ConsultaCnpj>;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Papel do usuário na empresa: o desenvolvedor é admin em qualquer uma (decisão 3); senão, o vínculo ativo. */
async function papelNa(repo: TenantRepo, user: AuthenticatedUser, tenant: number): Promise<Papel | null> {
  if (isLicitagymAdmin(user)) return "admin";
  const v = (await repo.vinculosDoUsuario(user.id)).find((x) => x.tenant_id === tenant && x.ativo);
  return v?.papel ?? null;
}

/** CNPJ válido e ainda não usado por outra empresa (sem consultar a fonte). O nome da outra empresa só vai ao desenvolvedor. */
async function cnpjLivre(repo: TenantRepo, bruto: string, empresaId: number | null, dev: boolean): Promise<string> {
  const cnpj = cnpjValido(bruto);
  if (!cnpj) throw new ErroTenant("CNPJ inválido (dígito verificador).", 400);
  const dona = await repo.empresaPorCnpj(cnpj);
  if (dona && dona.id !== empresaId) {
    throw new ErroTenant(dev ? `CNPJ já cadastrado na empresa "${dona.nome}".` : "CNPJ já cadastrado em outra empresa.", 409);
  }
  return cnpj;
}

/** CNPJ ATIVO na fonte. */
async function cnpjAtivo(consultar: (c: string) => Promise<ConsultaCnpj>, cnpj: string): Promise<ConsultaCnpj> {
  const consulta = await consultar(cnpj);
  if (!consulta.ativa) {
    throw new ErroTenant(`Situação cadastral na Receita (BrasilAPI) é ${consulta.situacao_cadastral}; só empresa ATIVA pode ser cadastrada.`, 400);
  }
  return consulta;
}

export async function handleRequest(req: Request, ctx: ApiTenantContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const user = await (ctx.getUser ?? authenticateUser)(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse({ error: "Corpo JSON inválido. Esperado objeto JSON." }, 400);
  }

  const params = parseActionFromBody(body as Record<string, unknown>);
  if ("error" in params) return jsonResponse({ error: params.error }, 400);
  const dev = isLicitagymAdmin(user);
  const consultar = ctx.consultarCnpj ?? ((c: string) => consultarCnpjBrasilApi(c));

  try {
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(getDefaultServiceClient())))();

    if ("tenant_id" in params) {
      const papel = await papelNa(repo, user, params.tenant_id);
      if (!papel) return jsonResponse({ error: "Sem permissão: usuário não é membro desta empresa." }, 403);
      if (ACOES_ADMIN.has(params.action) && papel !== "admin") {
        return jsonResponse({ error: "Sem permissão: só o admin da empresa pode fazer isso." }, 403);
      }
      if (!(await repo.empresaPorId(params.tenant_id))) return jsonResponse({ error: "Empresa não encontrada." }, 404);
    }

    switch (params.action) {
      case "minha_empresa": {
        if (dev) {
          const empresas = await repo.empresas(null);
          return jsonResponse({ action: params.action, desenvolvedor: true, empresas: empresas.map((e) => ({ ...e, papel: "admin" })) });
        }
        const ativos = (await repo.vinculosDoUsuario(user.id)).filter((v) => v.ativo);
        const empresas = await repo.empresas(ativos.map((v) => v.tenant_id));
        const papelDe = new Map(ativos.map((v) => [v.tenant_id, v.papel]));
        return jsonResponse({
          action: params.action, desenvolvedor: false, empresas: empresas.map((e) => ({ ...e, papel: papelDe.get(e.id) })),
        });
      }

      case "cnpj_consultar": {
        // Desenvolvedor ou admin de alguma empresa: a consulta serve ao cadastro, não é busca aberta.
        const admin = dev || (await repo.vinculosDoUsuario(user.id)).some((v) => v.ativo && v.papel === "admin");
        if (!admin) return jsonResponse({ error: "Sem permissão: só admin consulta CNPJ para cadastro." }, 403);
        const cnpj = cnpjValido(params.cnpj);
        if (!cnpj) return jsonResponse({ error: "CNPJ inválido (dígito verificador)." }, 400);
        const consulta = await consultar(cnpj);
        console.info("[api-tenant] cnpj_consultar", { user: user.id, ativa: consulta.ativa });
        return jsonResponse({ action: params.action, consulta });
      }

      case "empresa_criar": {
        if (!dev) return jsonResponse({ error: "Sem permissão: só o desenvolvedor cria empresa." }, 403);
        const cnpj = await cnpjLivre(repo, params.cnpj, null, dev);
        // Conta do admin antes da fonte externa: e-mail errado não gasta consulta à BrasilAPI.
        const admin = await repo.usuarioPorEmail(params.admin_email);
        if (!admin) return jsonResponse({ error: "Não existe conta com o e-mail do admin; a conta precisa existir antes." }, 404);
        const consulta = await cnpjAtivo(consultar, cnpj);
        const nome = params.nome ?? consulta.nome_fantasia ?? consulta.razao_social;
        const slug = params.slug ?? (slugDe(nome) || `empresa-${consulta.cnpj}`);
        const empresa = await repo.criarEmpresa({ slug, nome, cnpj: consulta.cnpj, tipo: params.tipo, ativo: false });
        try {
          await repo.salvarVinculo({ tenant_id: empresa.id, user_id: admin.id, papel: "admin", ativo: true });
        } catch (e) {
          // Empresa sem admin não fica: desfaz a criação (spec 0017, CA-7). Se desfazer também falhar, registra a
          // empresa órfã para correção manual e devolve o erro original.
          try {
            await repo.apagarEmpresa(empresa.id);
          } catch (e2) {
            console.error("[api-tenant] empresa_criar: empresa sem admin não foi desfeita", {
              tenant: empresa.id, user: user.id, erro: e2 instanceof Error ? e2.message : "desconhecido",
            });
          }
          throw e;
        }
        console.info("[api-tenant] empresa_criar", { user: user.id, tenant: empresa.id });
        return jsonResponse({ action: params.action, empresa, consulta }, 201);
      }

      case "empresa_atualizar": {
        if (params.ativo !== undefined && !dev) {
          return jsonResponse({ error: "Sem permissão: só o desenvolvedor ativa ou desativa empresa." }, 403);
        }
        const campos: Partial<Pick<Empresa, "nome" | "cnpj" | "ativo">> = {};
        if (params.nome !== undefined) campos.nome = params.nome;
        let consulta: ConsultaCnpj | null = null;
        if (params.cnpj !== undefined) {
          consulta = await cnpjAtivo(consultar, await cnpjLivre(repo, params.cnpj, params.tenant_id, dev));
          campos.cnpj = consulta.cnpj;
        }
        if (params.ativo === true) {
          const orfas = await repo.ativasSemMembro(params.tenant_id);
          if (orfas.length > 0) {
            return jsonResponse({
              error: `Ligue ao menos um usuário à empresa "${orfas[0].nome}" antes de ativar outra: sem vínculo, o pipeline ` +
                "responderia 409 a todos.",
            }, 409);
          }
        }
        if (params.ativo !== undefined) campos.ativo = params.ativo;
        const empresa = await repo.atualizarEmpresa(params.tenant_id, campos);
        if (!empresa) return jsonResponse({ error: "Empresa não encontrada." }, 404);
        console.info("[api-tenant] empresa_atualizar", { user: user.id, tenant: empresa.id, campos: Object.keys(campos) });
        return jsonResponse({ action: params.action, empresa, ...(consulta ? { consulta } : {}) });
      }

      case "membros_listar": {
        const vinculos = await repo.vinculos(params.tenant_id);
        const emails = new Map((await repo.usuarios(vinculos.map((v) => v.user_id))).map((u) => [u.id, u.email]));
        return jsonResponse({
          action: params.action,
          membros: vinculos.map((v) => ({ user_id: v.user_id, email: emails.get(v.user_id) ?? null, papel: v.papel, ativo: v.ativo })),
        });
      }

      case "membro_adicionar": {
        const alvo = await repo.usuarioPorEmail(params.email);
        // Admin de empresa não liga conta de outra empresa nem a do desenvolvedor: ligar a uma segunda empresa faria
        // a api-pipeline responder 409 a essa pessoa. A resposta é a mesma de "conta não existe", para o admin de
        // cliente não descobrir quais e-mails têm conta. O desenvolvedor recebe o motivo.
        const outra = alvo ? (await repo.vinculosDoUsuario(alvo.id)).some((v) => v.ativo && v.tenant_id !== params.tenant_id) : false;
        const recusa = !alvo ? "sem_conta" : outra ? "outra_empresa" : (!dev && alvo.desenvolvedor) ? "desenvolvedor" : null;
        if (recusa && !dev) {
          return jsonResponse({ error: "Não foi possível ligar esse e-mail: a conta precisa existir e não pode estar ligada a outra empresa." }, 404);
        }
        if (recusa === "sem_conta") return jsonResponse({ error: "Não existe conta com esse e-mail; a conta precisa existir antes." }, 404);
        if (recusa === "outra_empresa") return jsonResponse({ error: "A conta já está ligada a outra empresa." }, 409);
        if (!alvo) return jsonResponse({ error: "Não existe conta com esse e-mail; a conta precisa existir antes." }, 404);
        // Vínculo existente muda por membro_atualizar, que confere a regra do último admin.
        if ((await repo.vinculos(params.tenant_id)).some((v) => v.user_id === alvo.id)) {
          return jsonResponse({ error: "Usuário já é membro desta empresa; use membro_atualizar." }, 409);
        }
        await repo.salvarVinculo({ tenant_id: params.tenant_id, user_id: alvo.id, papel: params.papel, ativo: true });
        console.info("[api-tenant] membro_adicionar", { user: user.id, tenant: params.tenant_id, papel: params.papel });
        return jsonResponse({ action: params.action, membro: { user_id: alvo.id, email: alvo.email, papel: params.papel, ativo: true } }, 201);
      }

      case "membro_atualizar": {
        const vinculos = await repo.vinculos(params.tenant_id);
        const atual = vinculos.find((v) => v.user_id === params.user_id);
        if (!atual) return jsonResponse({ error: "Usuário não é membro desta empresa." }, 404);
        const novo = { ...atual, papel: params.papel ?? atual.papel, ativo: params.ativo ?? atual.ativo };
        const eraAdmin = atual.ativo && atual.papel === "admin";
        const continuaAdmin = novo.ativo && novo.papel === "admin";
        if (eraAdmin && !continuaAdmin && vinculos.filter((v) => v.ativo && v.papel === "admin").length <= 1) {
          return jsonResponse({ error: "A empresa precisa de ao menos um admin ativo." }, 400);
        }
        // Salvaguarda (CA-17): empresa ativa sem membro, com outra empresa ativa, faz a api-pipeline responder 409.
        if (atual.ativo && !novo.ativo && vinculos.filter((v) => v.ativo).length <= 1) {
          const ativas = (await repo.empresas(null)).filter((e) => e.ativo);
          if (ativas.some((e) => e.id === params.tenant_id) && ativas.length > 1) {
            return jsonResponse({
              error: "Não dá para desativar o último membro de uma empresa ativa enquanto houver outra empresa ativa.",
            }, 409);
          }
        }
        await repo.salvarVinculo(novo);
        console.info("[api-tenant] membro_atualizar", { user: user.id, tenant: params.tenant_id, papel: novo.papel, ativo: novo.ativo });
        return jsonResponse({ action: params.action, membro: { user_id: novo.user_id, papel: novo.papel, ativo: novo.ativo } });
      }

      case "dados_restritos_obter":
        return jsonResponse({ action: params.action, dados: await repo.dadosRestritos(params.tenant_id) });

      case "dados_restritos_salvar": {
        const dados = await repo.salvarDadosRestritos(params.tenant_id, params.campos, user.id);
        // Sem banco/agência/conta no log.
        console.info("[api-tenant] dados_restritos_salvar", { user: user.id, tenant: params.tenant_id });
        return jsonResponse({ action: params.action, dados });
      }
    }
  } catch (e) {
    if (e instanceof ErroTenant || e instanceof ErroCnpj) return jsonResponse({ error: e.message }, e.status);
    console.error("[api-tenant] erro interno:", {
      action: params.action, tenant: "tenant_id" in params ? params.tenant_id : null, user: user.id,
      erro: e instanceof Error ? e.message : "desconhecido",
    });
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
