import { assertEquals } from "jsr:@std/assert@1";
import {
  handleRequest,
  type ApiSyncsContext,
} from "../../../supabase/functions/api-syncs/index.ts";

type Row = Record<string, unknown>;

const ADMIN = {
  id: "admin-teste",
  app_metadata: { licitagym_role: "admin" },
};

function execucao() {
  return {
    sync_id: "00000000-0000-4000-8000-000000000001",
    status: "incompleta",
    rotina: "reconciliacao",
    iniciada_em: "2026-11-02T14:00:00Z",
    finalizada_em: "2026-11-02T14:01:00Z",
    heartbeat_em: "2026-11-02T14:01:00Z",
    tem_erro: false,
    contagens: {
      recebidos: 40, novos: 0, alterados: 0, inalterados: 40,
      erros: 0, planos_feitos: 10, planos_erro: 0,
      itens_inativados: 0, planos_inativados: 0,
    },
  };
}

function resumo(): Row {
  return {
    ano: 2026,
    observado_em: "2026-11-02T14:02:00Z",
    fila: {
      total: 30, pendentes: 20, processando: 0,
      erros_nao_esgotados: 0, esgotados: 0, feitos: 10,
      abertos: 20, reservas_expiradas: 0,
    },
    execucoes_ativas: 0,
    execucoes_sem_heartbeat: 0,
    ultima_execucao: execucao(),
    ultimo_lote_sem_erros: execucao(),
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api-syncs", {
    method: "POST",
    headers: { Authorization: "Bearer ficticio" },
    body: JSON.stringify(body),
  });
}

function contexto(
  ler: (ano: number) => Promise<unknown>,
  extra: Partial<ApiSyncsContext> = {},
): ApiSyncsContext {
  return {
    isCron: () => false,
    getUser: () => Promise.resolve(ADMIN),
    agora: () => new Date("2026-11-02T14:02:00Z"),
    lerEstadoPca: ler,
    fetchFn: () => {
      throw new Error("A consulta não pode disparar sync ou workflow");
    },
    ...extra,
  };
}

Deno.test("estado PCA: autenticação e autorização precedem a leitura", async () => {
  let leituras = 0;
  const ler = () => {
    leituras++;
    return Promise.resolve(resumo());
  };
  const casos: Array<[Partial<ApiSyncsContext>, number]> = [
    [{ getUser: () => Promise.resolve(null) }, 401],
    [{
      getUser: () => Promise.resolve({
        id: "comum", app_metadata: {},
      }),
    }, 403],
    [{ isCron: () => true }, 403],
  ];
  for (const [extra, esperado] of casos) {
    const response = await handleRequest(
      post({ action: "estado_pca", ano: 2026 }),
      contexto(ler, extra),
    );
    assertEquals(response.status, esperado);
  }
  assertEquals(leituras, 0);
});

Deno.test("estado PCA: lote sem erros não significa fila concluída", async () => {
  const anos: number[] = [];
  const response = await handleRequest(
    post({ action: "estado_pca", ano: 2026 }),
    contexto((ano) => {
      anos.push(ano);
      return Promise.resolve(resumo());
    }),
  );
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(anos, [2026]);
  assertEquals(body.estado, "parcial");
  assertEquals(body.atualizacao_parcial, true);
  assertEquals(body.fila.abertos, 20);
  assertEquals(body.ultimo_lote_sem_erros.contagens.erros, 0);
});

Deno.test("estado PCA: ausência de execuções não vira sucesso", async () => {
  const raw = resumo();
  raw.ultima_execucao = null;
  raw.ultimo_lote_sem_erros = null;
  raw.fila = {
    total: 0, pendentes: 0, processando: 0,
    erros_nao_esgotados: 0, esgotados: 0, feitos: 0,
    abertos: 0, reservas_expiradas: 0,
  };
  const response = await handleRequest(
    post({ action: "estado_pca" }),
    contexto(() => Promise.resolve(raw)),
  );
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.ano, 2026);
  assertEquals(body.estado, "sem_execucoes");
  assertEquals(body.atualizacao_parcial, true);
  assertEquals(body.ultima_execucao, null);
});

Deno.test("estado PCA: distingue atividade, bloqueios e fila concluída", async () => {
  for (const caso of ["ativa", "esgotados", "heartbeat", "concluida"]) {
    const raw = resumo();
    let esperado = "atencao";
    if (caso === "ativa") {
      raw.execucoes_ativas = 1;
      esperado = "em_execucao";
    }
    if (caso === "esgotados") {
      raw.fila = { ...(raw.fila as Row), total: 191, esgotados: 161 };
    }
    if (caso === "heartbeat") raw.execucoes_sem_heartbeat = 1;
    if (caso === "concluida") {
      raw.fila = {
        ...(raw.fila as Row), total: 10, pendentes: 0, abertos: 0,
      };
      raw.ultima_execucao = { ...execucao(), status: "concluida" };
      esperado = "atualizado";
    }
    const response = await handleRequest(
      post({ action: "estado_pca", ano: 2026 }),
      contexto(() => Promise.resolve(raw)),
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.estado, esperado, caso);
    assertEquals(body.atualizacao_parcial, caso !== "concluida", caso);
  }
});

Deno.test("estado PCA: ano inválido não consulta o banco", async () => {
  let leituras = 0;
  for (const ano of [null, "2026", true, 2026.5, 1899, 2101]) {
    const response = await handleRequest(
      post({ action: "estado_pca", ano }),
      contexto(() => {
        leituras++;
        return Promise.resolve(resumo());
      }),
    );
    assertEquals(response.status, 400);
  }
  assertEquals(leituras, 0);
});

Deno.test("estado PCA: resposta ausente ou inconsistente não vira fila vazia", async () => {
  const negativo = resumo();
  negativo.fila = { ...(negativo.fila as Row), pendentes: -1 };
  const inconsistente = resumo();
  inconsistente.fila = { ...(inconsistente.fila as Row), abertos: 999 };
  const outroAno = { ...resumo(), ano: 2025 };

  for (const raw of [null, {}, negativo, inconsistente, outroAno]) {
    const response = await handleRequest(
      post({ action: "estado_pca", ano: 2026 }),
      contexto(() => Promise.resolve(raw)),
    );
    assertEquals(response.status, 502);
    assertEquals((await response.json()).fila, undefined);
  }
});

Deno.test("estado PCA: falha interna não expõe SQL ou credenciais", async () => {
  const response = await handleRequest(
    post({ action: "estado_pca", ano: 2026 }),
    contexto(() => Promise.reject(
      new Error("senha-ficticia SELECT * FROM private.pca_plano_fila"),
    )),
  );
  assertEquals(response.status, 502);
  const text = await response.text();
  assertEquals(text.includes("senha-ficticia"), false);
  assertEquals(text.includes("SELECT"), false);
  assertEquals(text.includes("private."), false);
});

Deno.test("estado PCA: projeção descarta campos extras do banco", async () => {
  const raw = resumo();
  raw.secret = "nao-expor";
  raw.ultima_execucao = {
    ...execucao(),
    parametros: { token: "nao-expor" },
    erro_principal: "nao-expor",
  };
  const response = await handleRequest(
    post({ action: "estado_pca", ano: 2026 }),
    contexto(() => Promise.resolve(raw)),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.text()).includes("nao-expor"), false);
});
