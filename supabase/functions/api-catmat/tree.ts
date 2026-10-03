import type { ClasseMaterial, ComprasGovPage, GrupoMaterial, ItemMaterial, PdmMaterial } from "../_shared/compras-gov/material-types.ts";
import type { CatmatRepo } from "./repo.ts";
import type { CatmatNo, NivelArvore } from "./types.ts";

const BASE_URL = "https://dadosabertos.compras.gov.br";
/** Mesmo padrão do sync: COMPRAS_GOV_PAGE_SIZE.default em material-client.ts. */
const TAMANHO_PAGINA = 100;
const MAX_PAGINAS = 20;
const TIMEOUT_CHAMADA_MS = 8_000;
const ORCAMENTO_TOTAL_MS = 25_000;
const ATRASO_ENTRE_PAGINAS_MS = 350;
const TTL_MEMORIA_MS = 10 * 60_000;
const TTL_BANCO_MS = 24 * 60 * 60_000;

/** Endpoint e parâmetro de filtro por nível (o código é o do nó pai; em 'grupos' é o próprio grupo). */
const ENDPOINTS: Record<NivelArvore, { path: string; param: string }> = {
  grupos: { path: "/modulo-material/1_consultarGrupoMaterial", param: "codigoGrupo" },
  classes: { path: "/modulo-material/2_consultarClasseMaterial", param: "codigoGrupo" },
  pdms: { path: "/modulo-material/3_consultarPdmMaterial", param: "codigoClasse" },
  itens: { path: "/modulo-material/4_consultarItemMaterial", param: "codigoPdm" },
};

export class ComprasGovIndisponivel extends Error {}

export interface ArvoreResultado {
  nos: CatmatNo[];
  fonte: "memoria" | "banco" | "compras.gov";
  stale: boolean;
}

export interface TreeDeps {
  repo: CatmatRepo;
  fetchFn?: typeof fetch;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

type Entrada = { nos: CatmatNo[]; expira: number };
const memoria = new Map<string, Entrada>();
const emAndamento = new Map<string, Promise<ArvoreResultado>>();

/** Só para testes. */
export function limparCacheMemoria(): void {
  memoria.clear();
  emAndamento.clear();
}

export function chaveCache(nivel: NivelArvore, codigo: number): string {
  return `${nivel}:${codigo}`;
}

function paraNo(nivel: NivelArvore, r: Record<string, unknown>): CatmatNo | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null));
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const grupo = n(r.codigoGrupo);
  if (grupo === null) return null;
  switch (nivel) {
    case "grupos": {
      const g = r as unknown as GrupoMaterial;
      return {
        nivel: "grupo", codigo: grupo, nome: s(g.nomeGrupo) ?? String(grupo), ativo: g.statusGrupo !== false,
        codigo_grupo: grupo, codigo_classe: null, codigo_pdm: null, codigo_item: null,
        nome_grupo: s(g.nomeGrupo), nome_classe: null, nome_pdm: null,
      };
    }
    case "classes": {
      const c = r as unknown as ClasseMaterial;
      const classe = n(c.codigoClasse);
      if (classe === null) return null;
      return {
        nivel: "classe", codigo: classe, nome: s(c.nomeClasse) ?? String(classe), ativo: c.statusClasse !== false,
        codigo_grupo: grupo, codigo_classe: classe, codigo_pdm: null, codigo_item: null,
        nome_grupo: s(c.nomeGrupo), nome_classe: s(c.nomeClasse), nome_pdm: null,
      };
    }
    case "pdms": {
      const p = r as unknown as PdmMaterial;
      const classe = n(p.codigoClasse);
      const pdm = n(p.codigoPdm);
      if (classe === null || pdm === null) return null;
      return {
        nivel: "pdm", codigo: pdm, nome: s(p.nomePdm) ?? String(pdm), ativo: p.statusPdm !== false,
        codigo_grupo: grupo, codigo_classe: classe, codigo_pdm: pdm, codigo_item: null,
        nome_grupo: s(p.nomeGrupo), nome_classe: s(p.nomeClasse), nome_pdm: s(p.nomePdm),
      };
    }
    case "itens": {
      const i = r as unknown as ItemMaterial;
      const classe = n(i.codigoClasse);
      const pdm = n(i.codigoPdm);
      const item = n(i.codigoItem);
      if (classe === null || pdm === null || item === null) return null;
      return {
        nivel: "item", codigo: item, nome: s(i.descricaoItem) ?? String(item), ativo: i.statusItem !== false,
        codigo_grupo: grupo, codigo_classe: classe, codigo_pdm: pdm, codigo_item: item,
        nome_grupo: s(i.nomeGrupo), nome_classe: s(i.nomeClasse), nome_pdm: s(i.nomePdm),
      };
    }
  }
}

async function buscarPagina(
  deps: TreeDeps,
  nivel: NivelArvore,
  codigo: number,
  pagina: number,
  prazo: number,
): Promise<ComprasGovPage<Record<string, unknown>>> {
  const { path, param } = ENDPOINTS[nivel];
  const url = new URL(path, BASE_URL);
  url.searchParams.set(param, String(codigo));
  url.searchParams.set("pagina", String(pagina));
  url.searchParams.set("tamanhoPagina", String(TAMANHO_PAGINA));
  const fetchFn = deps.fetchFn ?? fetch;
  const agora = deps.agora ?? Date.now;

  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const restante = prazo - agora();
    if (restante <= 0) break;
    try {
      const res = await fetchFn(url.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(TIMEOUT_CHAMADA_MS, restante)),
      });
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        ultimoErro = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new ComprasGovIndisponivel(`Compras.gov HTTP ${res.status}`);
      }
      const texto = await res.text();
      return texto.trim()
        ? JSON.parse(texto) as ComprasGovPage<Record<string, unknown>>
        : { resultado: [], totalRegistros: 0, totalPaginas: 0, paginasRestantes: 0 };
    } catch (e) {
      if (e instanceof ComprasGovIndisponivel) throw e;
      ultimoErro = e;
    }
  }
  throw new ComprasGovIndisponivel(`Compras.gov indisponível: ${(ultimoErro as Error)?.message ?? "tempo esgotado"}`);
}

async function buscarNoComprasGov(deps: TreeDeps, nivel: NivelArvore, codigo: number): Promise<CatmatNo[]> {
  const agora = deps.agora ?? Date.now;
  const dormir = deps.dormir ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const prazo = agora() + ORCAMENTO_TOTAL_MS;
  const nos: CatmatNo[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const body = await buscarPagina(deps, nivel, codigo, pagina, prazo);
    for (const r of body.resultado ?? []) {
      const no = paraNo(nivel, r);
      if (no) nos.push(no);
    }
    if (!body.paginasRestantes || (body.resultado?.length ?? 0) === 0) break;
    await dormir(ATRASO_ENTRE_PAGINAS_MS);
  }
  const vistos = new Set<number>();
  return nos
    .filter((no) => (vistos.has(no.codigo) ? false : (vistos.add(no.codigo), true)))
    .sort((a, b) => (a.nivel === "item" ? a.codigo - b.codigo : a.nome.localeCompare(b.nome, "pt-BR")));
}

/**
 * Filhos de um nó (ou o próprio grupo, em 'grupos'), com todos os status. Ordem de busca:
 * memória (10 min) -> banco (24 h) -> Compras.gov. Se o Compras.gov falhar, devolve o cache vencido com stale=true.
 * Resultado vazio não é guardado em cache.
 * Pedidos iguais simultâneos compartilham a mesma busca.
 */
export async function obterArvore(
  deps: TreeDeps,
  nivel: NivelArvore,
  codigo: number,
  opcoes: { refresh?: boolean } = {},
): Promise<ArvoreResultado> {
  const chave = chaveCache(nivel, codigo);
  const agora = (deps.agora ?? Date.now)();

  if (!opcoes.refresh) {
    const m = memoria.get(chave);
    if (m && m.expira > agora) return { nos: m.nos, fonte: "memoria", stale: false };
  }

  const pendente = emAndamento.get(chave);
  if (pendente) return await pendente;

  const busca = (async (): Promise<ArvoreResultado> => {
    const banco = await deps.repo.cacheLer(chave);
    if (!opcoes.refresh && banco && new Date(banco.expira_em).getTime() > agora) {
      const nos = banco.payload as CatmatNo[];
      memoria.set(chave, { nos, expira: agora + TTL_MEMORIA_MS });
      return { nos, fonte: "banco", stale: false };
    }
    try {
      const nos = await buscarNoComprasGov(deps, nivel, codigo);
      // Lista vazia não vai para o cache: código inexistente não ocupa o banco e um nó novo aparece na hora
      if (nos.length > 0) {
        memoria.set(chave, { nos, expira: agora + TTL_MEMORIA_MS });
        await deps.repo.cacheGravar(chave, nos, nos.length, new Date(agora + TTL_BANCO_MS));
      }
      return { nos, fonte: "compras.gov", stale: false };
    } catch (e) {
      if (banco) return { nos: banco.payload as CatmatNo[], fonte: "banco", stale: true };
      throw e;
    }
  })();

  emAndamento.set(chave, busca);
  try {
    return await busca;
  } finally {
    emAndamento.delete(chave);
  }
}
