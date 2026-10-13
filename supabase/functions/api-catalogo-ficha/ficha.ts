/** Validação da ficha lida no navegador. O HTML cru não chega aqui. */

export class ErroFicha extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ErroFicha";
  }
}

const MARCA_POR_HOST: Record<string, string> = {
  "konnenfitness.com.br": "Konnen",
  "www.konnenfitness.com.br": "Konnen",
};

const CODIGO = /^[A-Za-z][A-Za-z0-9._-]{1,39}$/;

export interface Destaque {
  titulo: string;
  texto: string;
}

export interface FichaEntrada {
  nome: string;
  codigo: string;
  url: string;
  marca: string;
  categorias: string[];
  familia: string | null;
  medidas: string | null;
  destaques: Destaque[];
  imagens: string[];
  postId: string | null;
  descricao: string | null;
}

export interface ProdutoExistente {
  id: number;
  tenant_id: number | null;
  codigo: string | null;
  url: string | null;
  atributos: Record<string, unknown>;
  descricao: string | null;
}

export interface LinhaProduto {
  marca: string;
  codigo: string;
  nome: string;
  url: string;
  tenant_id: number;
  categorias: string[];
  familia_equipamento: string | null;
  descricao: string | null;
  atributos: Record<string, unknown>;
  ativo: true;
  last_seen_at: string;
}

export interface PlanoGravacao {
  id: number | null;
  linha: LinhaProduto;
}

function texto(valor: unknown, max: number, campo: string): string {
  if (typeof valor !== "string") throw new ErroFicha(`${campo} ausente.`, 400);
  const limpo = valor.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!limpo || limpo.includes("<") || limpo.includes(">")) {
    throw new ErroFicha(`${campo} inválido.`, 400);
  }
  if (limpo.length > max) throw new ErroFicha(`${campo} passa de ${max} caracteres.`, 400);
  return limpo;
}

function opcional(valor: unknown, max: number, campo: string): string | null {
  if (valor === null || valor === undefined || valor === "") return null;
  return texto(valor, max, campo);
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function familiaDe(categorias: string[]): string | null {
  for (const categoria of categorias) {
    const n = semAcento(categoria);
    if (n === "cardio" || n === "esteiras") return "cardio";
    if (
      n === "musculacao" || n === "baterias de peso" || n === "articulados" ||
      n === "bancos e racks" || n === "estacoes e cross"
    ) return "musculacao";
    if (n === "acessorios") return "acessorio";
  }
  return null;
}

function urlHttps(bruto: unknown, campo: string): URL {
  if (typeof bruto !== "string" || bruto.length > 500) throw new ErroFicha(`${campo} inválida.`, 400);
  let url: URL;
  try {
    url = new URL(bruto.trim());
  } catch {
    throw new ErroFicha(`${campo} inválida.`, 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ErroFicha(`${campo} precisa ser https, sem usuário nem senha.`, 400);
  }
  return url;
}

function canonica(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "") + "/";
  return `${url.origin}${path}`;
}

export function validarFicha(body: Record<string, unknown>): FichaEntrada {
  if (body.action !== "gravar") throw new ErroFicha("Ação desconhecida.", 400);
  const pagina = urlHttps(body.url, "URL");
  const marca = MARCA_POR_HOST[pagina.hostname.toLowerCase()];
  if (!marca) {
    throw new ErroFicha("O site desta página ainda não está liberado para gravar no catálogo.", 400);
  }
  const codigo = texto(body.codigo, 40, "Código");
  if (!CODIGO.test(codigo) || !/\d/.test(codigo)) throw new ErroFicha("Código inválido.", 400);
  const nome = texto(body.nome, 200, "Nome");
  const categorias = listaTexto(body.categorias, 6, 60, "Categoria");
  const destaques = listaDestaques(body.destaques);
  const imagens = listaImagens(body.imagens, pagina.hostname.toLowerCase());
  const medidas = opcional(body.medidas, 80, "Medidas");
  const postId = opcional(body.post_id, 12, "Post");
  if (postId !== null && !/^\d+$/.test(postId)) throw new ErroFicha("Post inválido.", 400);
  const descricao = destaques.length
    ? destaques.map((d) => (d.titulo ? `${d.titulo}. ${d.texto}` : d.texto)).join("\n").slice(0, 4000)
    : null;
  return {
    nome,
    codigo,
    url: canonica(pagina),
    marca,
    categorias,
    familia: familiaDe(categorias),
    medidas,
    destaques,
    imagens,
    postId,
    descricao,
  };
}

function listaTexto(valor: unknown, maxItens: number, maxItem: number, campo: string): string[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > maxItens) throw new ErroFicha(`${campo} inválida.`, 400);
  return valor.map((item) => texto(item, maxItem, campo));
}

function listaDestaques(valor: unknown): Destaque[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > 8) throw new ErroFicha("Destaques inválidos.", 400);
  return valor.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ErroFicha("Destaque inválido.", 400);
    }
    const bruto = item as Record<string, unknown>;
    return {
      titulo: opcional(bruto.titulo, 120, "Título do destaque") ?? "",
      texto: texto(bruto.texto, 600, "Texto do destaque"),
    };
  });
}

function listaImagens(valor: unknown, hostPagina: string): string[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > 2) throw new ErroFicha("Imagens inválidas.", 400);
  const hosts = new Set([hostPagina, hostPagina.replace(/^www\./, ""), `www.${hostPagina.replace(/^www\./, "")}`]);
  return valor.map((item) => {
    const url = urlHttps(item, "Imagem");
    if (!hosts.has(url.hostname.toLowerCase())) throw new ErroFicha("Imagem fora do site do produto.", 400);
    return url.toString().slice(0, 500);
  });
}

export function planejar(
  tenantId: number,
  entrada: FichaEntrada,
  porUrl: ProdutoExistente | null,
  porCodigo: ProdutoExistente | null,
  agora: string,
): PlanoGravacao {
  if (porUrl && porUrl.tenant_id !== null && porUrl.tenant_id !== tenantId) {
    throw new ErroFicha("Esta página já está no catálogo de outra empresa.", 409);
  }
  if (porUrl && porCodigo && porUrl.id !== porCodigo.id) {
    throw new ErroFicha("O código e a URL apontam para produtos diferentes desta empresa.", 409);
  }
  if (!porUrl && porCodigo && porCodigo.url && porCodigo.url !== entrada.url) {
    throw new ErroFicha("Este código já está gravado com outra página.", 409);
  }
  const existente = porUrl ?? porCodigo;
  const anteriores = existente && typeof existente.atributos === "object" && existente.atributos
    ? existente.atributos
    : {};
  const atributos: Record<string, unknown> = {
    ...anteriores,
    origem: "html",
    post_id: entrada.postId,
    imagens: entrada.imagens,
    destaques: entrada.destaques,
  };
  if (entrada.medidas) atributos.medida = entrada.medidas;
  return {
    id: existente?.id ?? null,
    linha: {
      marca: entrada.marca,
      codigo: entrada.codigo,
      nome: entrada.nome,
      url: entrada.url,
      tenant_id: tenantId,
      categorias: entrada.categorias,
      familia_equipamento: entrada.familia,
      descricao: entrada.descricao ?? existente?.descricao ?? null,
      atributos,
      ativo: true,
      last_seen_at: agora,
    },
  };
}
