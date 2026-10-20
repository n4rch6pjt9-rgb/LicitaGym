# 0034: Editar as etapas do pipeline na tela e tirar as listas fixas de etapas do front

- **Status:** em revisão (aprovada em 20/10; ajustada depois da revisão do Codex no #407, aguarda reaprovação do Marcelo)
- **Alimenta:** módulo 2 (Pipeline e tarefas) de `docs/produto/ESCOPO.md`; área `/configuracoes` > Processo
- **Repositório:** os dois (uma ação nova na `api-pipeline`; o backend vai ao ar antes do front)
- **Issue:** #408
- **Área:** migrations | edge-functions | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration com 3 funções SQL novas e republica a `api-pipeline`)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê |
|---|---|---|
| 1 | `CLAUDE.md` (Dashboard) | testes, entrega (merge publica), o que não fazer |
| 2 | `AGENTS.md` e `.claude/rules/regras-negocio.md` (LicitaGym) | estados de vazio e erro explícitos; papéis admin e operação |
| 3 | `docs/produto/ESCOPO.md` e `docs/produto/BACKEND-CONFIGURACOES.md` | etapas como metadado do tenant |
| 4 | `docs/produto/FASE-1-FRONTEND.md` (seções 1, 3.1 e 3.3) | o diagnóstico que originou esta spec |
| 5 | esta spec |
| 6 | `supabase/functions/api-pipeline/README.md` (LicitaGym) | contrato de `etapas_listar`, `etapa_criar`, `etapa_atualizar`, `etapa_excluir` |
| 7 | Dashboard: `src/data/pipelineApi.ts`, `src/components/settings/PipelineConfigView.tsx`, `src/components/pipeline/PipelineKanbanView.tsx` (39-60), `src/components/dashboard/ExecutiveDashboard.tsx` (68-82, 179), `src/components/opportunities/OpportunityDetailView.tsx` (310-324) | onde mexer e as listas fixas a apagar |
| 7a | LicitaGym: `supabase/migrations/20261006020000_pipeline_oportunidades.sql` (tabela `pipeline_etapas`, `pipeline_etapa_excluir`), `20261011235000_pipeline_remover_apaga_tarefas.sql` (`pipeline_mover`: lock e ACL a copiar), `supabase/functions/api-pipeline/repo.ts` (`criarEtapa` 157-170, `atualizarEtapa` 172-180), `validation.ts` (118-139) | onde está o padrão de lock e o que muda |
| 7b | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/rules/database-migrations.md` (LicitaGym) | como escrever e validar a migration |
| 8 | `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md`, `.claude/agents/revisor-migration.md` (LicitaGym); `.claude/agents/frontend-dashboard.md`, `.claude/agents/ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md` (Dashboard) | agentes e skill desta spec |

## Problema

Medido em 20/10/2026 no Dashboard (`190d61a`) e no LicitaGym (`8436bdd`):

- A `api-pipeline` já tem `etapa_criar`, `etapa_atualizar` e `etapa_excluir` para o admin da empresa (README). O
  `pipelineApi.ts` do Dashboard só chama `etapas_listar` (linhas 139-140): **a tela não edita etapa**.
- `/configuracoes/pipeline` edita só as tarefas de cada etapa.
- As 13 etapas estão fixas no código do Kanban de demonstração (`PipelineKanbanView.tsx:39-60`), do detalhe
  (`OpportunityDetailView.tsx:310-324`) e do painel (`ExecutiveDashboard.tsx:68-82`). O KPI "Em triagem ou análise"
  usa uma expressão regular sobre o nome (linha 179). Uma etapa renomeada pelo tenant some do painel.
- Sair de `/configuracoes/pipeline` pelo menu descarta o rascunho sem aviso (revisão de 20/10, `FASE-1-FRONTEND.md`).
- **Achado da revisão do Codex no #407 (20/10):** a Edge Function fala com o banco por chamadas PostgREST separadas, e
  cada uma é uma transação. Uma reordenação atômica com advisory lock só existe dentro de uma função SQL, ou seja, de
  uma **migration**. E o lock só protege quem também o pega: hoje `criarEtapa` faz `select` + `insert` sem lock, e
  `etapa_atualizar` grava `ordem` direto. Uma etapa criada no meio de uma reordenação pode passar sem estar na lista.
- `pipeline_etapas.updated_at` não tem trigger: só o `etapa_atualizar` grava (`repo.ts:175`). A exclusão de uma etapa
  não muda o maior `updated_at` das que sobram, então "maior `updated_at`" não serve como versão da lista.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `pipelineApi.ts`: `criarEtapa`, `atualizarEtapa`, `excluirEtapa` | os campos do README da `api-pipeline` | a etapa / `movidas` | mensagem da API para 400, 403 e 409, sem traduzir para "erro genérico" | — |
| K-2 | Aba "Etapas" em `/configuracoes/pipeline` (antes da aba de tarefas) | `etapas_listar` | lista ordenada: nome, fase, desfecho, exige motivo, total de oportunidades; criar, renomear, mudar fase, reordenar (arrastar e setas do teclado), excluir com destino | — | admin edita; operação vê em modo somente leitura, com o aviso "Peça a um admin" |
| K-3 | Kanban, detalhe e painel lendo as etapas do servidor | `etapas_listar` | colunas, funil e KPIs a partir das etapas e fases do tenant | falha de leitura → estado de erro explícito, nunca a lista fixa | — |
| K-4 | Aviso de alteração não salva | — | confirmação ao sair da página com rascunho | — | — |
| K-5 | `api-pipeline` `action=etapas_reordenar` (nova), que chama a função SQL `public.pipeline_etapas_reordenar(p_tenant, p_ids bigint[], p_versao text, p_user uuid)` | `ids[]`: a lista **completa** das etapas do tenant na nova ordem; `versao`: o texto lido em `etapas_listar`, repassado sem conversão | `etapas[]` na ordem nova (`ordem` = posição × 10) e a `versao` nova | 400 `lista_invalida` se a lista tiver id repetido, faltar alguma etapa ou trouxer etapa de outro tenant, mas só quando a `versao` confere (nada é gravado); 409 `versao_desatualizada` se a lista mudou desde a leitura (vale também quando a diferença é uma etapa criada ou excluída); 403 para quem não é admin | admin da empresa ou desenvolvedor |
| K-6 | `versao` da lista | — | função SQL `public.pipeline_etapas_versao(p_tenant)`: `md5` de `string_agg(id || ':' || ordem || ':' || updated_at, ',' order by id)` das etapas do tenant, em texto. `etapas_listar` passa a devolver `versao` chamando essa função, e `pipeline_etapas_reordenar` usa a mesma função: um só cálculo, sem reimplementar no TypeScript | — | autenticado |
| K-7 | Toda mutação da lista de etapas usa o mesmo lock | — | (a) `etapa_criar` passa a chamar a função SQL `public.pipeline_etapa_criar(p_tenant, p_nome, p_fase, p_ordem, p_desfecho, p_exige_motivo, p_user)`, que pega o lock e calcula `ordem` = maior + 10 dentro dele; (b) `etapa_atualizar` deixa de aceitar `ordem`: mudar a ordem só por `etapas_reordenar`; (c) `pipeline_etapa_excluir` já pega o lock (sem mudança) | `etapa_atualizar` com `ordem` → 400 "Use etapas_reordenar para mudar a ordem."; nome repetido em `etapa_criar` continua 409 | admin da empresa ou desenvolvedor |

**Funções SQL (migration nova, padrão de `pipeline_mover`):** `security invoker`, `set search_path = public, pg_temp`,
`revoke execute ... from PUBLIC, anon, authenticated` e `grant execute ... to service_role`; o lock é
`pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0))`, o mesmo de `pipeline_mover` e
`pipeline_etapa_excluir`. A reordenação grava `updated_at = now()` e `updated_by` em todas as linhas que mudou.
Erros saem com `raise exception` e um código próprio, que o `repo.ts` traduz para 400 e 409 como já faz com
`pipeline_etapa_excluir`. Checagem nova em `supabase/tests/pipeline_etapas_reordenar_check.sql`.
**Por que uma ação atômica (prática padrão em SaaS para listas ordenadas de configuração):**
- O cliente manda a ordem inteira, e o servidor grava tudo numa transação: ou a lista fica na ordem nova, ou nada muda.
  Gravar uma etapa por vez deixa a ordem pela metade quando uma chamada falha no meio.
- A `versao` é um controle de concorrência otimista. Se dois admins reordenam ao mesmo tempo, o segundo recebe 409, e a
  tela recarrega a lista e mostra "A ordem foi alterada por outra pessoa". Ninguém sobrescreve o trabalho do outro sem saber.
- O servidor confere se a lista está completa e é do tenant, então o cliente não consegue deixar buracos nem repetir posição.
- A transação usa o mesmo advisory lock por tenant que `pipeline_mover` e `etapa_excluir` já usam, e criar etapa
  passa a usar também (K-7). Quem não pega o lock não fica de fora da serialização: só `etapa_atualizar` escreve sem
  ele, e ela não mexe mais em `ordem`.
- A versão é um resumo de id, ordem e `updated_at` de todas as etapas, então muda também quando uma etapa é criada ou
  excluída. O front repassa o texto como veio (não converte para data, que perderia os microssegundos).
- Na tela, a mudança aparece na hora (atualização otimista). Se o servidor recusar, a lista volta à ordem anterior
  com a mensagem do erro.
- Para listas de milhares de itens reordenados o tempo todo, o padrão seria índice fracionário (gravar só o item
  movido). Para 13 etapas editadas de vez em quando, a lista completa é mais simples e mais fácil de auditar.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-2 | **Dado** um admin, **quando** cria a etapa "Habilitação" na fase `proposta`, **então** `etapa_criar` é chamada com nome e fase, e a etapa aparece na posição devolvida. Nome repetido mostra a mensagem do 409. | vitest `src/test/pipeline-etapas.test.tsx` |
| CA-2 | K-1, K-2 | **Dado** uma etapa, **quando** o admin muda o nome ou a fase, **então** `etapa_atualizar` é chamada só com o campo alterado. | vitest `pipeline-etapas.test.tsx` |
| CA-3 | K-2, K-5 | **Dado** o foco numa etapa, **quando** o admin aperta Alt+↓ (ou arrasta), **então** a etapa desce uma posição na hora, `etapas_reordenar` é chamada com a lista completa e a `versao` lida, e o foco continua na mesma etapa. Se a API recusar, a lista volta à ordem anterior com a mensagem. | vitest `pipeline-etapas.test.tsx` |
| CA-3a | K-5 | **Dado** 13 etapas do tenant A, **quando** o admin envia as 13 numa ordem nova com a `versao` atual, **então** todas as `ordem` mudam numa transação e a resposta traz a `versao` nova. | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-3b | K-5 | **Dado** uma lista com id repetido, sem uma das etapas ou com etapa do tenant B, **quando** chama `etapas_reordenar`, **então** 400 e nenhuma `ordem` muda. | Deno `api_pipeline_test.ts` |
| CA-3c | K-5, K-6 | **Dado** que outro admin reordenou depois da leitura, **quando** chama com a `versao` antiga, **então** 409 `versao_desatualizada` e nada muda; `operacao` recebe 403. | Deno `api_pipeline_test.ts` |
| CA-3d | K-6, K-7 | **Dado** uma `versao` lida, **quando** outra pessoa cria ou exclui uma etapa e depois chega a reordenação com a `versao` antiga, **então** 409 `versao_desatualizada` (não 400) e nada muda. | `supabase/tests/pipeline_etapas_reordenar_check.sql` + Deno `api_pipeline_test.ts` |
| CA-3e | K-5, K-7 | **Dado** a migration aplicada, **quando** `anon` ou `authenticated` chamam `pipeline_etapas_reordenar`, `pipeline_etapas_versao` ou `pipeline_etapa_criar`, **então** a chamada é negada; só `service_role` executa. A ordem final é única e contínua (10, 20, 30...). | `supabase/tests/pipeline_etapas_reordenar_check.sql` (skill `validar-migrations`) |
| CA-3f | K-7 | **Dado** um admin, **quando** chama `etapa_atualizar` com `ordem`, **então** 400 com a mensagem para usar `etapas_reordenar`, e nada muda. `etapa_criar` sem `ordem` coloca a etapa no fim. | Deno `api_pipeline_test.ts` |
| CA-4 | K-1, K-2 | **Dado** uma etapa com oportunidades, **quando** o admin pede para excluir, **então** o botão de confirmar só habilita depois de escolher a etapa de destino, e a chamada leva `mover_para`. A última etapa não oferece exclusão. | vitest `pipeline-etapas.test.tsx` |
| CA-5 | K-2 | **Dado** um usuário `operacao`, **quando** abre a aba, **então** vê a lista sem botões de edição e o aviso "Peça a um admin". Se a API responder 403, a mensagem aparece na tela. | vitest `pipeline-etapas.test.tsx` |
| CA-6 | K-3 | **Dado** `etapas_listar` com 3 etapas de nomes livres, **quando** o Kanban e o painel montam, **então** aparecem exatamente 3 colunas/estágios com esses nomes, e nenhuma lista fixa de etapas existe no código (busca no `src/` sem as 13 etapas literais, fora das fixtures do demo). | vitest `src/test/pipeline-etapas-servidor.test.tsx` + teste de varredura em `src/test/sem-etapas-fixas.test.ts` |
| CA-7 | K-3 | **Dado** falha em `etapas_listar`, **quando** o painel monta, **então** mostra estado de erro com "Tentar de novo" e nenhum número. | vitest `pipeline-etapas-servidor.test.tsx` |
| CA-8 | K-4 | **Dado** um rascunho não salvo, **quando** o usuário clica outro item do menu, **então** aparece a confirmação; cancelar mantém o rascunho. | vitest `pipeline-etapas.test.tsx` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 `pipelineApi.ts` | sessão orquestradora (confere o README da `api-pipeline`) | agente `frontend-dashboard` | vitest CA-1 a CA-5 | `revisor-codigo` | skill `deploy-dashboard` |
| K-2 aba Etapas | agente `ux-ui-licitagym`: mockup da aba (claro, escuro, celular) antes do código | `frontend-dashboard` | vitest CA-1 a CA-5; skill `run-dashboard` em `/configuracoes/pipeline` (admin e operação no demo) | `ux-ui-licitagym` (acessibilidade do reordenar por teclado) + `revisor-codigo` | `deploy-dashboard` |
| K-3 listas fixas → servidor | `frontend-dashboard` (varredura das listas) | `frontend-dashboard` | vitest CA-6, CA-7; `run-dashboard` em `/pipeline` e `/dashboard` | `revisor-codigo` (zero alucinação: nenhum fallback para a lista fixa) | `deploy-dashboard` |
| K-4 aviso de rascunho | — | `frontend-dashboard` | vitest CA-8 | `revisor-codigo` | — |
| K-5, K-6, K-7 migration (3 funções SQL) | skill `nova-migration`; leitura do lock e da ACL de `pipeline_mover` | `/implement` (backend) | `supabase/tests/pipeline_etapas_reordenar_check.sql` CA-3d, CA-3e; skill `validar-migrations` (Postgres descartável) | `revisor-migration` + `revisor-seguranca` | skill `verificar-producao` (migration aplicada, ACL das 3 funções) e `get_advisors` |
| K-5, K-6, K-7 `api-pipeline` | leitura de `.claude/rules/edge-functions.md` e do `repo.ts` | `/implement` (backend) | Deno CA-3a a CA-3f | `revisor-codigo` + `revisor-seguranca` (escrita de configuração por papel e tenant) | `verificar-producao` |
| Fechamento | — | — | — | — | skill `ciclo-janelas` (fecha o aviso de rascunho e as etapas fixas do inventário da `FASE-1-FRONTEND.md`) |

## Fora de escopo

- Mudar o backend da `api-pipeline` além de K-5, K-6 e K-7.
- **Portão de GO/NO-GO (`exige_portao`).** A coluna e o gatilho já existem no banco, mas não há ação na API para
  registrar a decisão humana. Ligar o portão hoje travaria a etapa. Fica para uma spec própria, que entrega o
  registro da decisão e o liga/desliga juntos. Nesta aba, a coluna não aparece.
- Cor, SLA e "agente sugerido por etapa" (proposta da revisão de UX, spec futura).
- Mover a página para a nova área `/configuracoes` reorganizada (spec da página inicial de Configurações).
- Enviar `tenant_id` (vem pela 0033, via `invokeEdge`; esta spec não depende dela).

## Impacto em dados

- **Migration:** sim, aditiva: 3 funções novas (`pipeline_etapas_reordenar`, `pipeline_etapas_versao`,
  `pipeline_etapa_criar`). Nenhuma tabela, coluna ou dado muda; rollback = `drop function`.
- **Tabelas/views/funções tocadas:** `pipeline_etapas` (escrita pelas funções novas e pela `api-pipeline`).
- **ACL/RLS:** só `service_role` executa as 3 funções (revoke de PUBLIC, anon, authenticated). RLS sem mudança.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas (regra do repositório); muda só a `api-pipeline`.
- **Contrato com o Dashboard:** `etapas_reordenar` nova e `versao` em `etapas_listar` (aditivos). `etapa_atualizar`
  deixa de aceitar `ordem`: o Dashboard hoje não chama essa ação (`pipelineApi.ts` só usa `etapas_listar`), então
  nada quebra. O backend vai antes.
- **Dado oficial x derivado:** etapas são configuração do tenant; nenhum número de funil sem dado do servidor.

## Decisões do Marcelo

- 20/10: etapas do pipeline são metadado do tenant, editado na interface.
- 20/10: reordenação segue a prática padrão de SaaS: ação atômica com lista completa e controle de versão (K-5, K-6).
- 20/10: `exige_portao` fica fora desta spec (ver "Fora de escopo").
- (pendente) Reaprovar a spec com a migration (K-5 a K-7), depois da revisão do Codex no #407.

## Perguntas em aberto

- Nenhuma.
