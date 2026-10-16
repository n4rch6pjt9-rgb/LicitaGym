# 0028: Ligar a coleta diária do Sistema S e registrar cada execução

- **Status:** rascunho
- **Issue:** #187 (Cloud Run Job + Scheduler, aberta desde 03/10); relacionadas #202, #204, #300
- **Área:** coletor + migrations + edge-functions + infra GCP
- **Depende do ok do Marcelo:** sim (custo no GCP, cron novo em produção e primeira execução feita por ele)

## Problema

O Sistema S nunca rodou de forma recorrente em produção, e o painel de saúde não tem como mostrar isso.

**Medição em produção** (somente leitura, 16/10/2026):
- **`licitacoes_externas`:** 2.347 linhas do `pncp`, **3** do `sestsenat` (todas de 24/09/2026, gravadas num
  intervalo de 12 min) e **2** do `sfiec` (07/10/2026). Parecem execuções manuais.
- **`private.coleta_externa_run`:** **0 linhas**, de qualquer fonte. Nenhum coletor grava nessa tabela (busca em
  `services/`, `scripts/`, `supabase/functions/` e `.github/`). A spec 0023 já tinha registrado isso.
- **Saúde:** `coleta_externa_dias_sem_sucesso` lê só essa tabela. Sem nenhuma execução, mostra "sem dado" (crítico)
  para sempre, mesmo que uma coleta rode.
- **Disparo:** `supabase/functions/_shared/coletor/enfileirar-sestsenat.ts` (#304, 11/10) monta o pedido ao Cloud Run
  Job `coletor-sestsenat`, mas o próprio arquivo diz "sem chamador por enquanto": nenhuma função o importa. O cron
  `licitagym-coletor-sestsenat` (constante `JOB_CRON`) **não existe** em `cron.job`.
- **Credencial:** o segredo `coletor_sestsenat_run_key` está no Vault desde 07/10/2026.
- **GCP:** se o job `coletor-sestsenat` existe, em que projeto e região, e se há Cloud Scheduler: **não medido**
  (sem `gcloud` nesta máquina). O helper usa `licitagym` / `southamerica-east1`; a #187 fala em `us-central1`.

**Testes que existem e por que não bastam:** os testes do Paradigma e do `enfileirar-sestsenat` são unitários, sem
chamada real (regra do projeto). Eles provam o formato do pedido e o parser, não que o job roda em produção.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o job `coletor-sestsenat` implantado e conferido pelo Marcelo (projeto, região, conta de serviço com o mínimo), **quando** ele roda `gcloud run jobs execute coletor-sestsenat` uma vez, **então** a execução termina `Succeeded` e o resultado fica registrado no PR (data, duração, contagens). Só depois disso o cron do CA-3 é ligado. | runbook em `services/coletor-externo/README.md` + saída do `gcloud` no PR |
| CA-2 | **Dado** uma execução do coletor do Sistema S, **quando** ela começa e termina, **então** grava em `private.coleta_externa_run` uma linha com `fonte`, `modo`, `status` (`executando` → `concluida`, `concluida_com_erros` ou `falhou`), `listados`, `processos`, `no_escopo`, `itens_escopo`, `erros`, `detalhe_erros`, `started_at` e `finished_at`. Uma execução interrompida (sem fim) fica `executando` e é marcada `falhou` pela execução seguinte, com o motivo. Erro de página conta como erro, nunca como zero resultados. **Caminho de gravação:** o cliente do coletor (`coletor/destino.py`) fixa `Accept-Profile`/`Content-Profile` em `public`, e hoje `coleta_externa_run` não tem grant nenhum a `service_role` (tabela nem sequência; consulta de 16/10). A gravação passa por RPC em `public` (`public.coleta_externa_run_iniciar` / `_finalizar`, `security definer`, `search_path` fixo, `EXECUTE` só `service_role`), e a migration dá os grants mínimos e checa, no `_check.sql`, que `service_role` grava e `anon`/`authenticated` não. Falha ao gravar a execução é logada e não derruba a coleta. | pytest `services/coletor-externo/tests/test_coleta_externa_run.py` (sem rede) + SQL `supabase/tests/coleta_externa_run_check.sql` |
| CA-3 | **Dado** o CA-1 feito, **quando** chega o horário diário, **então** o `pg_cron` (`licitagym-coletor-sestsenat`) chama uma Edge Function que usa `enfileirar-sestsenat.ts` com a chave do Vault; a resposta do Cloud Run (200 = enfileirado) fica em `private.cron_edge_chamadas`. A chave nunca aparece em log, resposta ou registro. | Deno `tests/supabase/functions/disparar_coletor_test.ts` + SQL `supabase/tests/coletor_sestsenat_cron_check.sql` |
| CA-4 | **Dado** o Cloud Run respondendo erro (403, 404 ou 5xx) ou o segredo ausente, **quando** o cron dispara, **então** a chamada fica registrada com o status e o motivo, e a saúde mostra "disparo do coletor do Sistema S falhou em DD/MM", não "sem dado". | Deno `tests/supabase/functions/disparar_coletor_test.ts` |
| CA-5 | **Dado** a tela de Sincronizações (`api-syncs`), **quando** o admin abre a lista, **então** o coletor do Sistema S aparece com horário e pode ser disparado à mão pelo mesmo caminho do cron; a resposta traz os campos novos `ultimo_disparo` (`{ em, status }`, de `cron_edge_chamadas`) e `ultima_execucao` (`{ inicio, fim, status, processos, erros }`, de `coleta_externa_run`). **Muda o contrato:** hoje o `src/data/syncsApi.ts` do Dashboard só lê `slug`, `funcao`, `titulo`, `faz`, `cron`, `disparavel` e `aviso` (spec 0025) e ignora o resto, então o backend vai antes sem quebrar; o card mostrar as duas datas é um PR do Dashboard nesta spec. | Deno `tests/supabase/functions/api_syncs_test.ts` + vitest `src/test/syncs-coletor-sistema-s.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-6 | **Dado** execuções gravadas, **quando** `private.saude_operacional_resumo()` roda, **então** `coleta_externa_dias_sem_sucesso` mostra os dias desde a última execução concluída por fonte **esperada** (lista escrita: `sestsenat`); fonte esperada sem nenhuma execução aparece pelo nome no detalhe, em vez de "sem dado" genérico. | SQL `supabase/tests/saude_coleta_externa_check.sql` |
| CA-7 | **Dado** o job diário rodando o entrypoint da imagem (`python -m coletor.main --de 1 --ate 5000 --todos --escopo fitness --coleta sestsenat`, os argumentos de `enfileirar-sestsenat.ts`), **quando** duas execuções seguidas passam pelos mesmos processos, **então** não duplicam linhas nas tabelas que esse caminho grava: `licitacoes_externas` (chave `fonte,modulo,id_externo`) e `licitacao_documentos`. Itens e resultados (`licitacao_itens`, `licitacao_resultados`) são gravados só pelo `coletor.paradigma`, que tem outra CLI e não é o que o job roda (pergunta 5). Contagem antes/depois no PR. | pytest `services/coletor-externo/tests/test_main_sestsenat_idempotencia.py` (chama `coletor.main.main([...])` com os argumentos do helper, sem rede) + contagem no PR |

## Fora de escopo

- **SFIEC:** primeira gravação bloqueada pela regra CATMAT (#200, #202). Entra na lista de fontes esperadas do CA-6
  quando a #202 fechar.
- **Sesc do mural Paradigma (#304), FIESC, Firjan, FIERGS (#204) e o conector do TCU (#300).**
- **Coletor PNCP do GitHub Actions** (`coletor-pncp.yml`): tem acompanhamento próprio (spec 0025) e não passa a gravar
  em `coleta_externa_run` aqui.
- Mudar a regra de escopo ou de classificação do Sistema S.

## Impacto em dados

- **Migration:** sim, aditivas e idempotentes: `<timestamp>_coleta_externa_run_rpc.sql` (grants mínimos e as RPCs
  `public.coleta_externa_run_iniciar`/`_finalizar`, com `supabase/tests/coleta_externa_run_check.sql`) e
  `<timestamp>_coletor_sestsenat_cron.sql`: o job do `pg_cron` (via
  `private.cron_chamar_edge`) e a lista de fontes esperadas na saúde (`private.saude_limiares` ou tabela pequena),
  com `supabase/tests/coletor_sestsenat_cron_check.sql`. **Pede branch Supabase** (pg_cron e Vault não existem no
  stub `pre.sql`).
- **Tabelas/views/funções tocadas:** `private.coleta_externa_run` (passa a ser gravada pelo coletor),
  `private.saude_operacional_resumo()`, `private.cron_edge_chamadas`, `api-syncs` e uma Edge Function de disparo
  (nova ou dentro da `api-syncs`; pergunta 3).
- **ACL/RLS:** grant mínimo a `service_role` na `coleta_externa_run` e na sequência dela (hoje não há nenhum), e
  `EXECUTE` só a `service_role` nas RPCs `public.coleta_externa_run_*`. Sem grant a `anon`/`authenticated`. Expor
  `private` no Data API (feito em 16/10, causa dos 500 dos syncs desde 14/10) não basta: o cliente Python grava só em
  `public`.
- **GCP:** Cloud Run Job e conta de serviço; **custo a estimar e aprovar** (critério da #187). Deploy feito pelo Marcelo.
- **Backfill:** não. A primeira execução (CA-1) traz o que existir.
- **Edge Functions republicadas no merge:** todas.
- **Contrato com o Dashboard:** muda. A `api-syncs` ganha o item do coletor e os campos `ultimo_disparo` e
  `ultima_execucao` (CA-5). O backend vai antes (o front atual ignora campos novos), e um PR do Dashboard mostra as
  duas datas no card.
- **Dado oficial x derivado:** o coletor grava os dados do portal como vieram; as contagens da execução são medição.

## Perguntas em aberto

1. **Projeto e região do GCP:** `licitagym` / `southamerica-east1` (helper do #304) ou `us-central1` (#187)? O job
   `coletor-sestsenat` já está implantado?
2. **Custo:** a #187 pede a estimativa mensal aprovada antes. Uma execução diária com a varredura até o ID 5.000
   (para sozinha depois de 15 IDs vazios) cabe no que você aceita? A estimativa vem no PR do CA-1.
3. **Onde fica o disparo:** Edge Function nova `disparar-coletor` ou uma ação dentro da `api-syncs`? A proposta é a
   `api-syncs`, que já dispara syncs à mão e fica na mesma tela.
4. **Horário:** sugestão 05:30 (Brasília), antes do coletor PNCP das 06:00, para não disputar o mesmo horário.
5. **Itens e resultados do Sistema S:** o job diário (`coletor.main`) grava a compra e os documentos, mas não itens nem
   vencedores; isso hoje só o `coletor.paradigma` faz. Fica assim nesta spec (ligar o que já existe) e itens e
   resultados viram spec própria, ou o job passa a rodar o `coletor.paradigma` desde já?
