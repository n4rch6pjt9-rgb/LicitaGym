import type { CatmatRepo, RegraInput } from "./repo.ts";
import { obterArvore, type TreeDeps } from "./tree.ts";
import type { CatmatEstado, CatmatNo, CatmatNoAnotado, CatmatRegra, NivelRegra } from "./types.ts";

/** Erro de negócio com status HTTP. */
export class ErroCatalogo extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function chaveDo(nivel: NivelRegra, codigo: number): string {
  return `${nivel}:${codigo}`;
}

/** Chaves dos ancestrais de um nó, do mais específico para o mais geral. */
function chavesAncestrais(no: Pick<CatmatNo, "nivel" | "codigo_grupo" | "codigo_classe" | "codigo_pdm">): string[] {
  const out: string[] = [];
  if (no.nivel === "item" && no.codigo_pdm !== null) out.push(chaveDo("pdm", no.codigo_pdm));
  if ((no.nivel === "item" || no.nivel === "pdm") && no.codigo_classe !== null) out.push(chaveDo("classe", no.codigo_classe));
  if (no.nivel !== "grupo") out.push(chaveDo("grupo", no.codigo_grupo));
  return out;
}

/**
 * Estado de um nó no catálogo. A regra do próprio nó vence; senão vale a do ancestral mais próximo.
 *   incluido / excluido: regra no próprio nó
 *   herdado / excluido_herdado: regra num ancestral
 */
export function estadoDoNo(
  no: Pick<CatmatNo, "nivel" | "codigo" | "codigo_grupo" | "codigo_classe" | "codigo_pdm">,
  regrasPorChave: Map<string, CatmatRegra>,
): { estado: CatmatEstado; regra_id: number | null; origem_nivel: NivelRegra | null } {
  const propria = regrasPorChave.get(chaveDo(no.nivel, no.codigo));
  if (propria) {
    return { estado: propria.incluido ? "incluido" : "excluido", regra_id: propria.id, origem_nivel: propria.nivel };
  }
  for (const chave of chavesAncestrais(no)) {
    const r = regrasPorChave.get(chave);
    if (r) return { estado: r.incluido ? "herdado" : "excluido_herdado", regra_id: r.id, origem_nivel: r.nivel };
  }
  return { estado: "nenhum", regra_id: null, origem_nivel: null };
}

export function indexarRegras(regras: CatmatRegra[]): Map<string, CatmatRegra> {
  return new Map(regras.map((r) => [r.chave, r]));
}

export function anotar(nos: CatmatNo[], regras: CatmatRegra[]): CatmatNoAnotado[] {
  const idx = indexarRegras(regras);
  return nos.map((no) => ({ ...no, ...estadoDoNo(no, idx) }));
}

/** Localiza o nó na árvore do Compras.gov (valida existência) e devolve também o nó do grupo. */
async function localizarNo(
  deps: TreeDeps,
  alvo: { nivel: NivelRegra; codigo_grupo: number; codigo_classe: number | null; codigo_pdm: number | null; codigo_item: number | null },
): Promise<{ no: CatmatNo; grupo: CatmatNo; classe: CatmatNo | null; pdm: CatmatNo | null }> {
  const acha = (nos: CatmatNo[], codigo: number | null, rotulo: string) => {
    const no = nos.find((n) => n.codigo === codigo);
    if (!no) throw new ErroCatalogo(404, `${rotulo} ${codigo} não encontrado no Compras.gov.`);
    return no;
  };
  const grupo = acha((await obterArvore(deps, "grupos", alvo.codigo_grupo)).nos, alvo.codigo_grupo, "Grupo");
  if (alvo.nivel === "grupo") return { no: grupo, grupo, classe: null, pdm: null };

  const classe = acha((await obterArvore(deps, "classes", alvo.codigo_grupo)).nos, alvo.codigo_classe, "Classe");
  if (alvo.nivel === "classe") return { no: classe, grupo, classe, pdm: null };

  const pdm = acha((await obterArvore(deps, "pdms", alvo.codigo_classe as number)).nos, alvo.codigo_pdm, "PDM");
  if (alvo.nivel === "pdm") return { no: pdm, grupo, classe, pdm };

  const item = acha((await obterArvore(deps, "itens", alvo.codigo_pdm as number)).nos, alvo.codigo_item, "Item");
  return { no: item, grupo, classe, pdm };
}

async function gravarGrupo(repo: CatmatRepo, g: CatmatNo) {
  await repo.upsertGrupo({ codigo_grupo: g.codigo_grupo, nome: g.nome, status: g.ativo, data_atualizacao_origem: null });
}
async function gravarClasse(repo: CatmatRepo, c: CatmatNo) {
  await repo.upsertClasse({
    codigo_grupo: c.codigo_grupo, codigo_classe: c.codigo_classe as number, nome: c.nome, status: c.ativo, data_atualizacao_origem: null,
  });
}
async function gravarPdm(repo: CatmatRepo, p: CatmatNo) {
  await repo.upsertPdm({
    codigo_pdm: p.codigo_pdm as number, codigo_grupo: p.codigo_grupo, codigo_classe: p.codigo_classe as number,
    nome_pdm: p.nome, status: p.ativo, data_atualizacao_origem: null,
  });
}
function paraItemPdm(i: CatmatNo) {
  return {
    codigo_item: i.codigo_item as number, codigo_pdm: i.codigo_pdm as number, codigo_classe: i.codigo_classe as number,
    codigo_grupo: i.codigo_grupo, descricao: i.nome, status_item: i.ativo,
  };
}

/**
 * Registra (incluido=true) ou exclui (incluido=false) um nó do catálogo.
 * - valida o nó no Compras.gov
 * - grava os ancestrais em catmat_grupos/classes/pdms (FKs e nomes para o filtro)
 * - grupo/classe incluídos: materializa os PDMs descendentes (a herança só expande sobre catmat_pdms)
 * - PDM/item: hidrata catmat_item_pdm (casamento por código)
 * - exclusão só vale para nó herdado de um ancestral incluído
 */
export async function salvarRegra(
  deps: TreeDeps,
  userId: string,
  alvo: { nivel: NivelRegra; codigo_grupo: number; codigo_classe: number | null; codigo_pdm: number | null; codigo_item: number | null; incluido: boolean; observacao: string | null },
): Promise<{ regra: CatmatRegra; criada: boolean; pdms_materializados: number; itens_hidratados: number }> {
  const { repo } = deps;
  const { no, grupo, classe, pdm } = await localizarNo(deps, alvo);

  const regras = await repo.listarRegras();
  const idx = indexarRegras(regras);
  const chave = chaveDo(alvo.nivel, no.codigo);
  if (!alvo.incluido) {
    const semPropria = new Map(idx);
    semPropria.delete(chave);
    const { estado } = estadoDoNo(no, semPropria);
    if (estado !== "herdado") {
      throw new ErroCatalogo(409, "Só dá para excluir um nó que herda o registro de um nível acima.");
    }
  }

  await gravarGrupo(repo, grupo);
  if (classe) await gravarClasse(repo, classe);
  if (pdm) await gravarPdm(repo, pdm);

  let pdmsMaterializados = 0;
  let itensHidratados = 0;
  if (alvo.incluido && (alvo.nivel === "grupo" || alvo.nivel === "classe")) {
    const classes = alvo.nivel === "grupo" ? (await obterArvore(deps, "classes", alvo.codigo_grupo)).nos : [classe as CatmatNo];
    for (const c of classes) {
      if (alvo.nivel === "grupo") await gravarClasse(repo, c);
      for (const p of (await obterArvore(deps, "pdms", c.codigo_classe as number)).nos) {
        await gravarPdm(repo, p);
        pdmsMaterializados++;
      }
    }
  }
  if (alvo.nivel === "pdm" || alvo.nivel === "item") {
    const itens = (await obterArvore(deps, "itens", alvo.codigo_pdm as number)).nos;
    await repo.upsertItensPdm(itens.map(paraItemPdm));
    itensHidratados = itens.length;
  }

  const row: RegraInput = {
    nivel: alvo.nivel,
    codigo_grupo: no.codigo_grupo,
    codigo_classe: no.codigo_classe,
    codigo_pdm: no.codigo_pdm,
    codigo_item: no.codigo_item,
    nome_snapshot: no.nome,
    ancestrais_snapshot: {
      nome_grupo: grupo.nome,
      nome_classe: classe?.nome ?? null,
      nome_pdm: pdm?.nome ?? null,
    },
    incluido: alvo.incluido,
    observacao: alvo.observacao,
  };
  const existente = idx.get(chave);
  const regra = existente
    ? await repo.atualizarRegra(existente.id, row, userId)
    : await repo.inserirRegra(row, userId);
  return { regra, criada: !existente, pdms_materializados: pdmsMaterializados, itens_hidratados: itensHidratados };
}

export async function removerRegra(repo: CatmatRepo, id: number): Promise<CatmatRegra> {
  const regra = await repo.obterRegra(id);
  if (!regra) throw new ErroCatalogo(404, "Regra não encontrada.");
  await repo.removerRegra(id);
  return regra;
}

/**
 * Regras + opções prontas para o filtro em cascata (Grupo -> Classe -> PDM -> Item), com nomes.
 * PDMs: os efetivos do catálogo (herança e exclusões aplicadas). Itens: os avulsos e os hidratados dos PDMs efetivos.
 */
export async function listarCatalogo(repo: CatmatRepo, limiteItens = 2000) {
  const regras = await repo.listarRegras();
  const efetivos = await repo.pdmsEfetivos();
  const avulsos = regras.filter((r) => r.nivel === "item" && r.incluido);
  const excluidosItem = new Set(regras.filter((r) => r.nivel === "item" && !r.incluido).map((r) => r.codigo_item));

  const codPdms = [...new Set([...efetivos.map((e) => e.codigo_pdm), ...avulsos.map((a) => a.codigo_pdm as number)])];
  const codClasses = [...new Set([...efetivos.map((e) => e.codigo_classe), ...avulsos.map((a) => a.codigo_classe as number)])];
  const codGrupos = [...new Set([...efetivos.map((e) => e.codigo_grupo), ...avulsos.map((a) => a.codigo_grupo)])];

  const [grupos, classes, pdms, itensHidratados, palavras] = await Promise.all([
    repo.nomesGrupos(codGrupos),
    repo.nomesClasses(codClasses),
    repo.nomesPdms(codPdms),
    repo.itensDosPdms(efetivos.map((e) => e.codigo_pdm), limiteItens),
    repo.contarPalavrasPorPdm(codPdms),
  ]);

  const itens = new Map<number, { codigo: number; nome: string; codigo_pai: number }>();
  for (const i of itensHidratados) {
    if (!excluidosItem.has(i.codigo_item)) itens.set(i.codigo_item, { codigo: i.codigo_item, nome: i.descricao ?? String(i.codigo_item), codigo_pai: i.codigo_pdm });
  }
  for (const a of avulsos) {
    itens.set(a.codigo_item as number, { codigo: a.codigo_item as number, nome: a.nome_snapshot, codigo_pai: a.codigo_pdm as number });
  }

  const porNome = <T extends { nome: string }>(xs: T[]) => [...xs].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return {
    regras,
    resumo: {
      regras: regras.length,
      exclusoes: regras.filter((r) => !r.incluido).length,
      pdms_efetivos: codPdms.length,
      pdms_sem_palavras: codPdms.filter((c) => !palavras.get(c)).length,
      itens_opcoes: itens.size,
      itens_truncados: itensHidratados.length >= limiteItens,
    },
    opcoes: {
      grupos: porNome(grupos),
      classes: porNome(classes),
      pdms: porNome(pdms).map((p) => ({ ...p, palavras: palavras.get(p.codigo) ?? 0 })),
      itens: [...itens.values()].sort((a, b) => a.codigo - b.codigo),
    },
  };
}

export async function salvarPalavra(
  repo: CatmatRepo,
  userId: string,
  p: { id: number | null; codigo_pdm: number; padrao: string; ativo: boolean },
) {
  if (!(await repo.regexValido(p.padrao))) {
    throw new ErroCatalogo(400, "Padrão inválido no dialeto de regex do Postgres (ou maior que 300 caracteres).");
  }
  if (p.id !== null) {
    const atual = await repo.obterPalavra(p.id);
    if (!atual) throw new ErroCatalogo(404, "Padrão não encontrado.");
    if (atual.codigo_pdm !== p.codigo_pdm) throw new ErroCatalogo(400, "O padrão pertence a outro PDM.");
    return await repo.atualizarPalavra(p.id, p.padrao, p.ativo, userId);
  }
  if (!(await repo.pdmExiste(p.codigo_pdm))) {
    throw new ErroCatalogo(409, "Registre o PDM no catálogo antes de cadastrar padrões para ele.");
  }
  return await repo.inserirPalavra(p.codigo_pdm, p.padrao, p.ativo, userId);
}
