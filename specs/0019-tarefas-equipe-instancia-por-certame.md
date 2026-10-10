# 0019: Tarefas da equipe: instância por certame em cima do catálogo 14.133

- **Status:** rascunho (10/10/2026)
- **Issue:** #252 (sub-issue da Dashboard #29; tela na Dashboard #72). Pré-requisito da spec 0018 (decisões 9 e 10).
- **Área:** migrations (tabela nova `tarefas_equipe` + funções), edge-functions (nova `api-tarefas`), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Migration de produção, função nova e as decisões da seção "Perguntas em aberto".

## Problema

O catálogo de tarefas do fornecedor (Lei 14.133) já está no banco: migrations `20260927100000` e `20260927100100`.
Em produção, em 10/10/2026, são 84 tarefas ativas em 12 fases, 44 eventos e as funções `catalogo_tarefas_da_fase()` e
`catalogo_tarefas_do_evento()`. **Não existe a instância por certame:** não há onde gravar que a empresa X tem a tarefa
"Registrar intenção de recorrer" na licitação Y, com responsável, prazo e status. A spec 0018 (tarefas padrão por etapa)
depende disso.

Medido em produção (só leitura, 10/10):
- **Chaves de condição usadas pelo catálogo:** `diferenca_5pct_segundo`, `empate`, `estrangeira`, `garantia_contratual`,
  `garantia_proposta`, `intervalo_minimo_lances`, `inversao_fases`, `mao_de_obra_exclusiva`, `me_epp`, `objeto`,
  `posicao`, `proposta_abaixo_85pct`, `servico_continuo`, `srp` e `vistoria_prevista`.
- **Dado oficial que já temos para essas chaves:** só `srp`, em `licitacoes_externas.objeto_registro_preco`. As demais
  não têm coluna.
- **Unidade de prazo das tarefas ativas:**
  - `definido_no_edital`: 38;
  - `sem_prazo_legal`: 23;
  - `dias_uteis`: 14;
  - `imediato`: 4;
  - `anos`: 4;
  - `meses`: 1;
  - `dias_corridos`: 0.

## Desenho

### 1. Tabela `public.tarefas_equipe` (uma linha = uma tarefa de uma empresa numa licitação)

| Coluna | Uso |
|---|---|
| `id` | identidade |
| `tenant_id` | FK `tenants(id)`, `on delete cascade` |
| `licitacao_id` | FK `licitacoes_externas(id)`, `on delete cascade` |
| `origem` | `catalogo` ou `empresa`. Esta spec só cria `catalogo`; `empresa` é da spec 0018 |
| `tarefa_codigo` | FK `tarefas_catalogo(codigo)`: obrigatório em `catalogo`, nulo em `empresa` |
| `titulo`, `descricao` | obrigatórios em `empresa`; em `catalogo` vêm do catálogo na leitura, sem cópia |
| `liberada_por_fase`, `liberada_por_evento` | o que liberou a tarefa (FK `processo_fases`, `processo_eventos`); nulos em `empresa` |
| `condicao_verificada` | resultado de `catalogo_condicao_avaliar` na liberação: `true` ou **nulo** ("condição não verificada"). `false` nunca é gravado: a tarefa não nasce |
| `contexto` | o contexto do certame usado na avaliação (jsonb), para explicar o selo |
| `prazo_situacao` | ver a seção 3 |
| `prazo_em` | data do prazo; só quando `prazo_situacao = manual` |
| `status` | `aberta` (padrão), `em_andamento`, `concluida`, `cancelada` |
| `responsavel_papel` | `admin` na criação (decisão 3 da 0018: fila de todos os admins) |
| `responsavel_user_id` | nulo até um admin atribuir; FK `auth.users(id)` |
| `criada_por`, `criada_em`, `atualizada_por`, `atualizada_em`, `concluida_em` | rastro mínimo |

- **Únicas:** uma instância por `(tenant_id, licitacao_id, tarefa_codigo)` quando `origem = catalogo`, por índice único
  parcial. Liberar de novo, ou o mesmo código liberado por fase e por evento, não duplica. Esse é o CA-3 da 0018.
- **Checks:**
  - `origem = catalogo` exige `tarefa_codigo` e pelo menos um dos dois `liberada_por_*`;
  - `origem = empresa` exige `titulo`;
  - `prazo_em` só existe com `prazo_situacao = manual`.
- **ACL:** RLS ligada e sem policy; `revoke all` de `anon` e `authenticated`; só `service_role` acessa, como as outras
  tabelas do pipeline. O cliente chega pela `api-tarefas`.
- **O catálogo não muda.** Responsável, prazo e status ficam só na instância.

### 2. Contexto do certame e liberação (SQL, `security definer`, `search_path` fixo, só `service_role`)

- **`tarefas_contexto_certame(p_licitacao_id bigint) → jsonb`:** monta o contexto **só com dado oficial**. No v1 a
  única chave é `srp`, de `objeto_registro_preco`, e só quando esse campo não é nulo. As outras chaves ficam ausentes, e
  chave ausente vira "condição não verificada", nunca "não se aplica".
- **`tarefas_equipe_liberar(p_tenant_id, p_licitacao_id, p_fase, p_evento, p_user_id) → (criadas int, existentes int)`:**
  - recebe exatamente um de `p_fase` ou `p_evento`;
  - chama `catalogo_tarefas_da_fase` ou `catalogo_tarefas_do_evento` com o contexto;
  - insere com `on conflict do nothing`;
  - grava `condicao_verificada` (true ou nulo), o contexto, a `prazo_situacao` e `responsavel_papel = 'admin'`;
  - tarefa com `parent_codigo` entra junto com a mãe, porque as duas funções do catálogo já devolvem as filhas da fase.

### 3. Prazo (nenhuma data inventada)

| Unidade no catálogo | `prazo_situacao` na criação |
|---|---|
| `dias_uteis` | `nao_calculado` (sem calendário de feriados) |
| `meses`, `anos` | `nao_calculado` (o v1 não tem a data do evento de referência) |
| `definido_no_edital` | `definido_no_edital` |
| `sem_prazo_legal` | `sem_prazo_legal` |
| `imediato` | `imediato` |

O admin pode informar a data à mão (`tarefa_atualizar`): a situação passa a `manual`, com quem informou e quando.
Calcular a data a partir do evento (por exemplo, `DATA_ABERTURA` = `licitacoes_externas.data_fim`) fica para depois, junto
com o calendário de feriados.

### 4. Edge Function nova `api-tarefas`

`requireUserAuth`, empresa por `_shared/tenant.ts` e papel por `tenant_papel()`, igual à `api-pipeline`. O banco é
acessado com `service_role` só depois de conferir o usuário.

| Ação | Quem | O quê |
|---|---|---|
| `catalogo_liberadas` | admin ou operação | prévia sem gravar: tarefas que a fase ou o evento liberam para a licitação, com `aplicavel` (true ou nulo), prazo e base legal |
| `tarefas_liberar` | admin ou operação | grava as tarefas da fase ou do evento (`tarefas_equipe_liberar`); devolve `criadas` e `existentes` |
| `tarefas_listar` | admin: todas da empresa; operação: só as atribuídas a ela | filtros `licitacao_id`, `status`, `minhas` |
| `tarefa_atualizar` | admin: qualquer uma; operação: só as dela | `status`, `prazo_em` (admin) |
| `tarefa_atribuir` | só admin (ou o desenvolvedor) | `user_id` precisa ser membro ativo da mesma empresa; `null` devolve à fila dos admins |

Uma licitação só recebe tarefa se estiver no pipeline da empresa (pergunta 2). Fora dele, a resposta é 404 "Licitação
fora do pipeline da empresa".

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** uma licitação com `objeto_registro_preco = true`, **quando** `tarefas_equipe_liberar` roda para um evento cuja tarefa exige `srp = true`, **então** a tarefa é criada com `condicao_verificada = true`; com `srp = false` exigido, não é criada. | SQL `supabase/tests/tarefas_equipe_check.sql` |
| CA-2 | **Dado** contexto sem a chave da condição (ex.: `inversao_fases`), **quando** libera, **então** a tarefa existe com `condicao_verificada` nulo. | SQL `tarefas_equipe_check.sql` |
| CA-3 | **Dado** tarefas já liberadas, **quando** libera de novo a mesma fase ou um evento com o mesmo código, **então** nada duplica (`criadas = 0`). | SQL `tarefas_equipe_check.sql` |
| CA-4 | **Dado** tarefa em `dias_uteis`, **quando** criada, **então** `prazo_situacao = 'nao_calculado'` e `prazo_em` nulo. | SQL `tarefas_equipe_check.sql` |
| CA-5 | **Dado** uma tarefa criada, **quando** status e responsável mudam, **então** `tarefas_catalogo` continua igual (mesmo hash da linha). | SQL `tarefas_equipe_check.sql` |
| CA-6 | **Dado** `anon` e `authenticated`, **quando** leem `tarefas_equipe` ou executam as funções novas, **então** sem acesso. | SQL `tarefas_equipe_check.sql` (ACL) |
| CA-7 | **Dado** uma tarefa criada, **então** `responsavel_papel = 'admin'` e `responsavel_user_id` nulo. | SQL `tarefas_equipe_check.sql` |
| CA-8 | **Dado** um usuário de operação, **quando** chama `tarefa_atribuir`, **então** 403; admin atribui a membro ativo da empresa; usuário de outra empresa → 400. | Deno `tests/supabase/functions/api_tarefas_test.ts` |
| CA-9 | **Dado** um usuário de operação, **quando** chama `tarefas_listar`, **então** só recebe as atribuídas a ele; admin recebe todas da empresa e nenhuma de outra. | Deno `api_tarefas_test.ts` |
| CA-10 | **Dado** uma licitação fora do pipeline da empresa, **quando** chama `tarefas_liberar`, **então** 404 e nada é gravado. | Deno `api_tarefas_test.ts` |
| CA-11 | **Dado** requisição sem JWT, **então** 401; corpo sem `fase` nem `evento`, ou com os dois, **então** 400. | Deno `api_tarefas_test.ts` |

## Fora de escopo

- Tarefas padrão por etapa e tarefas `origem = empresa`: spec 0018.
- Detectar o evento sozinho (ata, resultado, convocação) e liberar sem ação humana. No v1, a liberação é a ação
  `tarefas_liberar`.
- Calendário de feriados e prazo calculado a partir da data do evento.
- Contexto preenchido à mão pela equipe (ex.: marcar `inversao_fases`). Fica como pergunta futura.
- Árvore de tarefas por modalidade (a issue proíbe neste PR).
- Tela (Dashboard #72).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_tarefas_equipe.sql`. Aditiva e idempotente: tabela, índices,
  checks e duas funções. Timestamp depois do `20261010100400` do #308.
- **Tabelas/funções tocadas:**
  - `tarefas_equipe` (nova; escrita só pelas funções e pela `api-tarefas`);
  - leitura de `tarefas_catalogo`, `licitacoes_externas`, `pipeline_oportunidades` e `tenant_membros`.
- **ACL/RLS:** tabela só `service_role`; funções novas com `revoke all from public, anon, authenticated` e `grant execute`
  para `service_role`. Check `supabase/tests/tarefas_equipe_check.sql`.
- **Backfill:** nenhum (0 licitações no pipeline em 10/10).
- **Edge Functions republicadas no merge:** todas. Função nova `api-tarefas`:
  - `verify_jwt = false` no `config.toml` (a auth é no código, como a `api-tenant`);
  - entra na lista do `deploy-supabase-functions.yml`.
- **Contrato com o Dashboard:** novo (ações da seção 4); a #72 consome.
- **Dado oficial × derivado:**
  - vêm do catálogo: tarefa, artigo e prazo legal;
  - vem da fonte oficial (PNCP): `srp`;
  - são da empresa: responsável, status e prazo manual;
  - nenhuma condição é presumida.

## Perguntas em aberto

1. **Regulamento.** Hoje `licitacoes_externas.regulamento` é nulo em todas as linhas. Proposta:
   - regulamento conhecido fora de `LEI_14133` e `LEI_14981` → sem tarefa do catálogo (decisão 4 da 0018);
   - **nulo** → a tarefa nasce com o selo "condição não verificada" e `regulamento` ausente no contexto (regra de ouro:
     ausência não vira "não se aplica").

   A alternativa seria bloquear tudo até o backfill do regulamento.
2. **Só licitação no pipeline da empresa recebe tarefa?** Proposta: sim (404 fora dele). É o momento em que a empresa
   já decidiu acompanhar.
3. **Quem libera:** proposta é admin e operação (a tarefa sempre nasce na fila do admin). A alternativa é só admin.
