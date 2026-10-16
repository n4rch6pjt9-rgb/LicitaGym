# 0026b: Criar a rota e a tela de licitações suspensas, e só depois tirar suspensas e encerradas de Oportunidades

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** edge-functions + dashboard-contrato
- **Sequência:** 0026a (situação atual) → 0026b (esta) → 0027 (verificação de retomada das suspensas)
- **Depende do ok do Marcelo:** sim (muda o que aparece em Oportunidades e o contrato com o Dashboard)

## Problema

Compra suspensa aparece em Oportunidades como se o fornecedor pudesse disputá-la. Medição de 16/10/2026 (somente
leitura, `prioridade` gravada): **28** suspensas em `monitorar`, todas visíveis em Oportunidades, sendo 19 "Suspensa"
(oficial do PNCP) e 9 "Suspensa (documento)". A 0026a passa a calcular `situacao_atual.codigo` = `suspensa` também
pela leitura do Portal de Compras Públicas (status ou operação), então o número pode mudar depois dela.

**Decisões do Marcelo em 16/10/2026:**
- **Homologada vira histórico e sai de Oportunidades. Suspensa também sai** e vai para uma rota própria de licitações
  suspensas, com API.
- **Ordem:** primeiro a tela de suspensas, **depois** a mudança que tira as suspensas de Oportunidades.

Homologadas: pela medição, todas já estão em `historico` e fora da lista. Esta spec só garante a regra também quando
a encerrada vem da leitura do portal (`codigo` = `encerrada`).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um usuário com vínculo ativo, **quando** chama `api-dashboard-oportunidades?action=suspensas`, **então** recebe só as compras com `situacao_atual.codigo` = `suspensa`, cada uma com `desde`, a fonte, e o documento (título, data e link do PNCP) ou a leitura do portal (status, operação, `lido_em`) que suspendeu; paginação e contagem como no `list`; sem token, 401; sem vínculo, 403. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-2 | **Dado** a rota de suspensas, **quando** o usuário abre a tela "Suspensas" no menu do Dashboard, **então** vê a lista com órgão, objeto, "Suspensa desde DD/MM", a fonte e o link para a oportunidade; lista vazia mostra estado vazio, e erro da API mostra erro, nunca lista vazia. | vitest `src/test/suspensas.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-3 | **Dado** o front com a tela de suspensas já em produção, **quando** o usuário lista Oportunidades (`list`, lista e contagem), **então** compras com `codigo` = `suspensa` ou `encerrada` não aparecem; `get` por id continua respondendo, para links do BI, do pipeline e da tela de suspensas. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-4 | **Dado** a ordem decidida, **quando** os PRs são publicados, **então** vão ao ar nesta sequência: (1) backend com `action=suspensas`, sem mudar o `list`; (2) Dashboard com a tela; (3) backend com o filtro do `list` (CA-3). O PR (3) só abre depois de (2) conferido em produção. | checklist no PR (3), com a contagem do `list` antes e depois |
| CA-5 | **Dado** uma compra suspensa que está no pipeline de uma empresa, **quando** ela sai de Oportunidades, **então** continua no pipeline sem mudança de etapa; a tela do pipeline mostra o selo "Suspensa desde DD/MM" vindo de `situacao_atual`. | Deno `tests/supabase/functions/api_pipeline_test.ts` + vitest do card |

## Fora de escopo

- O cálculo de `situacao_atual` e a leitura da operação do portal: 0026a.
- **Reverificar a suspensa e devolvê-la quando retomar** (cron pela regra do documento): 0027. Até lá, a suspensa
  volta para Oportunidades quando a coleta diária ou o `sync-portal-compras` mudarem a situação, como hoje.
- Notificar o usuário quando uma suspensa retomar.

## Impacto em dados

- **Migration:** não (a rota lê a view da 0026a).
- **Tabelas/views/funções tocadas:** `api-dashboard-oportunidades` (`action=suspensas` e filtro do `list`);
  `api-pipeline` só lê `situacao_atual`.
- **ACL/RLS:** nenhuma mudança.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas, nos PRs (1) e (3).
- **Contrato com o Dashboard:** muda. Entra `action=suspensas`; o `list` deixa de trazer suspensas e encerradas só
  no PR (3), depois da tela no ar.
- **Dado oficial x derivado:** a rota mostra o documento ou a leitura do portal como vieram, com fonte e data.

## Perguntas em aberto

1. A tela de suspensas fica para todos os papéis (`admin` e `operacao`), como Oportunidades?
