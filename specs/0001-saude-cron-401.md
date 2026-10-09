# 0001: Separar na saúde o 401 do cron (segredo divergente) dos demais erros HTTP

- **Status:** rascunho
- **Issue:** #245 (incidente de 08/10); spec gerada pelo fluxo `/spec` da Etapa 3 do preparo AI-native
- **Área:** migrations (saúde operacional), scripts (alerta)
- **Depende do ok do Marcelo:** sim (migration em produção)

## Problema

Em 08/10, das 06:13 às 07:43 UTC, as 12 chamadas do cron às Edge Functions receberam `401 Unauthorized`
(`private.cron_edge_chamadas`, consulta somente leitura em 08/10). O segredo do Vault (`sync_cron_secret`) e o env
`SYNC_CRON_SECRET` das funções ficaram diferentes, e a sync PNCP parou.

A saúde detectou erro, mas não a causa. Os 401 entram em `cron_http_erros_24h`, junto com 500 e 503: nas
72 h anteriores à consulta houve 12 respostas 401, 2 respostas 500 e 2 respostas 503. A issue #245 já estava aberta desde 07/10 por
outros críticos, então o alerta não mudou de forma visível. Um 401 do cron não é instabilidade: é configuração
errada, que não se resolve sozinha e para todas as funções ao mesmo tempo.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** uma linha em `cron_edge_chamadas` com `status_code = 401` nas últimas 24 h, **quando** `private.saude_operacional_resumo()` roda, **então** a verificação `cron_auth_401_24h` vem com `valor = 1` e `status = 'critico'`. | SQL `supabase/tests/saude_cron_auth_check.sql` (fixture em `begin … rollback`) |
| CA-2 | **Dado** só respostas 500/503 nas últimas 24 h, **quando** o resumo roda, **então** `cron_auth_401_24h` vem `ok` com `valor = 0`, e `cron_http_erros_24h` continua contando essas respostas. | SQL `supabase/tests/saude_cron_auth_check.sql` |
| CA-3 | **Dado** um 401 com mais de 24 h, **quando** o resumo roda, **então** ele não conta em `cron_auth_401_24h`. | SQL `supabase/tests/saude_cron_auth_check.sql` |
| CA-4 | **Dado** `cron_auth_401_24h` crítico, **quando** o resumo roda, **então** o `detalhe` lista job, função e horário, e a mensagem cita "segredo do cron (Vault `sync_cron_secret` x env `SYNC_CRON_SECRET`)" sem expor nenhum valor de segredo. | SQL `supabase/tests/saude_cron_auth_check.sql` |
| CA-5 | **Dado** o limiar novo, **quando** se consulta a ACL, **então** `private.saude_limiares` segue sem privilégio para `anon`/`authenticated`, e o resumo segue com EXECUTE só para `service_role`. | SQL `supabase/tests/saude_operacional_check.sql` (existente, deve continuar passando) |
| CA-6 | **Dado** um resumo com `cron_auth_401_24h` crítico, **quando** `scripts/saude-alerta.sh` roda com `DRY_RUN=1` e `SAUDE_JSON` fixo, **então** o título da issue proposta contém `cron_auth_401_24h`. | Deno `tests/supabase/saude_alerta_cron_auth_test.ts` (executa o script com JSON de fixture) |

## Fora de escopo

- Corrigir o segredo divergente: ação manual do Marcelo, descrita na #245.
- Rotação automática de segredo, ou sincronização entre Vault e env das Edge Functions.
- Mudar os limiares das outras verificações.

## Impacto em dados

- **Migration:** sim. `supabase/migrations/<timestamp>_saude_cron_auth_401.sql`, aditiva e idempotente: um `insert … on conflict do
  nothing` em `private.saude_limiares` (`atencao = 1`, `critico = 1`, `sem_dado = 'ok'`) e um `create or replace` de
  `private.saude_operacional_resumo()` com a medida nova. A assinatura e o retorno não mudam (cuidado com o 42P13 do #236).
- **Tabelas/views/funções tocadas:** `private.saude_limiares` (escrita só na migration); `private.saude_operacional_resumo()`
  e o invólucro `public.saude_operacional_resumo()` (`20261007133000`). Leitura pela `api-saude` (service_role).
- **ACL/RLS:** nenhuma mudança. Manter `security definer`, `search_path` fixo e EXECUTE só para `service_role`.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas, pela integração. Nenhuma muda de código.
- **Contrato com o Dashboard:** a `SaudeView` lista as verificações que recebe e passa a mostrar mais uma. Não muda o formato.
- **Dado oficial x derivado:** só derivado de `cron_edge_chamadas`. Nenhum valor estimado.

## Perguntas em aberto

- `critico = 1` (um único 401 já é crítico) está bom, ou prefere `critico = 2` para tolerar uma chamada isolada?
- O CA-6 exige rodar o `saude-alerta.sh` num teste Deno com `DRY_RUN`. Vale manter, ou basta o SQL (CA-1 a CA-5)?
