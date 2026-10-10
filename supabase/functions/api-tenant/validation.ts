import { type Acao, PAPEIS, type Papel, TIPOS_EMPRESA, type TipoEmpresa } from "./types.ts";

const MAX_NOME = 120;
const MAX_SLUG = 40;
const MAX_BANCARIO = 60;
const MAX_EMAIL = 254;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Corpo = Record<string, unknown>;
type Resultado = Acao | { error: string };

const erro = (x: unknown): x is { error: string } => typeof x === "object" && x !== null && "error" in x;

const idPositivo = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);

const papel = (v: unknown): Papel | null => (PAPEIS as readonly unknown[]).includes(v) ? v as Papel : null;
const tipo = (v: unknown): TipoEmpresa | null => (TIPOS_EMPRESA as readonly unknown[]).includes(v) ? v as TipoEmpresa : null;

/** CNPJ só como texto; a validação do DV fica em cnpjValido (cnpj.ts), com a mensagem própria. */
function cnpjTexto(v: unknown): string | { error: string } {
  if (typeof v !== "string" || v.trim() === "") return { error: "'cnpj' é obrigatório." };
  return v.trim();
}

function email(v: unknown, campo: string): string | { error: string } {
  if (typeof v !== "string") return { error: `'${campo}' é obrigatório.` };
  const e = v.trim().toLowerCase();
  if (e.length === 0 || e.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: `'${campo}' não é um e-mail válido.` };
  return e;
}

function nome(v: unknown): string | { error: string } {
  if (typeof v !== "string" || v.trim().length === 0) return { error: "'nome' não pode ser vazio." };
  const n = v.trim().replace(/\s+/g, " ");
  if (n.length > MAX_NOME) return { error: `'nome' aceita até ${MAX_NOME} caracteres.` };
  return n;
}

function slug(v: unknown): string | { error: string } {
  if (typeof v !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) || v.length > MAX_SLUG) {
    return { error: `'slug' aceita letras minúsculas, dígitos e hífen, até ${MAX_SLUG} caracteres.` };
  }
  return v;
}

function bancario(v: unknown, campo: string): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { error: `'${campo}' deve ser texto.` };
  const t = v.trim();
  if (t.length > MAX_BANCARIO) return { error: `'${campo}' aceita até ${MAX_BANCARIO} caracteres.` };
  return t || null;
}

/** Gera o slug a partir do nome (sem acento, minúsculo, hífen), para quando o desenvolvedor não informa. */
export function slugDe(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG).replace(/-+$/, "");
}

export function parseActionFromBody(b: Corpo): Resultado {
  const action = b.action;
  const tenant = () => idPositivo(b.tenant_id) ?? { error: "'tenant_id' deve ser um id inteiro positivo." };

  switch (action) {
    case "minha_empresa":
      return { action };

    case "cnpj_consultar": {
      const c = cnpjTexto(b.cnpj);
      return erro(c) ? c : { action, cnpj: c };
    }

    case "empresa_criar": {
      const c = cnpjTexto(b.cnpj);
      if (erro(c)) return c;
      const adm = email(b.admin_email, "admin_email");
      if (erro(adm)) return adm;
      const n = b.nome === undefined || b.nome === null ? null : nome(b.nome);
      if (erro(n)) return n;
      const s = b.slug === undefined || b.slug === null ? null : slug(b.slug);
      if (erro(s)) return s;
      const t = b.tipo === undefined ? "cliente" : tipo(b.tipo);
      if (!t) return { error: `'tipo' deve ser um de: ${TIPOS_EMPRESA.join(", ")}.` };
      return { action, cnpj: c, admin_email: adm, nome: n, slug: s, tipo: t };
    }

    case "empresa_atualizar": {
      const t = tenant();
      if (erro(t)) return t;
      const out: Extract<Acao, { action: "empresa_atualizar" }> = { action, tenant_id: t };
      if (b.nome !== undefined) {
        const n = nome(b.nome);
        if (erro(n)) return n;
        out.nome = n;
      }
      if (b.cnpj !== undefined) {
        const c = cnpjTexto(b.cnpj);
        if (erro(c)) return c;
        out.cnpj = c;
      }
      if (b.ativo !== undefined) {
        if (typeof b.ativo !== "boolean") return { error: "'ativo' deve ser booleano." };
        out.ativo = b.ativo;
      }
      if (out.nome === undefined && out.cnpj === undefined && out.ativo === undefined) {
        return { error: "Informe ao menos um campo: 'nome', 'cnpj' ou 'ativo'." };
      }
      return out;
    }

    case "membros_listar":
    case "dados_restritos_obter": {
      const t = tenant();
      return erro(t) ? t : { action, tenant_id: t };
    }

    case "membro_adicionar": {
      const t = tenant();
      if (erro(t)) return t;
      const e = email(b.email, "email");
      if (erro(e)) return e;
      const p = papel(b.papel);
      if (!p) return { error: `'papel' deve ser um de: ${PAPEIS.join(", ")}.` };
      return { action, tenant_id: t, email: e, papel: p };
    }

    case "membro_atualizar": {
      const t = tenant();
      if (erro(t)) return t;
      if (typeof b.user_id !== "string" || !UUID.test(b.user_id)) return { error: "'user_id' deve ser um UUID." };
      const out: Extract<Acao, { action: "membro_atualizar" }> = { action, tenant_id: t, user_id: b.user_id.toLowerCase() };
      if (b.papel !== undefined) {
        const p = papel(b.papel);
        if (!p) return { error: `'papel' deve ser um de: ${PAPEIS.join(", ")}.` };
        out.papel = p;
      }
      if (b.ativo !== undefined) {
        if (typeof b.ativo !== "boolean") return { error: "'ativo' deve ser booleano." };
        out.ativo = b.ativo;
      }
      if (out.papel === undefined && out.ativo === undefined) return { error: "Informe 'papel' ou 'ativo'." };
      return out;
    }

    case "dados_restritos_salvar": {
      const t = tenant();
      if (erro(t)) return t;
      const campos: Extract<Acao, { action: "dados_restritos_salvar" }>["campos"] = {};
      for (const campo of ["banco", "agencia", "conta"] as const) {
        if (b[campo] === undefined) continue;
        const v = bancario(b[campo], campo);
        if (erro(v)) return v;
        campos[campo] = v;
      }
      if (Object.keys(campos).length === 0) return { error: "Informe ao menos um campo: 'banco', 'agencia' ou 'conta'." };
      return { action, tenant_id: t, campos };
    }

    default:
      return {
        error: "Parâmetro 'action' inválido. Use: minha_empresa, cnpj_consultar, empresa_criar, empresa_atualizar, " +
          "membros_listar, membro_adicionar, membro_atualizar, dados_restritos_obter, dados_restritos_salvar.",
      };
  }
}
