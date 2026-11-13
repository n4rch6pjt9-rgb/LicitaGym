# 0063: Fechar run órfão do Sistema S e tirar o sesc_senac_rs do limite do runner

- **Status:** em implementação (aprovada em 13/11/2026; PR em draft)
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades: as licitações do Sistema S entram no
  radar pelo coletor Paradigma). A regra de foco está suspensa desde 11/11/2026 (ver "Situação" no `ESCOPO.md`).
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** migrations | coletor | observabilidade (saúde operacional) | workflow GitHub Actions
- **Depende do ok do Marcelo:** sim (migration em função `SECURITY DEFINER`, mudança na saúde operacional e decisão de
  onde roda o `sesc_senac_rs`)

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template. Específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `docs/produto/ESCOPO.md` (módulo 1) | o que a spec alimenta |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções de migration e de teste SQL |
| 8 | `services/coletor-externo/README.md` (seção Sistema S / Paradigma e Cloud Run Jobs) | como o coletor roda hoje |
| 8 | `services/coletor-externo/coletor/paradigma.py` (`main`, `RegistroColeta`, `_executar`, `coletar`) | registro da execução, SIGTERM, laço por processo |
| 8 | `.github/workflows/coletor-sistema-s.yml` | lote agendado, `timeout 70m`, fontes fora do lote |
| 8 | `supabase/migrations/20261108170000_coleta_externa_run_rpc.sql` | `coleta_externa_iniciar` (fecha órfão só da mesma fonte) e `coleta_externa_finalizar` |
| 8 | `supabase/migrations/20261111120000_pca_radar_pgc_campos.sql` | definição mais recente das métricas da saúde (`coleta_externa_dias_sem_sucesso`) |
| 8 | `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql` | tabela `private.coleta_externa_run` e `fontes_externas` |
| 8 | `.github/workflows/saude.yml` | `SAUDE_VERIFICACOES_ESPERADAS` (linha 42 na `main` de 13/11) |
| 8 | `specs/0062-pca-fila-falha-visivel.md` | também recria a função de saúde: ordem de merge |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa |

## Problema

Medido em 13/11/2026 (consulta somente leitura no SQL Editor, colada pelo Marcelo, por volta de 13:55 UTC, e logs do
GitHub Actions):

- `private.coleta_externa_run` tem uma linha do `sesc_senac_rs` em `executando` desde 12/11 18:18 UTC (mais de 19 h).
  O job `coletar (sesc_senac_rs)` da execução agendada 43271946803 foi cancelado às 19:18 UTC pelo limite de 60 min do
  job; o GitHub matou o `python3` ("Terminate orphan process") antes do `coleta_externa_finalizar`. A execução anterior
  da mesma fonte (11/11 17:58) já tinha terminado igual e só foi fechada como `incompleta` ("execução não fechada em
  6 h") quando a de 12/11 abriu.
- A linha não fecha sozinha: `coleta_externa_iniciar` só fecha órfãos **da mesma fonte**, e o `sesc_senac_rs` saiu
  do lote agendado em 12/11 (comentário do `coletor-sistema-s.yml`). Disparo manual não registra execução
  (`RegistroColeta` com `sb=None` quando a origem não é `cron`), então nem o disparo manual de 12/11 19:39
  (run 43292439869) a fechou.
- A saúde não vê: `coleta_externa_dias_sem_sucesso` estava `ok` (0,8 dia) porque considera só fontes que já
  concluíram alguma vez; nenhuma métrica olha execução presa em `executando`.
- O `sesc_senac_rs` não cabe no runner: o disparo manual de 12/11 rodou 63 min (19:40 a 20:43 UTC) e foi cancelado;
  gravou licitações até 20:43 (`max(created_at)` da fonte = 20:43:16), com HTTP 500 e 502 do portal no caminho e sem
  log de progresso entre 19:41 e 20:02. O workflow registra 14 jobs da fonte cancelados por tempo sem nenhuma
  execução concluída em 15 dias (comentário do `coletor-sistema-s.yml`, 12/11). Quantos processos a fonte lista por
  execução: não medido.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `public.coleta_externa_iniciar` passa a fechar como `incompleta` toda linha `executando` com `started_at` há mais de 6 h, **de qualquer fonte**, antes de abrir a nova | igual à atual | `bigint` (id), igual | igual (`22004`) | `service_role` (ACL inalterada) |
| K-2 | Fechamento independente de coleta nova: função `private.coleta_externa_fechar_orfaos()` (mesma regra do K-1), chamada por um job `pg_cron` (frequência na pergunta 2) | nenhuma | quantidade de linhas fechadas | — | só `postgres`/`pg_cron`; sem grant a `anon`, `authenticated` ou `service_role` |
| K-3 | Verificação de saúde `coleta_externa_executando_horas`: horas da execução `executando` mais antiga (0 quando não há), com detalhe por fonte; limiares em tabela como as demais | — | linha na `saude_operacional_resumo()` | — | quem já lê a saúde (inalterado) |
| K-4 | `saude.yml`: `coleta_externa_executando_horas` entra em `SAUDE_VERIFICACOES_ESPERADAS` | — | — | — | workflow |
| K-5 | Coletor Paradigma: log `INFO` de progresso por processo (`fonte`, posição/total quando conhecido, `nCdOrigem`, tempo decorrido) e no fim de cada termo | — | linhas de log | — | coletor |
| K-6a | Edge Function `sync-disparar-coletor` (nome provisório): `requireCronAuth`; chama `POST /repos/{owner}/{repo}/actions/workflows/coletor-sistema-s.yml/dispatches` com `ref=main` e inputs fixos (`fonte=sesc_senac_rs`, `origem=cron`, `paginas` da pergunta 3); token do GitHub só em secret (`Deno.env.get`), nunca em log ou resposta | POST com secret de cron | 202 com o status HTTP do GitHub (sem corpo dele) | 401 sem secret; 502 se o GitHub recusar | `pg_cron` |
| K-6b | Job `pg_cron` que chama a K-6a no horário da pergunta 3 (`net.http_post`, secret de cron do Vault, como os demais crons do repo) | — | linha em `cron.job` | — | `postgres` |
| K-6c | `coletor-sistema-s.yml`: input `origem` (`manual` padrão, `cron` aceito) repassado ao `--origem`, para o disparo agendado registrar em `coleta_externa_run`; o job do RS termina dentro dos 70 min (`--paginas` menor) | input do `workflow_dispatch` | execução registrada e fechada | — | workflow |
| K-7 | `coleta_externa_dias_sem_sucesso` considera toda fonte com `fontes_externas.ativo = true` (na implementação: e `plataforma = 'paradigma'` e `modo_coleta <> 'bloqueado'`, ver "Cobertura na implementação"); fonte ativa sem nenhuma conclusão = crítico, com o slug no detalhe | — | linha na `saude_operacional_resumo()` | — | quem já lê a saúde (inalterado) |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** uma linha `executando` da fonte A com `started_at` há 7 h, **quando** `coleta_externa_iniciar` abre uma execução da fonte B, **então** a linha de A fica `incompleta` com `finished_at` preenchido e `detalhe_erros.erro` = "execução não fechada em 6 h (processo interrompido)". | SQL `supabase/tests/coleta_externa_run_rpc_check.sql` |
| CA-2 | K-1 | **Dado** uma linha `executando` da fonte A com `started_at` há 1 h, **quando** `coleta_externa_iniciar` abre B, **então** a linha de A continua `executando` (regressão: execução viva não é fechada). | SQL `supabase/tests/coleta_externa_run_rpc_check.sql` |
| CA-3 | K-2 | **Dado** uma linha `executando` há 7 h e nenhuma coleta nova, **quando** `private.coleta_externa_fechar_orfaos()` roda, **então** ela devolve 1 e a linha fica `incompleta`; rodando de novo, devolve 0 (idempotente). | SQL `supabase/tests/coleta_externa_orfaos_check.sql` |
| CA-4 | K-2 | **Dado** os papéis `anon`, `authenticated` e `service_role`, **quando** se consulta `has_function_privilege(..., 'EXECUTE')` em `private.coleta_externa_fechar_orfaos()`, **então** é `false` para os três; e o job `pg_cron` existe com o comando esperado. | SQL `supabase/tests/coleta_externa_orfaos_check.sql` |
| CA-5 | K-3 | **Dado** uma linha `executando` há 7 h, **quando** se lê `saude_operacional_resumo()`, **então** `coleta_externa_executando_horas` vem com valor ≥ 7 e status conforme os limiares; sem linha `executando`, valor 0 e `ok`. | SQL `supabase/tests/saude_coleta_externa_executando_check.sql` |
| CA-6 | K-3, K-4 | **Dado** a resposta da `api-saude`, **quando** o teste lista as verificações, **então** `coleta_externa_executando_horas` está presente e está em `SAUDE_VERIFICACOES_ESPERADAS`. | Deno `tests/supabase/functions/api_saude_test.ts` |
| CA-9 | K-7 | **Dado** uma fonte com `ativo = true` sem nenhuma execução concluída e outra concluída há 1 dia, **quando** se lê `saude_operacional_resumo()`, **então** `coleta_externa_dias_sem_sucesso` vem `critico` com o slug da primeira no detalhe; com a primeira `ativo = false`, vem `ok`. | SQL `supabase/tests/saude_coleta_externa_executando_check.sql` |
| CA-7 | K-5 | **Dado** um portal falso com 3 processos, **quando** `coletar` roda, **então** o log tem 3 linhas `INFO` de progresso com o `nCdOrigem` de cada processo, sem chamada a API real. | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-8 | K-6c (movido para a 0064) | **Dado** o disparo agendado do `sesc_senac_rs`, **quando** o job roda, **então** a execução fecha em `coleta_externa_run` com status final (nunca fica `executando`) antes dos 70 min. Prova: pytest do `--origem cron` e uma execução real registrada no PR (id da run e status). | pytest `services/coletor-externo/tests/test_paradigma.py` + evidência no PR |
| CA-10 | K-6a (movido para a 0064) | **Dado** uma chamada sem o secret de cron, ou com JWT de usuário, **quando** chega à `sync-disparar-coletor`, **então** responde 401 e não chama o GitHub (negativo de acesso). | Deno `tests/supabase/functions/sync_disparar_coletor_test.ts` |
| CA-11 | K-6a (movido para a 0064) | **Dado** o secret de cron válido e um `fetch` falso, **quando** a função roda, **então** faz um único POST ao endpoint `dispatches` com `ref=main` e os inputs fixos; com o GitHub respondendo 4xx, devolve 502 sem repassar o corpo nem o token. | Deno `tests/supabase/functions/sync_disparar_coletor_test.ts` |

### Cobertura na implementação (13/11/2026)

| CA | Teste |
|---|---|
| CA-1, CA-2 | `supabase/tests/coleta_externa_run_rpc_check.sql` (blocos "Spec 0063, CA-1" e "CA-2") |
| CA-3, CA-4 | `supabase/tests/coleta_externa_orfaos_check.sql` (jobs só onde há `pg_cron`; o Postgres da CI não tem) |
| CA-5, CA-9 | `supabase/tests/saude_coleta_externa_executando_check.sql` |
| CA-6 | `tests/supabase/functions/api_saude_test.ts` → "CA-6: ..." |
| CA-7 | `services/coletor-externo/tests/test_paradigma.py::test_ca7_log_info_de_progresso_por_processo` |
| CA-8, CA-10, CA-11 | saíram com o K-6 para a spec 0064 (ver abaixo) |

**K-6 (K-6a, K-6b, K-6c) saiu desta spec (decisão do Marcelo, 13/11/2026):** virou a spec 0064
(`specs/0064-sistema-s-coleta-camadas.md`, coleta do Sistema S por portal e em camadas). Esta spec entrega K-1 a K-5
e K-7.

K-7 na implementação: "fonte ativa" = `ativo = true` **e** `plataforma = 'paradigma'` **e** `modo_coleta <> 'bloqueado'`.
Sem esse recorte, `pncp`, `sesi_pe`, `sesi_pa`, `sesc_dn`, `cn_sesi` (nunca rodam no coletor Paradigma) e `fiemg`
(bloqueada) ficam `ativo = true` pelo default e deixariam a métrica crítica para sempre. Recorte recomendado pela
sessão de orquestração em 13/11/2026; confirmação do Marcelo pendente.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (função `SECURITY DEFINER`) | skill `verificar-producao` + `get_advisors` |
| K-2 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL da função, `pg_cron`) | skill `verificar-producao` + `get_advisors` |
| K-3 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-codigo` | skill `verificar-producao` |
| K-4 | `/spec` | `/implement` | Deno `api_saude_test.ts` | `revisor-codigo` | skill `verificar-producao` |
| K-5 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | skill `verificar-producao` (próxima coleta) |
| K-7 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-codigo` | skill `verificar-producao` |
| K-6a | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` (auth, token do GitHub) | skill `verificar-producao` (POST sem token → 401) |
| K-6b | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` | skill `verificar-producao` |
| K-6c | `/spec` | `/implement` | pytest + execução real | `revisor-codigo` | skill `verificar-producao` |

## Fora de escopo

- Fechar à mão a linha órfã que existe hoje: o K-2 a fecha na primeira execução do job. Se o Marcelo quiser antes,
  fecha à mão e registra em migration (regra do `CLAUDE.md`).
- `detalhe_erros` vazio nas execuções `concluida_com_erros` (`sescsp` 8, `fiesc` 8, `firjan` 3, `fieb` 1 em 12/11):
  vira issue própria.
- `fiergs` e `fiemt` fora do lote por bloqueio do host: seguem como estão (bloqueio não se contorna).
- A falha da fila do PCA que não conta erro: spec 0062.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_coleta_externa_run_orfaos.sql`: recria
  `public.coleta_externa_iniciar` (K-1), cria `private.coleta_externa_fechar_orfaos()` e o job `pg_cron` (K-2),
  acrescenta a métrica e os limiares da saúde (K-3), recriando a função de métricas a partir da definição de produção.
  Aditiva e idempotente (`create or replace`, `cron.unschedule` antes do `cron.schedule`).
- **Tabelas/views/funções tocadas:** `private.coleta_externa_run` (escrita: coletor via RPC e o job novo; leitura:
  saúde); `public.coleta_externa_iniciar`; função de métricas da saúde e tabela de limiares.
- **ACL/RLS:** `coleta_externa_iniciar` mantém EXECUTE só para `service_role`; a função nova sem EXECUTE para `anon`,
  `authenticated` e `service_role`. RLS da tabela inalterada.
- **Backfill/reprocessamento:** não. A primeira execução do job fecha a linha do `sesc_senac_rs` aberta desde 12/11
  (contagem antes/depois no PR: linhas `executando` com mais de 6 h).
- **Edge Functions republicadas no merge:** todas (regra do merge); `api-saude` muda de resposta (verificação nova).
  A função nova `sync-disparar-coletor` (K-6a) e o job do K-6b **não** entram: o K-6 foi para a spec 0064
  (ver "Cobertura na implementação"). O secret `GITHUB_DISPATCH_TOKEN` já gravado fica sem uso por esta spec.
- **Contrato com o Dashboard:** o bloco de saúde (só admin da plataforma) ganha uma linha; sem mudança de campo.
- **Dado oficial x derivado:** nenhum dado oficial muda; status e horas são derivados de `coleta_externa_run`.
- **Ordem com a 0062:** as duas recriam a função de métricas da saúde. A segunda a entrar parte da definição de
  produção que inclui a primeira.

## Decisões do Marcelo

- 13/11/2026: pediu esta spec depois da investigação do `sesc_senac_rs` preso.
- 13/11/2026: K-1 e K-2 entram juntos.
- 13/11/2026: o job do K-2 roda de hora em hora.
- 13/11/2026: limiares do K-3: atenção ≥ 2 h, crítico ≥ 7 h.
- 13/11/2026: `coleta_externa_dias_sem_sucesso` passa a contar as fontes ativas de `fontes_externas`
  (`ativo = true`); fonte ativa sem nenhuma conclusão conta como crítica. Isso vira o contrato K-7.
- 13/11/2026: o `sesc_senac_rs` roda por `pg_cron` → Edge Function → `workflow_dispatch` do
  `coletor-sistema-s.yml` (K-6a a K-6c). Continua no runner, então precisa caber nos 70 min.

- 13/11/2026: token do GitHub criado pelo Marcelo, validade de 90 dias, guardado como secret das Edge Functions
  `GITHUB_DISPATCH_TOKEN` (a K-6a lê só esse nome). A data exata de expiração é a que o GitHub mostra no token.

- 13/11/2026: o limite do órfão continua 6 h (K-1 e K-2).
- 13/11/2026: a migration marca `fiergs`, `fiemt` e `sesc_senac_rs` com `fontes_externas.ativo = false` (K-7).
  `ativo` não é lido pelo coletor nem pelas Edge Functions na `main` de 13/11, então a coleta não muda; só a métrica
  deixa de cobrar essas fontes. Consequência: a saúde não cobra conclusão do `sesc_senac_rs` (o K-3 ainda acusa run
  preso); quando o K-6 concluir execuções do RS, voltar `ativo = true` é decisão à parte.
- 13/11/2026: disparo do RS uma vez por dia, fora do horário do lote, com `--paginas 1`; se passar de 70 min, dividir
  por termo.
- 13/11/2026: secret `GITHUB_DISPATCH_TOKEN` gravado no painel (confirmação "Successfully updated secret").

- 13/11/2026: quem renova o `GITHUB_DISPATCH_TOKEN` é o Marcelo (validade de 90 dias). Token vencido aparece pelo
  próprio K-6a: o GitHub responde 401, a função devolve 502 e o `cron_http_erros_24h` da saúde acusa.

## Perguntas em aberto

- nenhuma
