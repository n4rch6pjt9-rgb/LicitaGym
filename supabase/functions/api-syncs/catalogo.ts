/** Agenda em horário de Brasília, conferida no pg_cron de produção em 13/10/2026. */

export interface SyncCatalogo {
  slug: string;
  funcao: string | null;
  titulo: string;
  faz: string;
  /** null = nunca houve job no pg_cron. */
  cron: string | null;
  corpo: Record<string, unknown>;
  /** Disparável daqui: Edge Function (`funcao`) ou workflow do GitHub Actions (`github_workflow`). */
  disparavel: boolean;
  aviso: string | null;
  /** Arquivo do workflow em .github/workflows (ex.: coletor-pncp.yml): `rodar` dispara workflow_dispatch com `corpo` como inputs. */
  github_workflow?: string;
  /** Spec 0025: o `listar` traz o último run agendado do workflow e a ação `refazer` refaz as etapas que falharam. */
  refazer_cron?: boolean;
}

/** Syncs nacionais do PNCP: a trava de escopo (_shared/pncp/licitagym-scope-gate.ts) responde 423 sem o override
 * PNCP_NATIONAL_SYNC_ENABLED, que não se liga (traria o PNCP inteiro, fora das classes 7830/7220). */
const AVISO_NACIONAL =
  "Desligado por escopo: baixa o PNCP nacional sem filtro de classe (7830/7220); sem o override " +
  "PNCP_NATIONAL_SYNC_ENABLED a função responde HTTP 423.";

export const SYNCS: SyncCatalogo[] = [
  {
    slug: "coletor-pncp",
    funcao: null,
    github_workflow: "coletor-pncp.yml",
    refazer_cron: true,
    titulo: "Coletor PNCP de oportunidades",
    faz: "Grava licitacoes_externas, a lista do dashboard.",
    cron: "Todo dia às 06:00, no GitHub Actions (coleta completa: leads, monitorar e recoleta).",
    // inputs do workflow_dispatch são sempre texto
    corpo: { modo: "leads", dry_run: "false", rapido: "true" },
    disparavel: true,
    aviso: "Rodar agora dispara o workflow no GitHub só com os 12 termos principais (rápido). Acompanhe em Actions › Coletor PNCP.",
  },
  {
    slug: "coletor-precos",
    funcao: null,
    github_workflow: "coletor-precos.yml",
    refazer_cron: true,
    titulo: "Coletor de preços (Compras.gov + PNCP)",
    faz: "Grava preços praticados (Pesquisa de Preço), descrição detalhada e itens/links de contratação via API PNCP.",
    cron: "Segunda e quinta às 07:00, no GitHub Actions (catálogo, detalhe e contratação PNCP).",
    // inputs do workflow_dispatch são sempre texto
    corpo: { modo: "todos", dry_run: "false" },
    disparavel: true,
    aviso: "Rodar agora dispara o workflow no GitHub com as 3 etapas em sequência. Acompanhe em Actions › Coletor de Preços.",
  },
  {
    slug: "sync-compras-catmat",
    funcao: "sync-compras-catmat",
    titulo: "CATMAT do catálogo",
    faz: "Espelha os PDMs efetivos do catálogo da empresa.",
    cron: "Domingo às 02:07. Retomada domingo às 02:27.",
    corpo: { modo: "catalogo", incluir_inativos: false, async: true },
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-pncp-pca",
    funcao: "sync-pncp-pca",
    titulo: "PCA",
    faz: "Descobre planos novos ou alterados e grava os itens.",
    cron: "Todo dia às 03:13. Continuação a cada 10 min, das 03:00 às 04:50. Reconciliação no dia 1 às 02:13.",
    corpo: { rotina: "incremental", async: true },
    disparavel: true,
    aviso: null,
  },
  {
    slug: "link-catmat-pca",
    funcao: "link-catmat-pca",
    titulo: "Vínculo CATMAT e PCA",
    faz: "Liga item de PCA ao PDM do catálogo.",
    cron: "Todo dia às 04:23.",
    corpo: { limite: 500, offset: 0 },
    disparavel: true,
    aviso: null,
  },
  {
    slug: "link-pca-edital",
    funcao: "link-pca-edital",
    titulo: "Vínculo PCA e edital",
    faz: "Casa plano de PCA com edital.",
    cron: "Todo dia às 04:33.",
    corpo: { dry_run: true, limite: 500 },
    disparavel: true,
    aviso: "O cron e este disparo nascem em dry-run: não gravam.",
  },
  {
    slug: "sync-pncp-orgaos",
    funcao: "sync-pncp-orgaos",
    titulo: "Órgãos",
    faz: "Entidades e órgãos dos CNPJs dos planos de PCA.",
    cron: "Todo dia às 04:43.",
    corpo: {},
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-pncp-catalogo",
    funcao: "sync-pncp-catalogo",
    titulo: "Catálogo PNCP",
    faz: "Categorias de item do PCA.",
    cron: "Dia 1 de cada mês às 05:37.",
    corpo: {},
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-cnpj-verificacao",
    funcao: "sync-cnpj-verificacao",
    titulo: "Verificação de CNPJ",
    faz: "Recalcula o dígito verificador no banco.",
    cron: "Segunda-feira às 03:37.",
    corpo: {},
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-sessao-chat",
    funcao: "sync-sessao-chat",
    titulo: "Chat da sessão (Integra Compras)",
    faz: "Lê o chat e as diligências das compras do pipeline com sessão prevista ou aberta. Cada compra são 2 chamadas cobradas pelo Serpro.",
    cron: "A cada 30 minutos, das 08:00 às 19:30, de segunda a sexta.",
    corpo: { limite: 10, max_chamadas_dia: 300 },
    disparavel: true,
    aviso: "Compra consultada há menos de 55 minutos fica de fora. O teto diário vale só para esta coleta, mas desconta também as consultas manuais feitas pela tela.",
  },
  {
    slug: "sync-portal-compras",
    funcao: "sync-portal-compras",
    titulo: "Portal de Compras Públicas",
    faz: "Consulta a situação das compras abertas e das que estão no pipeline.",
    cron: "Todo dia às 08:00.",
    corpo: { limite: 40 },
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-pncp-contratacoes-editais",
    funcao: "sync-pncp-contratacoes-editais",
    titulo: "Editais PNCP",
    faz: "Publicações nacionais em contratacoes_editais. Não grava a lista de oportunidades.",
    cron: null,
    corpo: {},
    disparavel: false,
    aviso: AVISO_NACIONAL + " As oportunidades vêm do Coletor PNCP.",
  },
  {
    slug: "sync-pncp-contratacoes-atas",
    funcao: "sync-pncp-contratacoes-atas",
    titulo: "Atas PNCP",
    faz: "Atas de registro de preço.",
    cron: null,
    corpo: {},
    disparavel: false,
    aviso: AVISO_NACIONAL + " As atas do escopo vêm do coletor de ARP do Compras.gov (atas_rp_itens).",
  },
  {
    slug: "sync-pncp-contratacoes-contratos",
    funcao: "sync-pncp-contratacoes-contratos",
    titulo: "Contratos PNCP",
    faz: "Contratos publicados no PNCP.",
    cron: null,
    corpo: {},
    disparavel: false,
    aviso: AVISO_NACIONAL,
  },
  {
    slug: "sync-pncp-contratacoes-itens",
    funcao: "sync-pncp-contratacoes-itens",
    titulo: "Itens dos editais",
    faz: "Itens dos editais que ainda não têm item gravado.",
    cron: null,
    corpo: { limite: 50, so_sem_itens: true },
    disparavel: true,
    aviso: null,
  },
  {
    slug: "sync-pncp-irp",
    funcao: "sync-pncp-irp",
    titulo: "IRP",
    faz: "Intenção de registro de preço.",
    cron: null,
    corpo: {},
    disparavel: false,
    aviso: "Desligado: o endpoint de IRP da API de Consulta do PNCP ainda não foi verificado (trava IRP_SYNC_ENABLED, " +
      "CLA-34). Disparar daqui só devolveria HTTP 423.",
  },
  {
    slug: "import-catmat-curadoria",
    funcao: "import-catmat-curadoria",
    titulo: "Curadoria CATMAT",
    faz: "Importa o JSON de curadoria.",
    cron: null,
    corpo: {},
    disparavel: true,
    aviso: "O corpo vazio não substitui o JSON de curadoria.",
  },
];

export function syncPorSlug(slug: string): SyncCatalogo | undefined {
  return SYNCS.find((item) => item.slug === slug);
}
