// Spec 0043, K-1 (CA-4) e K-5: a api-pncp-legislacao (rota POST /api/legislacao/sync e signed URL do bucket) e a
// sync-pncp-legislation (aposentada pela 0044 com 410) saem do repositório. Nenhum arquivo de deploy, função ou teste
// pode citá-las, e nenhuma Edge Function lê as tabelas do catálogo legislacao_* nem o bucket pncp-legislation.
// Sem import de @std/assert: o repositório não tem import map e o deno lint reprova o prefixo jsr: (no-import-prefix).
function falhaSe(condicao: boolean, mensagem: string): void {
  if (condicao) throw new Error(mensagem);
}

const REMOVIDAS = ["api-pncp-legislacao", "sync-pncp-legislation"];
const ARQUIVOS_DEPLOY = [
  "./supabase/config.toml",
  "./.github/workflows/deploy-supabase-functions.yml",
  "./scripts/deploy-functions.ps1",
];
const CATALOGO = [
  "legislacao_fontes",
  "legislacao_documentos",
  "legislacao_versoes",
  "legislacao_alertas",
  "legislacao_relacoes",
  "pncp-legislation",
];

// Raiz do repositório a partir deste arquivo: o teste não pode passar à toa se rodar de outra pasta.
const RAIZ = new URL("../../", import.meta.url);
Deno.chdir(RAIZ);

async function existe(caminho: string): Promise<boolean> {
  try {
    await Deno.stat(caminho);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function* arquivos(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const caminho = `${dir}/${e.name}`;
    if (e.isDirectory) yield* arquivos(caminho);
    else if (e.isFile && /\.(ts|tsx|js|json|toml)$/.test(e.name)) yield caminho;
  }
}

Deno.test("CA-4/CA-8 (spec 0043): pastas das funções removidas não existem", async () => {
  for (const nome of REMOVIDAS) {
    falhaSe(await existe(`./supabase/functions/${nome}`), `${nome} ainda existe em supabase/functions/`);
  }
});

Deno.test("CA-4/CA-8 (spec 0043): config.toml, workflow de deploy e script de deploy não citam as funções removidas", async () => {
  for (const arquivo of ARQUIVOS_DEPLOY) {
    const texto = await Deno.readTextFile(arquivo);
    for (const nome of REMOVIDAS) {
      falhaSe(texto.includes(nome), `${arquivo} ainda cita ${nome}`);
    }
  }
});

// Testes Deno podem citar o slug para provar a ausência (ex.: api_syncs_test.ts); import de pasta removida o
// `deno test` já reprova. Por isso a varredura de texto fica só em supabase/functions.
Deno.test("CA-4/CA-8 (spec 0043): nenhuma Edge Function cita as funções removidas", async () => {
  const achados: string[] = [];
  for await (const caminho of arquivos("./supabase/functions")) {
    const texto = await Deno.readTextFile(caminho);
    for (const nome of REMOVIDAS) if (texto.includes(nome)) achados.push(`${caminho}: ${nome}`);
  }
  falhaSe(achados.length > 0, `ainda citam: ${achados.join("; ")}`);
});

Deno.test("CA-4/CA-8 (spec 0043): nenhuma Edge Function lê o catálogo legislacao_* nem o bucket pncp-legislation", async () => {
  const achados: string[] = [];
  for await (const caminho of arquivos("./supabase/functions")) {
    const texto = await Deno.readTextFile(caminho);
    for (const termo of CATALOGO) if (texto.includes(termo)) achados.push(`${caminho}: ${termo}`);
  }
  falhaSe(achados.length > 0, `ainda citam: ${achados.join("; ")}`);
});
