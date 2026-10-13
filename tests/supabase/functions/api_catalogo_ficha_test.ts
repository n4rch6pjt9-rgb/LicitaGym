import { assertEquals } from "jsr:@std/assert@1";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";
import { handleRequest } from "../../../supabase/functions/api-catalogo-ficha/index.ts";
import { familiaDe, fichaTecnica, planejar, validarFicha, type ProdutoExistente } from "../../../supabase/functions/api-catalogo-ficha/ficha.ts";
import type { FichaRepo } from "../../../supabase/functions/api-catalogo-ficha/repo.ts";
import type { LinhaProduto } from "../../../supabase/functions/api-catalogo-ficha/ficha.ts";

const USER: AuthenticatedUser = { id: "u-1", email: "a@konnen.test", app_metadata: {} };

const AIR = {
  action: "gravar",
  nome: "Arc Runner",
  codigo: "HR007",
  url: "https://www.konnenfitness.com.br/produto/cardio-arc-runner/",
  categorias: ["Cardio", "Profissional"],
  medidas: null,
  destaques: [{ titulo: "Painel", texto: "Leitura rápida no treino." }],
  imagens: ["https://www.konnenfitness.com.br/wp-content/uploads/2026/06/hr007.jpg"],
  post_id: "8473",
};

function repoMemoria() {
  const linhas = new Map<number, LinhaProduto & { id: number }>();
  const medidas = new Map<number, string>();
  let seq = 0;
  const achar = (pred: (l: LinhaProduto & { id: number }) => boolean): ProdutoExistente | null => {
    for (const l of linhas.values()) {
      if (!pred(l)) continue;
      return { id: l.id, tenant_id: l.tenant_id, codigo: l.codigo, url: l.url, atributos: l.atributos, descricao: l.descricao };
    }
    return null;
  };
  const repo: FichaRepo = {
    porUrl: (url) => Promise.resolve(achar((l) => l.url === url)),
    porCodigo: (tenant, codigo) => Promise.resolve(achar((l) => l.tenant_id === tenant && l.codigo === codigo)),
    inserir: (linha) => {
      const id = ++seq;
      linhas.set(id, { ...linha, id });
      return Promise.resolve(id);
    },
    atualizar: (id, linha) => {
      linhas.set(id, { ...linha, id });
      return Promise.resolve();
    },
    gravarMedida: (id, texto) => {
      medidas.set(id, texto);
      return Promise.resolve();
    },
    gravarAtributos: () => Promise.resolve(),
  };
  return { repo, linhas, medidas };
}

function post(body: unknown, user: AuthenticatedUser | null = USER) {
  const mem = repoMemoria();
  return {
    mem,
    res: handleRequest(new Request("https://local/api-catalogo-ficha", {
      method: "POST",
      body: JSON.stringify(body),
    }), {
      getUser: () => Promise.resolve(user),
      getRepo: () => mem.repo,
      tenantDe: () => Promise.resolve({ tenant: 7, papel: "operacao" }),
      agora: () => "2026-10-12T22:00:00.000Z",
    }),
  };
}

Deno.test("familia cardio não usa a categoria Profissional", () => {
  assertEquals(familiaDe(["Cardio", "Profissional"]), "cardio");
  assertEquals(familiaDe(["Profissional"]), null);
});

Deno.test("host fora da lista não grava", () => {
  let status = 0;
  try {
    validarFicha({ ...AIR, url: "https://exemplo.com/produto/x/" });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});

Deno.test("grava Arc Runner na empresa de quem chama", async () => {
  const { res, mem } = post(AIR);
  const resposta = await res;
  assertEquals(resposta.status, 200);
  const corpo = await resposta.json();
  assertEquals(corpo.atualizado, false);
  assertEquals(corpo.codigo, "HR007");
  const linha = mem.linhas.get(corpo.id)!;
  assertEquals(linha.tenant_id, 7);
  assertEquals(linha.marca, "Konnen");
  assertEquals(linha.familia_equipamento, "cardio");
  assertEquals(linha.nome, "Arc Runner");
  assertEquals((linha.atributos.destaques as { titulo: string }[])[0].titulo, "Painel");
});

Deno.test("a mesma URL atualiza a ficha e não cria outra linha", async () => {
  const mem = repoMemoria();
  const ctx = {
    getUser: () => Promise.resolve(USER),
    getRepo: () => mem.repo,
    tenantDe: () => Promise.resolve({ tenant: 7, papel: "admin" as const }),
    agora: () => "2026-10-12T22:00:00.000Z",
  };
  const req = () => new Request("https://local/api-catalogo-ficha", { method: "POST", body: JSON.stringify(AIR) });
  await handleRequest(req(), ctx);
  const segunda = await handleRequest(req(), ctx);
  assertEquals(segunda.status, 200);
  assertEquals((await segunda.json()).atualizado, true);
  assertEquals(mem.linhas.size, 1);
});

Deno.test("página de outra empresa responde 409", () => {
  const outra: ProdutoExistente = {
    id: 3, tenant_id: 9, codigo: "HR007", url: "https://www.konnenfitness.com.br/produto/cardio-arc-runner/",
    atributos: {}, descricao: null,
  };
  const entrada = validarFicha(AIR);
  let status = 0;
  try {
    planejar(7, entrada, outra, null, "2026-10-12T22:00:00.000Z");
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 409);
});

Deno.test("sem sessão responde 401", async () => {
  const { res } = post(AIR, null);
  assertEquals((await res).status, 401);
});

const FOTOS_K_RUN = [
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/Image_20240319142857.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.2.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.3.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.4.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.6.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/03/ESTEIRA-K.7.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/tela-5.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/piso.jpg",
  "https://www.konnenfitness.com.br/wp-content/uploads/2025/05/impacto.jpg",
];

Deno.test("ESTEIRA K-RUN grava taxonomia, modelo e o peso do usuário que a página declara", () => {
  const entrada = validarFicha({
    ...AIR,
    nome: "ESTEIRA K-RUN",
    codigo: "K-RUN",
    url: "https://www.konnenfitness.com.br/produto/cardio-esteira-k/",
    medidas: "2048 x 955 x 1545 mm",
    especificacoes: [
      { rotulo: "Velocidade", valor: "0.8 – 20 Km/h" },
      { rotulo: "Motor", valor: "3.0 PHP" },
      { rotulo: "Área de corrida", valor: "1550 X 580 mm" },
      { rotulo: "Peso Máx. usuário", valor: "180 kg" },
    ],
    destaques: [{
      titulo: "Sensor de Batimentos Cardíacos e Níveis de Inclinação",
      texto: "A K-RUN conta com um painel de fácil visualização que exibe velocidade, tempo, distância, calorias e frequência cardíaca.",
    }],
  });
  const tecnica = fichaTecnica(entrada);
  assertEquals(tecnica.no_taxonomia, "ESTEIRA ERGOMETRICA");
  assertEquals(tecnica.carga_maxima_kg, 180);
  assertEquals(tecnica.peso_equipamento_kg, null);
  const porNome = new Map(tecnica.atributos.map((a) => [a.atributo, a.valor_texto]));
  assertEquals(porNome.get("Modelo"), "K-RUN");
  assertEquals(porNome.get("Medidas"), "2048 x 955 x 1545 mm");
  assertEquals(porNome.get("Peso Usuário"), "180 kg");
  assertEquals(porNome.get("Velocidade"), "0.8 – 20 Km/h");
  assertEquals(porNome.get("Motor"), "3.0 PHP");
  assertEquals(porNome.get("Área de Corrida"), "1550 X 580 mm");
  assertEquals(porNome.has("Peso Equipamento"), false);
  assertEquals(porNome.has("Níveis de Intensidade"), false);
  const plano = planejar(7, entrada, null, null, "2026-10-13T03:07:35.000Z");
  assertEquals(plano.linha.no_taxonomia, "ESTEIRA ERGOMETRICA");
  assertEquals(plano.linha.carga_maxima_kg, 180);
  assertEquals("linha" in plano.linha, false);
});

Deno.test("K-RUN e as 9 fotos da esteira passam", () => {
  const entrada = validarFicha({
    ...AIR,
    nome: "ESTEIRA K-RUN",
    codigo: "K-RUN",
    url: "https://www.konnenfitness.com.br/produto/cardio-esteira-k/",
    imagens: FOTOS_K_RUN,
  });
  assertEquals(entrada.codigo, "K-RUN");
  assertEquals(entrada.imagens.length, 9);
});

Deno.test("palavra sem dígito nem hífen não vira código", () => {
  let status = 0;
  try {
    validarFicha({ ...AIR, codigo: "Cardio" });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});

Deno.test("mais de 12 imagens é recusado", () => {
  const imagens = Array.from(
    { length: 13 },
    (_, i) => `https://www.konnenfitness.com.br/wp-content/uploads/2025/03/foto-${i}.jpg`,
  );
  let status = 0;
  try {
    validarFicha({ ...AIR, imagens });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  assertEquals(status, 400);
});
