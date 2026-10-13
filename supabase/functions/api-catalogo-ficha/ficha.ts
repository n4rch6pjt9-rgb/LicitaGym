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
const MAX_IMAGENS_FICHA = 12;

export interface Destaque {
  titulo: string;
  texto: string;
}

export interface Especificacao {
  rotulo: string;
  valor: string;
}

export interface AtributoFicha {
  atributo: string;
  valor_texto: string;
  valor_num: number | null;
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
  especificacoes: Especificacao[];
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
  no_taxonomia?: string | null;
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
  no_taxonomia?: string;
  carga_maxima_kg?: number;
  peso_equipamento_kg?: number;
}

export interface PlanoGravacao {
  id: number | null;
  linha: LinhaProduto;
  atributosFicha: AtributoFicha[];
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
  if (!codigoDeFabricante(codigo)) throw new ErroFicha("Código inválido.", 400);
  const nome = texto(body.nome, 200, "Nome");
  const categorias = listaTexto(body.categorias, 6, 60, "Categoria");
  const destaques = listaDestaques(body.destaques);
  const imagens = listaImagens(body.imagens, pagina.hostname.toLowerCase());
  const medidas = opcional(body.medidas, 80, "Medidas");
  const especificacoes = listaEspecificacoes(body.especificacoes);
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
    especificacoes,
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

function listaEspecificacoes(valor: unknown): Especificacao[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > 20) throw new ErroFicha("Especificações inválidas.", 400);
  return valor.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ErroFicha("Especificação inválida.", 400);
    }
    const bruto = item as Record<string, unknown>;
    return {
      rotulo: texto(bruto.rotulo, 80, "Rótulo da especificação"),
      valor: texto(bruto.valor, 120, "Valor da especificação"),
    };
  });
}

/**
 * Taxonomia da esteira pelo dicionário v0.3 (services/coletor-externo/coletor/data/dicionario-aparelhos-v0.3.json):
 * o slug é o mesmo que o coletor grava em catalogo_produtos.no_taxonomia e que licitacao_itens, taxonomia_no_pdm,
 * ontologia_atributos e catalogo_de_para usam. As regras são as do dicionário: "esteira" sozinha é ambígua
 * (ambiguos.esteira); refino "curva|nao eletric|sem motor|manual" leva a esteira_nao_eletrica; só vira
 * esteira_eletrica com evidência de "motor|velocidade|inclinacao|programas de treino|km/h|hp". Sem evidência, null:
 * "esteira de yoga" é colchonete, não esteira.
 */
const ESTEIRA_NAO_ELETRICA = /\b(curva|nao eletric\w*|sem motor|mecanic[ao]|magnetic[ao]|manual)\b|curved treadmill/;
const ESTEIRA_ELETRICA_EVIDENCIA = /motor|velocidade|inclinacao|programas? de treino|km\s*\/\s*h|\bp?hp\b/;

export function noTaxonomiaDe(nome: string, evidencia = ""): "esteira_eletrica" | "esteira_nao_eletrica" | null {
  const n = semAcento(nome);
  if (!n.includes("esteira") && !n.includes("treadmill")) return null;
  if (ESTEIRA_NAO_ELETRICA.test(n)) return "esteira_nao_eletrica";
  return ESTEIRA_ELETRICA_EVIDENCIA.test(`${n} ${semAcento(evidencia)}`) ? "esteira_eletrica" : null;
}

/**
 * Atributos da ficha nos mesmos nomes de public.ontologia_atributos (migration 20261011100600): a aderência técnica
 * compara requisito do edital e ficha do produto pelo nome. Só os nós que têm ontologia ganham atributos; os demais
 * ficam só com as colunas da linha. valor_num segue o sentido 'minimo' da ontologia: o que o produto garante
 * (motor: o primeiro número, nominal, não o pico; velocidade: a máxima da faixa).
 */
const ONTOLOGIA: Record<string, true> = { esteira_eletrica: true };

export function fichaTecnica(
  entrada: Pick<FichaEntrada, "nome" | "medidas" | "destaques" | "especificacoes">,
  noTaxonomiaGravado: string | null = null,
): { no_taxonomia: string | null; carga_maxima_kg: number | null; peso_equipamento_kg: number | null; atributos: AtributoFicha[] } {
  // Os destaques são texto de marketing: só entram quando trazem número com unidade (regex estrita).
  const marketing = entrada.destaques.map((d) => `${d.titulo}. ${d.texto}`).join("\n");
  const evidencia = `${marketing} ${entrada.especificacoes.map((e) => `${e.rotulo} ${e.valor}`).join(" ")}`;
  const noTaxonomia = noTaxonomiaDe(entrada.nome, evidencia);
  // O nó que vale para os atributos é o gravado (pode ter sido corrigido à mão), senão o da ficha.
  const noEfetivo = noTaxonomiaGravado ?? noTaxonomia;
  if (!noEfetivo) {
    return { no_taxonomia: null, carga_maxima_kg: null, peso_equipamento_kg: null, atributos: [] };
  }
  const porRotulo = new Map<string, string>();
  for (const spec of entrada.especificacoes) porRotulo.set(chaveRotulo(spec.rotulo), spec.valor);
  const pegar = (chaves: string[], fallback: string | null): string | null => {
    for (const chave of chaves) {
      const achou = porRotulo.get(chave);
      if (achou) return achou;
    }
    return fallback;
  };
  const pesoUsuario = pegar(
    ["peso max usuario", "peso maximo usuario", "peso usuario", "carga maxima do usuario", "carga maxima", "capacidade"],
    numeroKg(marketing, /usu[aá]rios? de at[eé]\s+(\d+(?:[.,]\d+)?)\s*kg/i),
  );
  const pesoEquipamento = pegar(["peso equipamento", "peso do equipamento", "peso liquido"], null);
  const kgUsuario = quilos(pesoUsuario);
  const kgEquipamento = quilos(pesoEquipamento);
  const atributos: AtributoFicha[] = [];
  if (ONTOLOGIA[noEfetivo]) {
    const velocidade = pegar(
      ["velocidade", "velocidade maxima"],
      textoGrupo(marketing, /velocidades? de at[eé]\s+(\d+(?:[.,]\d+)?\s*km\s*\/\s*h)/i),
    );
    const motor = pegar(["motor", "potencia", "potencia do motor"], textoGrupo(marketing, /motor de\s+(\d+(?:[.,]\d+)?\s*(?:P?HP|CV))/i));
    const area = pegar(
      ["area de corrida", "area util", "superficie de corrida"],
      textoGrupo(marketing, /[aá]rea de corrida de\s+(\d[\d.,]*\s*[x×]\s*\d[\d.,]*\s*(?:mm|cm))/i),
    );
    const inclinacao = pegar(["inclinacao", "elevacao"], null);
    const certificacoes = pegar(["certificacoes", "certificacao", "certificado", "normas", "norma"], null);
    const por = (atributo: string, valor: string | null, valorNum: number | null = null) => {
      if (!valor) return;
      atributos.push({ atributo, valor_texto: valor, valor_num: valorNum });
    };
    por("capacidade_usuario_kg_min", pesoUsuario, kgUsuario);
    por("velocidade_kmh_min", velocidade, maiorNumero(velocidade, /km\s*\/?\s*h/i));
    por("motor_hp_min", motor, primeiroNumero(motor, /P?HP|CV/i));
    por("area_corrida", area);
    por("inclinacao", inclinacao);
    por("certificacoes", certificacoes);
  }
  return { no_taxonomia: noTaxonomia, carga_maxima_kg: kgUsuario, peso_equipamento_kg: kgEquipamento, atributos };
}

function chaveRotulo(rotulo: string): string {
  return semAcento(rotulo).replace(/[^a-z0-9]+/g, " ").replace(/\b(max|maximo|maxima)\b\.?/g, "max").trim();
}

function quilos(valor: string | null): number | null {
  if (!valor) return null;
  const m = valor.match(/(\d+(?:[.,]\d+)?)\s*kg/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Maior número do texto, desde que a unidade esperada apareça (ex.: "0.8 – 20 Km/h" → 20; "3.0 PHP" → 3). */
function maiorNumero(valor: string | null, unidade: RegExp): number | null {
  if (!valor || !unidade.test(valor)) return null;
  const numeros = [...valor.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")))
    .filter((n) => Number.isFinite(n));
  return numeros.length ? Math.max(...numeros) : null;
}

/** Primeiro número do texto, desde que a unidade apareça (ex.: "2.5 HP (5.0 HP pico)" → 2.5: o nominal, não o pico). */
function primeiroNumero(valor: string | null, unidade: RegExp): number | null {
  if (!valor || !unidade.test(valor)) return null;
  const m = valor.match(/\d+(?:[.,]\d+)?/);
  const n = m ? Number(m[0].replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}

function numeroKg(texto: string, re: RegExp): string | null {
  const m = texto.match(re);
  return m ? `${m[1].replace(".", ",")} kg` : null;
}

function textoGrupo(texto: string, re: RegExp): string | null {
  const m = texto.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function codigoDeFabricante(codigo: string): boolean {
  // E12 e HB007 têm dígito. K-RUN não tem, mas o hífen separa o modelo. "Cardio" continua fora.
  return CODIGO.test(codigo) && (/\d/.test(codigo) || codigo.includes("-"));
}

function listaImagens(valor: unknown, hostPagina: string): string[] {
  if (valor === undefined || valor === null) return [];
  if (!Array.isArray(valor) || valor.length > MAX_IMAGENS_FICHA) {
    throw new ErroFicha("Imagens inválidas.", 400);
  }
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
  // Classificação é editável à mão (CLAUDE.md): a ficha só preenche no_taxonomia quando a linha ainda não tem, e os
  // atributos seguem o nó gravado.
  const tecnica = fichaTecnica(entrada, existente?.no_taxonomia ?? null);
  const noTaxonomia = existente?.no_taxonomia ? null : tecnica.no_taxonomia;
  return {
    id: existente?.id ?? null,
    atributosFicha: tecnica.atributos,
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
      ...(noTaxonomia ? { no_taxonomia: noTaxonomia } : {}),
      ...(tecnica.carga_maxima_kg !== null ? { carga_maxima_kg: tecnica.carga_maxima_kg } : {}),
      ...(tecnica.peso_equipamento_kg !== null ? { peso_equipamento_kg: tecnica.peso_equipamento_kg } : {}),
    },
  };
}
