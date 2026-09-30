import { type AuthenticatedUser, authenticateUser, corsHeaders, jsonResponse } from "../_shared/http.ts";

/**
 * discover-piso-pdm: protótipo que busca PDMs de piso num site de terceiros (todaslicitacoes.com.br).
 * Não lê nem grava no banco. Mesmo assim só atende usuário logado (JWT de sessão validado no código com
 * authenticateUser; a anon key e o SYNC_CRON_SECRET não são sessão): regra do projeto, dado só para quem
 * está logado, e sem proxy aberto para o site externo. verify_jwt = false no config.toml, como as demais api-*.
 */
export interface DiscoverPisoContext {
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  fetchFn?: typeof fetch;
}

interface PdmDiscovery {
  codigoPdm: string;
  nomePdm: string;
  codigoGrupo?: string;
  codigoClasse?: string;
  fonte: string;
  descricaoOriginal: string;
}

interface ApiResponse {
  sucesso: boolean;
  pdmsEncontrados: PdmDiscovery[];
  totalResultados: number;
  avisos: string[];
}

export async function handleRequest(req: Request, ctx: DiscoverPisoContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const user = await (ctx.getUser ?? authenticateUser)(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
  const fetchFn = ctx.fetchFn ?? fetch;

  try {
    const url = new URL(req.url);
    const categoria = url.searchParams.get("categoria") || "equipamentos-esportivos-e-lazer";
    const termo = url.searchParams.get("termo") || "piso";
    const estado = url.searchParams.get("estado") || "";
    const limiteBruto = Number.parseInt(url.searchParams.get("limite") || "100", 10);
    const limite = Number.isFinite(limiteBruto) ? Math.min(Math.max(limiteBruto, 1), 100) : 100;

    const pdmsEncontrados: PdmDiscovery[] = [];
    const avisos: string[] = [];

    // Estratégia 1: API JSON (se disponível)
    try {
      console.log(`[1] Tentando API JSON: GET /api/licitacoes`);

      const apiUrl = new URL("https://www.todaslicitacoes.com.br/api/licitacoes");
      apiUrl.searchParams.append("categoria", categoria);
      apiUrl.searchParams.append("limit", String(limite));
      if (estado) apiUrl.searchParams.append("estado", estado);

      const apiResponse = await fetchFn(apiUrl.toString(), {
        headers: {
          "User-Agent": "LicitaGym/1.0",
          "Accept": "application/json",
        },
      });

      if (apiResponse.ok) {
        const dados = await apiResponse.json();
        console.log(`[1] ✓ API JSON respondeu com ${dados.length} registros`);

        if (Array.isArray(dados)) {
          for (const item of dados) {
            // Buscar por termo "piso" em descrição
            const desc = `${item.titulo || ""} ${item.descricao || ""}`.toLowerCase();
            if (desc.includes(termo.toLowerCase())) {
              const pdm = extrairPdmDeDescricao(item, termo);
              if (pdm) {
                pdmsEncontrados.push(pdm);
              }
            }
          }
        }
      }
    } catch (e) {
      avisos.push(`API JSON não disponível: ${(e as Error).message}`);
    }

    // Estratégia 2: GraphQL (se Compras.gov usa)
    if (pdmsEncontrados.length === 0) {
      try {
        console.log(`[2] Tentando GraphQL: POST /graphql`);

        const query = `
          query BuscarPisos {
            material(
              where: {
                categoria: ${JSON.stringify(categoria)}
                descricao_contains: ${JSON.stringify(termo)}
              }
              limit: ${limite}
            ) {
              id
              codigoPdm
              nomePdm
              codigoGrupo
              codigoClasse
              descricao
            }
          }
        `;

        const gqlResponse = await fetchFn("https://www.todaslicitacoes.com.br/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "LicitaGym/1.0",
          },
          body: JSON.stringify({ query }),
        });

        if (gqlResponse.ok) {
          const result = await gqlResponse.json();
          console.log(`[2] ✓ GraphQL respondeu`);

          if (result.data?.material) {
            for (const item of result.data.material) {
              pdmsEncontrados.push({
                codigoPdm: String(item.codigoPdm || item.id),
                nomePdm: item.nomePdm || item.descricao,
                codigoGrupo: String(item.codigoGrupo || "45"),
                codigoClasse: String(item.codigoClasse || "4567"),
                fonte: "graphql-todaslicitacoes",
                descricaoOriginal: item.descricao || "",
              });
            }
          }
        }
      } catch (e) {
        avisos.push(`GraphQL não disponível: ${(e as Error).message}`);
      }
    }

    // Estratégia 3: Fallback — dados conhecidos de piso (para teste)
    if (pdmsEncontrados.length === 0) {
      avisos.push("API externa não respondendo. Usando dados de teste conhecidos.");

      pdmsEncontrados.push(
        {
          codigoPdm: "123456",
          nomePdm: "Piso de Borracha 50x50cm — Tipo fitness",
          codigoGrupo: "45",
          codigoClasse: "4567",
          fonte: "fallback-teste",
          descricaoOriginal: "Material de revestimento borracha, 50x50cm, aplicação fitness",
        },
        {
          codigoPdm: "234567",
          nomePdm: "Piso Vinílico 1m x 1m — Academia",
          codigoGrupo: "45",
          codigoClasse: "4568",
          fonte: "fallback-teste",
          descricaoOriginal: "Piso vinílico, 1m x 1m, resistente, uso academia",
        },
        {
          codigoPdm: "345678",
          nomePdm: "Piso de Madeira — Modular",
          codigoGrupo: "46",
          codigoClasse: "4678",
          fonte: "fallback-teste",
          descricaoOriginal: "Revestimento madeira modular, para academia",
        }
      );
    }

    // Ordenar por relevância (borracha > vinílico > madeira para academia)
    const ordenado = pdmsEncontrados.sort((a, b) => {
      const scoreA = calcularRelevancia(a.nomePdm, termo);
      const scoreB = calcularRelevancia(b.nomePdm, termo);
      return scoreB - scoreA;
    });

    const resposta: ApiResponse = {
      sucesso: true,
      pdmsEncontrados: ordenado.slice(0, limite),
      totalResultados: ordenado.length,
      avisos,
    };

    return new Response(JSON.stringify(resposta, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error("Erro em discover-piso-pdm:", error);

    return new Response(
      JSON.stringify({
        sucesso: false,
        pdmsEncontrados: [],
        totalResultados: 0,
        avisos: [(error as Error).message],
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));

/**
 * Extrai PDM de um item retornado pela API
 */
function extrairPdmDeDescricao(item: any, termo: string): PdmDiscovery | null {
  const desc = item.descricao || item.titulo || "";

  // Padrões conhecidos em CATMAT
  const padrao = /(?:Piso|piso).+?(?:codigo|pdm|cod)?\s*[\:=]?\s*(\d+)/i;
  const match = desc.match(padrao);

  return {
    codigoPdm: match ? match[1] : `PDM-${Date.now()}`,
    nomePdm: item.titulo || item.descricao?.substring(0, 100) || "Piso",
    codigoGrupo: item.grupo || "45",
    codigoClasse: item.classe || "4567",
    fonte: "api-todaslicitacoes",
    descricaoOriginal: desc,
  };
}

/**
 * Calcula score de relevância do PDM para academia
 */
function calcularRelevancia(nomePdm: string, termo: string): number {
  let score = 0;
  const nome = nomePdm.toLowerCase();

  // Exato
  if (nome.includes(termo.toLowerCase())) score += 100;

  // Tipo + material
  if (nome.includes("borracha")) score += 50; // preferido para academia
  if (nome.includes("vinílico") || nome.includes("vinilico")) score += 30;
  if (nome.includes("madeira")) score += 10;

  // Dimensões
  if (nome.includes("50x50") || nome.includes("1x1") || nome.includes("1m")) score += 20;

  // Contexto
  if (nome.includes("fitness") || nome.includes("academia")) score += 15;
  if (nome.includes("esportivo")) score += 10;

  return score;
}
