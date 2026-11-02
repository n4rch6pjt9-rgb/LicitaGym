// Manual: PCA_LOCAL_E2E=1, somente loopback e conteiner dedicado lg-pca-cycle-*.
// PostgreSQL/PostgREST e SDK reais; respostas PNCP sinteticas. Nunca usar credenciais remotas.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
import { processarFila, ReservaPcaPerdidaError } from "../../../supabase/functions/_shared/pncp/pca-fila.ts";
import { handleRotinaFila } from "../../../supabase/functions/sync-pncp-pca/rotina-fila.ts";
type Row = Record<string, unknown>;
const enabled = Deno.env.get("PCA_LOCAL_E2E") === "1";

Deno.test({ name: "PCA real: PostgREST, worker, RPC, historico e concorrencia", ignore: !enabled, fn: async (t) => {
  const base = Deno.env.get("PCA_E2E_URL")!;
  const container = Deno.env.get("PCA_E2E_CONTAINER")!;
  const docker = Deno.env.get("PCA_E2E_DOCKER")!;
  const secret = Deno.env.get("PCA_E2E_JWT_SECRET")!;
  const url = new URL(base);
  assert(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  assert(container.startsWith("lg-pca-cycle-") && secret.length >= 32);
  async function sql(query: string): Promise<string> {
    const out = await new Deno.Command(docker, { args: [
      "exec", container, "psql", "-X", "-tA", "-U", "postgres",
      "-d", "licitagym_pca_tx_test", "-v", "ON_ERROR_STOP=1", "-c", query,
    ], stdout: "piped", stderr: "piped" }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  }
  assertEquals(await sql("select current_database()||':'||current_setting('licitagym.harness',true)"),
    "licitagym_pca_tx_test:isolated-local");
  const enc = new TextEncoder();
  function b64(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  async function jwt(role: string) {
    const data = b64(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))) + "." +
      b64(enc.encode(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })));
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return data + "." + b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
  }
  const key = await jwt("service_role");
  const anonymousKey = await jwt("anon");
  function client(headers: Record<string, string> = {}, fetcher?: typeof fetch, token = key) {
    return createClient(base, token, {
      auth: { persistSession: false, autoRefreshToken: false },
      // PostgREST isolado nao tem o gateway /rest/v1 do Supabase.
      // Somente o prefixo local muda; JWT, headers, body e resposta sao reais.
      global: { headers, fetch: (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        target.pathname = target.pathname.replace(/^\/rest\/v1(?=\/|$)/, "");
        return (fetcher ?? fetch)(input instanceof Request ? new Request(target, input) : target, init);
      } },
    });
  }
  const db = client();
  async function ok<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
  const cnpj = "99000001000101";
  function header(ano: number, seq: number) {
    return { idPcaPncp: cnpj + "-0-" + String(seq).padStart(6, "0") + "/" + ano,
      anoPca: ano, orgaoEntidadeCnpj: cnpj, nomeUnidade: "Fixture local",
      dataAtualizacaoGlobalPCA: "2026-10-01T10:00:00" };
  }
  async function seed(ano: number, seq = 1) {
    const h = header(ano, seq);
    const acquired = await ok(db.schema("private").rpc("pca_adquirir_execucao", {
      p_lock_key: "pca-fila:" + ano, p_resource_type: "pca", p_parametros: { ano }, p_ano: ano,
    })) as Row;
    const run = String(acquired.run_id);
    await gravarPaginaPcaEmLote(client({ "x-pca-run-id": run }), [{ ...h, itens: [{
      numeroItem: 1, descricaoItem: "Item local", classificacaoSuperiorCodigo: "7830",
      classificacaoCatalogoId: 1, quantidadeEstimada: 1, valorUnitario: 100, valorTotal: 100,
    }] }], { ano, runId: run });
    const plano = await ok(db.from("pca_planos").select("*").eq("id_pca_pncp", h.idPcaPncp).single()) as Row;
    return { ano, seq, h, run, plano, id: String(plano.id) };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function enqueue(f: Fixture, motivo = "ausente") {
    await ok(db.schema("private").rpc("pca_fila_enfileirar", { p_itens: [{
      id_pca_pncp: f.h.idPcaPncp, orgao_cnpj: cnpj, ano: f.ano, sequencial: f.seq,
      motivo, plano: motivo === "ausente" ? null : f.h, classes: ["7830"],
      data_atualizacao_fonte: "2026-10-01T10:00:00Z", chain_id: f.run,
    }] }));
  }
  function integ(classe: unknown = "7830") {
    const calls: number[] = [];
    return {
      calls,
      getPcaItensPagina: (_c: string, _a: number, seq: number) => {
        calls.push(seq);
        return Promise.resolve({ status: 200, body: [{
          numeroItem: 1, descricao: "Item local", classificacaoSuperiorCodigo: classe,
          classificacaoCatalogoId: 1, quantidade: 1, valorUnitario: 100, valorTotal: 100,
        }] });
      },
      getPcaItensQuantidade: () => Promise.resolve({ status: 200, body: 1 }),
    };
  }
  async function item(f: Fixture) {
    return await ok(db.from("pca_itens").select("*").eq("pca_plano_id", f.id).single()) as Row;
  }
  async function hist(f: Fixture) {
    return await ok(db.from("pca_alteracoes").select("*").eq("pca_plano_id", f.id)) as Row[];
  }
  function options(f: Fixture, extra = {}) {
    return { ano: f.ano, limite: 1, prazoEsgotado: () => false, runId: f.run,
      clientDaReserva: (token: string, run: string) => client({ "x-pca-reserva": token, "x-pca-run-id": run }), ...extra };
  }

  await t.step("schema private e ACL reais", async () => {
    const f = await seed(2080);
    const denied = await client({}, undefined, anonymousKey).schema("private").rpc("pca_persistir_lote_atomico", {
      p_sync_run_id: f.run, p_unidades: [],
    });
    assert(denied.error && ["42501", "PGRST202", "PGRST106"].includes(denied.error.code));
    assertEquals((await hist(f)).length, 2);
  });
  await t.step("classificacao desconhecida preserva dados via worker real", async () => {
    const f = await seed(2081);
    const before = await item(f);
    await enqueue(f);
    const stats = await processarFila(db, integ(null), options(f));
    assertEquals([stats.planos_feitos, stats.planos_erro], [0, 1]);
    assertEquals(await item(f), before);
    const fila = await ok(db.schema("private").from("pca_plano_fila").select("status,tentativas").eq("ano", f.ano).single()) as Row;
    assertEquals(fila, { status: "erro", tentativas: 1 });
    assertEquals((await hist(f)).length, 2);
  });
  await t.step("inativacao auditada uma vez, inclusive replay", async () => {
    const f = await seed(2082);
    const before = await item(f);
    await enqueue(f);
    const stats = await processarFila(db, integ("6505"), options(f));
    assertEquals([stats.planos_feitos, stats.planos_erro], [1, 0]);
    const after = await item(f);
    assertEquals(after.ativo, false);
    const eventos = (await hist(f)).filter((e) => e.tipo_operacao === "inativacao");
    assertEquals(eventos.length, 2);
    const evento = eventos.find((e) => e.pca_item_id === after.id)!;
    assertEquals(evento.dados_anteriores, before);
    assertEquals(evento.dados_novos, after);
    assertEquals(evento.sync_run_id, f.run);
    await enqueue(f);
    await processarFila(db, integ("6505"), options(f));
    assertEquals((await hist(f)).length, 4);
  });
  await t.step("falha real de historico reverte inativacao do worker", async () => {
    const f = await seed(2083);
    const before = await item(f);
    await enqueue(f);
    await sql("create function private.e2e_rejeitar() returns trigger language plpgsql as $$ begin " +
      "if new.pca_plano_id='" + f.id + "'::uuid and new.tipo_operacao='inativacao' then " +
      "raise exception 'falha historico E2E' using errcode='P0199'; end if; return new; end $$;" +
      "create trigger zz_e2e_rejeitar before insert on public.pca_alteracoes for each row execute function private.e2e_rejeitar();");
    try {
      const stats = await processarFila(db, integ("6505"), options(f));
      assertEquals([stats.planos_feitos, stats.planos_erro], [0, 1]);
      assertEquals(await item(f), before);
      assertEquals((await hist(f)).length, 2);
    } finally {
      await sql("drop trigger zz_e2e_rejeitar on public.pca_alteracoes;drop function private.e2e_rejeitar();");
    }
  });
  await t.step("recuperacao explicita pelo handler, sem reset por descoberta", async () => {
    const f = await seed(2084);
    await enqueue(f, "alterado");
    await sql("update private.pca_plano_fila set status='erro',tentativas=5 where ano=2084;" +
      "update private.pncp_sync_run set status='concluida' where id='" + f.run + "'::uuid;");
    const r = await handleRotinaFila({
      client: db, clientDaReserva: (token, run) => client({ "x-pca-reserva": token, "x-pca-run-id": run }),
      consulta: { fetchPcaPage: () => Promise.resolve({ status: 200, body: { data: [f.h], paginasRestantes: 0 } }) },
      integracao: integ(), body: { rotina: "backfill", recuperar_esgotados: [f.h.idPcaPncp] },
      ano: f.ano, classes: ["7830"], tamanhoPagina: 500, isAsync: false,
    });
    const body = await r.json();
    assertEquals(r.status, 200);
    assertEquals(body.esgotados_reabertos, 1);
    assertEquals(body.carga.planos_feitos, 1);
    const fila = await ok(db.schema("private").from("pca_plano_fila").select("status,tentativas").eq("ano", f.ano).single()) as Row;
    assertEquals(fila, { status: "feito", tentativas: 0 });
  });
  await t.step("duas sessoes: RPC bloqueia recuperacao e rejeita token antigo", async () => {
    const f = await seed(2085);
    await enqueue(f, "alterado");
    const reservados = await ok(db.schema("private").rpc("pca_fila_reservar", { p_limite: 1, p_max_tentativas: 5, p_ano: f.ano })) as Row[];
    const old = String(reservados[0].reserva_token);
    await sql("update private.pca_plano_fila set atualizado_em=now()-interval '16 minutes' where ano=2085;");
    await sql("create function private.e2e_esperar() returns trigger language plpgsql as $$ begin " +
      "if new.payload_hash_novo='e2e-hold' then perform pg_sleep(2); end if; return new; end $$;" +
      "create trigger zz_e2e_esperar before insert on public.pca_alteracoes for each row execute function private.e2e_esperar();");
    const writer = client({ "x-pca-reserva": old, "x-pca-run-id": f.run });
    const unidades = [{ tabela: "pca_planos", chave: { id_pca_pncp: f.h.idPcaPncp },
      linha: { id_pca_pncp: f.h.idPcaPncp, payload_hash: "e2e-hold" } }];
    // Promise.resolve inicia a requisicao (o builder PostgREST e lazy).
    const writing = Promise.resolve(writer.schema("private").rpc("pca_persistir_lote_atomico", {
      p_unidades: unidades, p_sync_run_id: f.run,
    }));
    try {
      let sleeping = false;
      for (let i = 0; i < 30; i++) {
        if (await sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%pca_persistir_lote_atomico%'") !== "0") {
          sleeping = true; break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(sleeping, "primeira sessao nao chegou ao ponto de concorrencia");
      const competing = await ok(db.schema("private").rpc("pca_fila_reservar", { p_limite: 1, p_max_tentativas: 5, p_ano: f.ano }));
      assertEquals(competing, [], "SKIP LOCKED deve impedir recuperacao durante a escrita");
      const written = await writing;
      if (written.error) throw written.error;
      const recovered = await ok(db.schema("private").rpc("pca_fila_reservar", { p_limite: 1, p_max_tentativas: 5, p_ano: f.ano })) as Row[];
      assertEquals(recovered.length, 1);
      assert(recovered[0].reserva_token !== old);
      const rejected = await writer.schema("private").rpc("pca_persistir_lote_atomico", {
        p_unidades: [{ ...unidades[0], linha: { ...unidades[0].linha, payload_hash: "old-writer" } }],
        p_sync_run_id: f.run,
      });
      assertEquals(rejected.error?.code, "40001");
      const p = await ok(db.from("pca_planos").select("payload_hash").eq("id", f.id).single()) as Row;
      assertEquals(p.payload_hash, "e2e-hold");
    } finally {
      await writing;
      await sql("drop trigger zz_e2e_esperar on public.pca_alteracoes;drop function private.e2e_esperar();");
    }
  });
  await t.step("perda de posse entre leitura e RPC nao consome tentativa", async () => {
    const f = await seed(2086, 1);
    const other = await seed(2086, 2);
    await enqueue(f, "alterado"); await enqueue(other, "alterado");
    let trocar = true;
    const remoteFetch: typeof fetch = async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (trocar && target.includes("/rpc/pca_persistir_lote_atomico")) {
        trocar = false;
        await sql("update private.pca_plano_fila set reserva_token=gen_random_uuid() where ano=2086 and sequencial=1;");
      }
      return await fetch(input, init);
    };
    const integration = integ();
    await assertRejects(() => processarFila(db, integration, options(f, {
      limite: 2,
      clientDaReserva: (token: string, run: string) => client({ "x-pca-reserva": token, "x-pca-run-id": run }, remoteFetch),
    })), ReservaPcaPerdidaError);
    const rows = await ok(db.schema("private").from("pca_plano_fila").select("status,tentativas").eq("ano", f.ano).order("sequencial")) as Row[];
    assertEquals(rows, [{ status: "processando", tentativas: 0 }, { status: "pendente", tentativas: 0 }]);
    assertEquals(integration.calls, [1]);
    assertEquals((await hist(f)).length, 2);
  });
} });
