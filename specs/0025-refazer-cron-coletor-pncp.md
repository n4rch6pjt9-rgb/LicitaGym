# 0025: Refazer pela tela as etapas que falharam no cron do Coletor PNCP

- **Status:** em implementação (aprovada pelo Marcelo em 16/10/2026)
- **Issue:** nenhuma (relacionada: #363, spec 0024; #377, um job por etapa)
- **Área:** edge-functions + dashboard-contrato
- **Depende do ok do Marcelo:** sim (republicação da `api-syncs` em produção e contrato novo com o Dashboard)

## Problema

Quando o cron diário do Coletor PNCP (`.github/workflows/coletor-pncp.yml`, `schedule: "0 9 * * *"`) falha, a tela de
sincronizações não tem como refazê-lo. O único botão, "Rodar agora", dispara um run **novo** com
`rapido: "true"` (só os 12 termos), conforme `supabase/functions/api-syncs/catalogo.ts:27`. A `api-syncs`
(`action: "listar"`) devolve o catálogo estático e não diz se o último cron falhou (`index.ts`, `listar` → `SYNCS`).
Decisão do Marcelo em 16/10/2026: quando o cron falhar, refazer **só as etapas que falharam, no mesmo run**, e não
disparar um run completo novo.

Medido em 16/10/2026 (`gh run list` / `gh api .../actions/runs/{id}/jobs`):
- **Run agendado de 15/10** (`38746383473`, commit `81863b2`): um job só (`coletar`), terminou em `cancelled` depois de
  5h00 (13:52:15Z → 18:52:40Z). Antes do #377, o modo `todos` rodava num job único.
- **Run agendado de 16/10** (`38909904310`, commit `c71b5a5`, `run_attempt` 1): criado às 13:42:16Z, mas só começou
  às 15:57:30Z. Até lá ficou na fila atrás do disparo manual `38902495969`, que terminou `cancelled` às 15:57:28Z.
  Desde o #377 tem jobs `plano`, `coletar (leads)`, `coletar (monitorar)` e `coletar (recoleta)` (`max-parallel: 1`,
  `fail-fast: false`, `timeout-minutes: 350`).
- Os dois runs agendados foram **criados** às 13:42Z e 13:52Z, não às 09:00Z do `cron`: o atraso do GitHub foi de mais
  de 4 h nos dois dias. O texto do card ("Todo dia às 06:00") não reflete isso. Não medido em outros dias.
- Pela API, um job que estoura `timeout-minutes` aparece com `conclusion: cancelled`, como no run de 15/10. Um cancelamento
  manual ou pela fila de concorrência também aparece assim. Não medido se o run inteiro chega a ter `conclusion: timed_out`.

## Critérios de aceite

Ação nova na `api-syncs`: `POST {action: "refazer", sync: "coletor-pncp"}`. O `listar` passa a trazer, só no item
`coletor-pncp`, o bloco `ultimo_cron` (o id do run, `status`, `conclusion`, `run_attempt`, `created_at` e as etapas
com `conclusion`, `started_at` e `completed_at` de cada uma, como o GitHub devolveu) e `pode_refazer: boolean`.
"Último cron" é o último run com `event=schedule`, de quando for (sem janela de 24 h). Não há limite de tentativas
nosso por `run_attempt`, mas valem os limites do GitHub
([re-run de workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)): o
re-run só é aceito "up to 30 days after its initial run", e "a workflow run can be re-run a maximum of 50 times". Por
isso `pode_refazer` exige `created_at` há menos de 30 dias e `run_attempt <= 50` (a tentativa 1 é o run original). Só o
admin chama `refazer`. O cliente nunca envia o id do run: o
servidor localiza o último run com `event=schedule` e decide.

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** que o último run `event=schedule` de `coletor-pncp.yml` terminou (`status: completed`) com `conclusion` `failure`, `cancelled` ou `timed_out`, **quando** um admin chama `listar`, **então** o item `coletor-pncp` traz `ultimo_cron` com o id, o `conclusion` e as etapas como o GitHub devolveu, e `pode_refazer: true`. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-2 | **Dado** que o último run agendado terminou em `success`, **ou** que existe qualquer run de `coletor-pncp.yml` (agendado ou manual) em `queued`/`in_progress`, **ou** que o run foi criado há 30 dias ou mais, **ou** que `run_attempt` passou de 50 (limites do GitHub), **quando** o admin chama `listar`, **então** `pode_refazer: false` (com o motivo); **e quando** chama `refazer`, **então** recebe 409 e nenhuma chamada a `rerun-failed-jobs` acontece. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-3 | **Dado** `pode_refazer: true`, **quando** o admin chama `refazer`, **então** a função faz exatamente um `POST /repos/{repo}/actions/runs/{id}/rerun-failed-jobs` para o id que ela mesma achou (nunca um do corpo da requisição), sem `workflow_dispatch`, e devolve `{status: "refeito", run_id, acompanhe}` quando o GitHub responde 201. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-4 | **Dado** que a leitura dos runs no GitHub falha (5xx, timeout ou 401), **quando** o admin chama `listar`, **então** o item traz `ultimo_cron: null`, `pode_refazer: false` e um `erro_ultimo_cron` com a mensagem; a falha não vira "cron ok" nem lista vazia, e os outros syncs continuam listados. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-5 | **Dado** um usuário `authenticated` sem `app_metadata.licitagym_role = 'admin'`, **ou** a chamada com `SYNC_CRON_SECRET` (cron), **quando** chama `refazer`, **então** recebe 403; **e sem token**, 401. Em nenhum desses casos há chamada ao GitHub. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-6 | **Dado** `GITHUB_ACTIONS_TOKEN` ausente, **quando** o admin chama `refazer`, **então** recebe 500 com "Disparo do coletor não configurado (GITHUB_ACTIONS_TOKEN)."; o token nunca aparece em nenhuma resposta, nem quando o GitHub devolve erro. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-7 | **Regressão:** **dado** o item `coletor-pncp`, **quando** o admin chama `rodar`, **então** continua sendo um `workflow_dispatch` com `{modo: "leads", dry_run: "false", rapido: "true"}`, como hoje. | Deno `tests/supabase/functions/api_syncs_test.ts` |
| CA-8 | **Dashboard:** **dado** `pode_refazer: true`, **quando** o `SyncView` renderiza o card do Coletor PNCP, **então** aparece o botão "Refazer o cron de DD/MM" (data de `ultimo_cron.created_at` no horário de Brasília; o run escolhido pode não ser o de hoje) junto com a conclusão e a duração de cada etapa (`completed_at − started_at`, como o GitHub devolveu; etapa sem `completed_at` aparece "na fila" quando o `status` é `queued`/`waiting`/`pending`/`requested` e "em andamento" nos outros casos, sem duração; o GitHub preenche `started_at` até em etapa que espera na fila, como na resposta de produção de 16/10); com `pode_refazer: false` o botão não aparece, e com `erro_ultimo_cron` o card mostra o erro, não um estado "ok". | vitest `src/test/sync-view-refazer.test.tsx` (repo `n4rch6pjt9-rgb/Dashboard---LicitaGym`) |

### Cobertura (implementação, 16/10/2026)

Backend: `tests/supabase/functions/api_syncs_test.ts`, 28 testes passando (suíte Deno: 800). Dashboard:
`src/test/sync-view-refazer.test.tsx`, 4 testes (vitest: 418).

| CA | Testes |
|---|---|
| CA-1 | "CA-1: último cron agendado em failure / cancelled / timed_out libera refazer e traz as etapas como o GitHub devolveu" |
| CA-2 | "CA-2: cron em success…", "…run do workflow na fila ou rodando bloqueia…", "…o próprio cron ainda rodando…", "…run criado há 30 dias ou mais…", "…passou de 50 re-runs…", "…run antigo refeito no GitHub e ainda rodando…" |
| CA-3 | "CA-3: refazer faz um único POST rerun-failed-jobs…", "CA-3: GitHub recusa o rerun → erro, nunca 'refeito'" |
| CA-4 | "CA-4: leitura do GitHub falha…", "CA-4: timeout…", "CA-4: GitHub 200 com lista fora do formato vira erro…" |
| CA-5 | "CA-5: refazer por usuário sem papel admin 403, pelo cron 403 e sem token 401…" |
| CA-6 | "CA-6: refazer sem GITHUB_ACTIONS_TOKEN…", "CA-6: o token nunca aparece…" |
| CA-7 | "CA-7: rodar coletor-pncp continua um workflow_dispatch rápido, sem rerun" |
| CA-8 | os 4 testes "CA-8: …" do Dashboard (botão "Refazer o cron de DD/MM", etapas com conclusão e duração, motivo, erro, recusa do servidor) |

## Fora de escopo

- Disparo completo novo (`rapido: "false"`, modo `todos`) pela tela. O Marcelo decidiu em 16/10 refazer só as etapas
  que falharam.
- Retry automático no próprio workflow (`coletor-pncp.yml`).
- Resolver o modo `monitorar` estourando o tempo. A janela "Coleta manual falhas log" estuda isso, e a decisão
  (menos páginas, ou cron diário rápido + completo semanal) ainda está com o Marcelo. Enquanto não houver decisão, refazer
  uma etapa que caiu por tempo tende a cair de novo (ver perguntas).
- Corrigir o texto "Todo dia às 06:00" para o atraso real do GitHub. Isso entra junto com "api-syncs mostrar o cron real"
  da spec 0024 (#363).
- Mexer no grupo de concorrência `coletor-pncp` (decisão do Marcelo, #377).

## Impacto em dados

- **Migration:** não.
- **Tabelas/views/funções tocadas:** nenhuma no banco. O re-run grava em `licitacoes_externas` como qualquer run do
  coletor, com `ingestao_origem` igual ao do run original. `ORIGEM` sai de `github.event_name` e continua `schedule` →
  `cron` no re-run. Não medido em um re-run de verdade: o CA de produção confere isso no primeiro uso.
- **ACL/RLS:** nenhuma. O acesso continua o mesmo da `api-syncs`: cron (`SYNC_CRON_SECRET`) ou admin da plataforma.
  `refazer` é só do admin: o cron recebe 403 (CA-5).
- **Backfill/reprocessamento:** não. O re-run refaz só os jobs que falharam, com o mesmo commit (`head_sha`) e o mesmo
  workflow do run original, e não com o da `main` atual.
- **Edge Functions republicadas no merge:** todas (a integração republica o repositório inteiro). Muda o código só da
  `api-syncs` (`index.ts` e `catalogo.ts`).
- **GitHub:** `GITHUB_ACTIONS_TOKEN` (fine-grained) precisa de Actions read e write no repositório. O write já existe
  para o `workflow_dispatch`. Não medido se o read do token devolve a lista de runs: conferir antes do merge.
- **Contrato com o Dashboard:** muda. O `listar` ganha `ultimo_cron`, `pode_refazer` e `erro_ultimo_cron` no item
  `coletor-pncp`, e entra a ação `refazer`. Hoje `src/data/syncsApi.ts` só lê `slug`, `funcao`, `titulo`, `faz`, `cron`,
  `disparavel` e `aviso`, e ignora o resto, então o backend pode ir antes sem quebrar o front. O PR do backend vai ao ar
  antes do PR do Dashboard.
- **Dado oficial x derivado:** status, conclusão, etapas e datas vêm da API do GitHub como ela devolveu, sem tradução
  inventada. `pode_refazer` é derivado por regra escrita (CA-1/CA-2).
- **Spec 0024 (#363):** as duas mexem em `supabase/functions/api-syncs/index.ts` e `catalogo.ts`. Ordem combinada em
  16/10/2026: **a 0025 vai primeiro** (aprovada; a 0024 ainda está em rascunho, com perguntas em aberto e sem branch
  de implementação). A 0025 não muda o campo `cron` do `listar`; ele continua texto. A 0024, que troca `cron` por
  objeto, rebaseia sobre a 0025 e mantém `ultimo_cron`, `pode_refazer` e `erro_ultimo_cron`.

## Respostas do Marcelo (16/10/2026)

1. **Run que conta:** o último run agendado, de quando for. Sem janela de 24 h.
2. **`cancelled` também libera o botão**, seja por timeout, cancelamento manual ou fila de concorrência (CA-1).
3. **Sem limite de tentativas.** A precisão do `monitorar` ainda não é a que deve ser; a melhora virá do Agente de
   Edital, quando o treinamento dele terminar. Fora desta spec.
4. **Bloquear `refazer`** quando houver run do workflow em `queued`/`in_progress` (CA-2).
5. **Conferir** se o `rerun-failed-jobs` refaz job `cancelled`. Ver "Verificação antes do merge".
6. **Só admin** (CA-5).
7. **O card mostra também a duração de cada etapa** (CA-8). O rótulo do botão passa de "Refazer o cron de hoje" para
   "Refazer o cron de DD/MM", com a data do run escolhido. Achado do Codex no #382: o último run agendado pode ser de
   outro dia (atraso do GitHub ou cron que não rodou), e o re-run usa o commit daquele run.

## Verificação antes do merge

- **Job `cancelled` no re-run (resposta 5).** Conferido em 16/10/2026, sem conclusão. A documentação do endpoint
  ([REST: re-run failed jobs](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#re-run-failed-jobs-from-a-workflow-run))
  diz só que ele refaz "all of the failed jobs and their dependent jobs"; não fala de job `cancelled`. Ninguém testou no
  run real de 15/10 (`38746383473`), porque refazê-lo gravaria em produção. A implementação testa num run descartável:
  `workflow_dispatch` com `dry_run: "true"`, cancela uma etapa e chama `rerun-failed-jobs`. Esse run entra no grupo
  `coletor-pncp`, então rodar fora da janela do cron e sem outro run na fila. Registrar o resultado no PR.
  - Se o GitHub refizer o job `cancelled`: segue como na spec.
  - Se recusar: o `refazer` devolve o erro do GitHub como erro (nunca "refeito"), e a spec volta ao Marcelo para
    decidir o caso `cancelled` antes do merge.
- **Permissão do token.** A documentação não diz qual permissão fine-grained o endpoint exige. Conferir que
  `GITHUB_ACTIONS_TOKEN` lista os runs e refaz jobs, no mesmo teste descartável.

## Perguntas em aberto

- nenhuma (a resposta 5 virou a verificação acima, que precisa estar registrada no PR antes do merge)
