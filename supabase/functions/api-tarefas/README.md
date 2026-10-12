# api-tarefas

Tarefas da equipe por licitação, em cima do catálogo de tarefas da Lei 14.133 (#252, `specs/0019-tarefas-equipe-instancia-por-certame.md`).
Tela: Dashboard #72.

`POST` com JWT do usuário. A função resolve a empresa por `_shared/tenant.ts` e acessa o banco com `service_role`.

| Ação | Corpo | Quem pode | Resposta |
|---|---|---|---|
| `catalogo_liberadas` | `licitacao_id` e um entre `fase` (`F05`) ou `evento` (`ATA_HABILITACAO`) | admin ou operação | `{ bloqueio, tarefas }`. Prévia que não grava. Cada tarefa traz `codigo`, `fase_codigo`, `parent_codigo`, `titulo`, `natureza`, `prazo_*`, `aplicavel` (`true`, ou `null` quando a condição não foi verificada) e `base_legal`, no mesmo formato por fase ou por evento |
| `tarefas_liberar` | igual à anterior | admin da empresa ou desenvolvedor | `{ criadas, existentes }`. Fora do pipeline: 404. Regulamento nulo ou sem catálogo: 409, com `bloqueio` |
| `tarefas_listar` | `licitacao_id?`, `status?`, `minhas?` | admin vê as do Kanban; operação vê só as dela | `{ tarefas, truncado }`: só licitação que ainda está no pipeline da empresa; até 500, mais recentes primeiro, com o resumo do catálogo; `truncado` avisa quando havia mais |
| `tarefa_atualizar` | `id`, `status?`, `prazo_em?` (data e hora ISO com fuso, ex.: `2026-10-20T18:00:00-03:00`; data pura dá 400) | admin: qualquer tarefa; operação: só o status das dela | `{ tarefa }`. Com `prazo_em`, a situação vira `manual`, com `prazo_informado_por` e `prazo_informado_em` |
| `tarefa_atribuir` | `id`, `user_id` (UUID ou `null`) | só admin | `{ tarefa }`. O usuário precisa ser membro ativo da empresa (senão 400), e `responsavel_papel` passa ao papel dele; `null` devolve a tarefa à fila dos admins |

Regras, todas no banco (`tarefas_equipe_liberar`):
- Só licitação no pipeline da empresa recebe tarefa.
- Só os regulamentos `LEI_14133` e `LEI_14981` têm catálogo. Regulamento nulo bloqueia até ele chegar pela coleta do PNCP (`amparo_legal`, spec 0020) ou pela consulta sob demanda ao entrar em Triagem (spec 0018).
- O contexto do certame usa só dado oficial: `srp` do PNCP (`raw->>'srp'`).
- Quando falta uma chave no contexto, a tarefa nasce com `condicao_verificada = null`. Quando a condição é falsa, ela não nasce.
- Liberar de novo não duplica: guarda a segunda origem e confirma a condição quando o dado chega.
- Tarefa de outra empresa responde 404.
- Nenhuma data de prazo é calculada. Os campos ficam assim:
  - `prazo_situacao`: `nao_calculado`, `definido_no_edital`, `sem_prazo_legal`, `imediato` ou `manual`;
  - `prazo_em`: preenchido só na situação `manual`.
- A tarefa nasce com `responsavel_papel = 'admin'` e sem pessoa atribuída.
