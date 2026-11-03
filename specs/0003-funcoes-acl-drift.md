# 0003: Revogar EXECUTE de anon/authenticated nas funções que divergem das migrations

- **Status:** em implementação
- **Issue:** nenhuma (achado de 09/10 na investigação da #245)
- **Área:** migrations (ACL), checks SQL
- **Depende do ok do Marcelo:** sim. Implementação pedida em 09/10 ("sim, abre o PR"). O **merge** aplica em produção.

## Problema

Medição só de leitura em produção, em 09/10/2026:
- **42 funções fora do previsto** (14 de `private`, 28 de `public`; 81 pares função × papel) são executáveis por
  `anon` e/ou `authenticated`, todas por GRANT explícito com grantor `postgres` (nenhuma via PUBLIC ou ACL nula).
  Exemplos: `private.cron_chamar_edge`, `private.acquire_sync_lock` e `public.fn_escopo_match_atualizar`.
- **As migrations dizem o contrário:** elas revogam o EXECUTE desses papéis. Num banco limpo, gerado só pelas
  migrations, apenas 10 funções são executáveis por esses papéis, e todas são intencionais.
- **Origem provável:** o painel do Supabase (Data API, "Exposed functions" ou exposição automática). O banco não
  registra quando aconteceu.
- **Por que não é explorável hoje:**
  - `anon` e `authenticated` não têm USAGE em `private`;
  - as 4 SECURITY DEFINER do drift (`acquire_http_slot`, `acquire_sync_lock`, `report_http_rate_limit`,
    `saude_operacional_resumo`) estão em `private`; as de `public` são SECURITY INVOKER e esses papéis não têm grant
    em tabela.

  Mesmo assim, a defesa em camadas sumiu, e produção diverge das migrations.
- **Efeito colateral encontrado:** três funções de `private` (`marca_normalizar`, `marca_resolver` e
  `cron_coletar_respostas`) aparecem em produção como membros da extensão `supabase_vault`. Uma checagem que pule
  "função de extensão" pularia essas três.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** GRANT EXECUTE a `anon`/`authenticated` em todas as funções de `public`/`private` (simulação de produção), **quando** a migration roda, **então** só as 10 da lista intencional continuam executáveis por esses papéis. | `funcoes_acl_check.sql` (falha antes, passa depois) |
| CA-2 | **Dado** uma função de `private` registrada como membro de uma extensão de outro schema, **então** ela também perde o EXECUTE de `anon`/`authenticated`. | Simulação com `alter extension ... add function` + check |
| CA-3 | `service_role` continua executando as funções que as Edge Functions chamam (`acquire_http_slot`, `report_http_rate_limit`, `acquire_sync_lock`, `saude_operacional_resumo`), e `authenticated` mantém as 8 intencionais. | `funcoes_acl_check.sql` blocos 2 e 3 |
| CA-4 | **Dado** `anon`, **quando** chama uma função revogada, **então** recebe `permission denied`. | Teste manual registrado no PR |
| CA-5 | Reaplicar a migration não muda nada: "0 concessões revogadas". | `validar-migrations.sh` (2ª aplicação) |
| CA-6 | **Dado** EXECUTE que o REVOKE não remove (via PUBLIC ou outro grantor), **então** a migration aborta (pós-checagem), em vez de terminar incompleta. | Simulação com `grant ... to public` |

## Fora de escopo

- `taxonomia_bloco` e `update_updated_at_column` herdam EXECUTE de PUBLIC desde a criação. Ficam como estão.
- Os default privileges de `postgres` em `public`, que dão grant automático a tabelas e sequências novas: o painel
  controla isso pela opção "Automatically expose new tables", já desligada pelo Marcelo em 09/10.
- A migração da API para o schema `api`, que precisa de spec própria.

## Impacto em dados

- **Migration:** `supabase/migrations/20261009120000_funcoes_acl_drift.sql`. Só faz REVOKE e é idempotente.
- **ACL:** remove o EXECUTE de `anon`/`authenticated` em 42 funções (81 concessões). Não mexe em `service_role`, `postgres`
  nem PUBLIC.
- **Clientes:** todas as chamadas `.rpc()` das Edge Functions e do coletor Python usam `service_role`. O Dashboard
  não chama RPC direto.
- **Backfill:** não há. **Contrato com o Dashboard:** não muda.

## Perguntas em aberto

Nenhuma.
