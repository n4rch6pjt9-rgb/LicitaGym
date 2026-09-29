import type { ActionParams, NivelArvore, NivelRegra } from "./types.ts";

const NIVEIS_ARVORE: readonly NivelArvore[] = ["grupos", "classes", "pdms", "itens"];
const NIVEIS_REGRA: readonly NivelRegra[] = ["grupo", "classe", "pdm", "item"];

/** Códigos CATMAT: inteiros positivos (grupo 2 dígitos, classe 4, PDM e item até 9). */
function codigo(valor: unknown, campo: string, obrigatorio: boolean): number | null | { error: string } {
  if (valor === undefined || valor === null || valor === "") {
    return obrigatorio ? { error: `Parâmetro '${campo}' é obrigatório.` } : null;
  }
  const n = typeof valor === "number" ? valor : (typeof valor === "string" && /^\d+$/.test(valor.trim()) ? Number(valor) : NaN);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 999_999_999) {
    return { error: `Parâmetro '${campo}' deve ser um código inteiro positivo.` };
  }
  return n;
}

function booleano(valor: unknown, padrao: boolean): boolean {
  if (valor === undefined || valor === null) return padrao;
  return valor === true || valor === "true" || valor === 1 || valor === "1";
}

function isErro(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

export function parseActionFromBody(body: Record<string, unknown>): ActionParams | { error: string } {
  const action = body.action;

  switch (action) {
    case "arvore": {
      const nivel = body.nivel as NivelArvore;
      if (!NIVEIS_ARVORE.includes(nivel)) {
        return { error: "Parâmetro 'nivel' deve ser grupos, classes, pdms ou itens." };
      }
      const c = codigo(body.codigo, "codigo", true);
      if (isErro(c)) return c;
      return {
        action,
        nivel,
        codigo: c as number,
        incluir_inativos: booleano(body.incluir_inativos, false),
        refresh: booleano(body.refresh, false),
      };
    }

    case "catalogo_listar":
      return { action };

    case "catalogo_salvar": {
      const nivel = body.nivel as NivelRegra;
      if (!NIVEIS_REGRA.includes(nivel)) {
        return { error: "Parâmetro 'nivel' deve ser grupo, classe, pdm ou item." };
      }
      const exige = { classe: nivel !== "grupo", pdm: nivel === "pdm" || nivel === "item", item: nivel === "item" };
      const g = codigo(body.codigo_grupo, "codigo_grupo", true);
      if (isErro(g)) return g;
      const c = codigo(body.codigo_classe, "codigo_classe", exige.classe);
      if (isErro(c)) return c;
      const p = codigo(body.codigo_pdm, "codigo_pdm", exige.pdm);
      if (isErro(p)) return p;
      const i = codigo(body.codigo_item, "codigo_item", exige.item);
      if (isErro(i)) return i;
      if (typeof body.incluido !== "boolean") {
        return { error: "Parâmetro 'incluido' deve ser true (registrar) ou false (excluir nó herdado)." };
      }
      const obs = body.observacao;
      if (obs !== undefined && obs !== null && (typeof obs !== "string" || obs.length > 500)) {
        return { error: "Parâmetro 'observacao' deve ser texto de até 500 caracteres." };
      }
      return {
        action,
        nivel,
        codigo_grupo: g as number,
        codigo_classe: exige.classe ? c as number : null,
        codigo_pdm: exige.pdm ? p as number : null,
        codigo_item: exige.item ? i as number : null,
        incluido: body.incluido,
        observacao: typeof obs === "string" && obs.trim() ? obs.trim() : null,
      };
    }

    case "catalogo_remover":
    case "palavras_remover": {
      const id = codigo(body.id, "id", true);
      if (isErro(id)) return id;
      return { action, id: id as number };
    }

    case "palavras_listar": {
      const p = codigo(body.codigo_pdm, "codigo_pdm", true);
      if (isErro(p)) return p;
      return { action, codigo_pdm: p as number };
    }

    case "palavras_salvar": {
      const p = codigo(body.codigo_pdm, "codigo_pdm", true);
      if (isErro(p)) return p;
      const id = codigo(body.id, "id", false);
      if (isErro(id)) return id;
      const padrao = typeof body.padrao === "string" ? body.padrao.trim() : "";
      if (!padrao || padrao.length > 300) {
        return { error: "Parâmetro 'padrao' é obrigatório e deve ter até 300 caracteres." };
      }
      return { action, id: id as number | null, codigo_pdm: p as number, padrao, ativo: booleano(body.ativo, true) };
    }

    default:
      return { error: "Ação não suportada." };
  }
}
