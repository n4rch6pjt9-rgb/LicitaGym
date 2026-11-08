# 0042: Fazer o tenant novo nascer com as 14 etapas e as tarefas Nexor

- **Status:** aprovada (08/11/2026)
- **Alimenta:** Fase 0 do programa Nexor (`specs/nexor-fase0-mapa.md`, linha "`pipeline_stages` (tenant)", PR 3);
  spec-mãe 0032, fase 2 (tarefa nasce ao entrar na etapa).
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** migrations | edge-functions (`api-pipeline`) | dashboard-tela (`PipelineConfigView`)
- **Depende do ok do Marcelo:** sim (migration, função que cria tarefas e decisão de produto)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/nexor-fase0-mapa.md`, `specs/nexor-de-para-tarefas.md`, `docs/produto/nexor-contrato-tarefas.md` | decisões da Fase 0, de-para NX-T × 14.133, contrato da planilha e comparação com a Konnen |
| 5 | `specs/0018-tarefas-padrao-por-etapa.md`, `specs/0019-tarefas-equipe-instancia-por-certame.md` | modelo de tarefas por etapa e instância por certame |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções |
| 8 | `supabase/migrations/20261006020000_pipeline_oportunidades.sql` (`pipeline_semear_etapas`, gatilho), `supabase/migrations/20261011120000_pipeline_etapa_tarefas.sql` (`pipeline_semear_tarefas`, `pipeline_etapa_tarefas_criar`), `supabase/migrations/20261021130300_tarefas_agente_semente.sql` | semente de hoje (13 etapas e tarefas da 14.133) |
| 8 | `supabase/functions/api-pipeline/repo.ts` (`listarCatalogo`, `NORMA_CATALOGO`) | catálogo só devolve 14.133 |
| 8 | Dashboard `src/components/settings/PipelineConfigView.tsx` (`SeletorCatalogo`) | dropdown "Escolha a fase" |
| 10 | skills `nova-migration`, `validar-migrations`, `verificar-producao`; agentes `revisor-codigo`, `revisor-migration`, `revisor-seguranca` | |

## Problema (medido em 08/11/2026, MCP somente leitura e leitura do código)

| Fato | Evidência |
|---|---|
| Tenant criado hoje nasce com as 13 etapas da Konnen e tarefas da 14.133, não com as 14 etapas NX | gatilho `tenants_pipeline_semear_etapas` → `pipeline_semear_etapas` + `pipeline_semear_tarefas` |
| As 14 etapas NX (`processo_fases`, `norma = 'NX'`) e os 23 modelos NX existem, mas nenhum tenant os usa | PR #467; `pipeline_etapa_tarefas` sem nenhum `tarefa_codigo like 'NX.%'` |
| As 10 tarefas-apelido (NX-T02, T05, T13, T14, T16, T17, T18, T19, T22, T24) não têm etapa NX | apontam para modelos 14.133 com `fase_codigo` F01–F12 |
| Tarefa de catálogo não tem prazo em horas no modelo e nasce sempre na fila do admin | `pipeline_etapa_tarefas_origem_chk` exige `prazo_horas is null` em `origem = 'catalogo'`; `pipeline_etapa_tarefas_criar` grava `responsavel_papel = 'admin'` |
| O seletor "Adicionar do catálogo da lei" lista as 12 fases da 14.133, não a etapa | `SeletorCatalogo`; `listarCatalogo` filtra `norma = 'LEI_14133_2021'` |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `pipeline_etapas.fase_codigo` (coluna nova, FK `processo_fases.codigo`) | — | etapa NX aponta para A01…R14; etapas da Konnen ficam `null` | — | migration |
| K-2 | `public.nexor_etapa_tarefas_padrao` (tabela gerada da planilha, `scripts/import-spec.ts --bloco=etapa-tarefas`) | Pipeline_Etapas + Tarefas_Default | 33 linhas `(etapa_codigo, tarefa_codigo, ordem)`: 23 NX + 10 apelidos 14.133 (NX-T18 = 2 modelos → 34 linhas); NX-T34 fora | gerador falha se a etapa da Tarefas_Default não bater com a lista da Pipeline_Etapas | migration; leitura `service_role` |
| K-3 | Gatilho de tenant novo semeia NX | `insert` em `tenants` | 14 etapas NX (nome, `fase` = grupo mapeado, `desfecho` em R12/R13/R14, `exige_motivo` em R14, `fase_codigo`) e as tarefas da K-2 em cada etapa | — | gatilho; Konnen e tenants existentes não mudam |
| K-4 | `pipeline_etapa_tarefas_criar` usa prazo e responsável do modelo NX | tarefa de catálogo com `prazo_horas_apos_etapa` e `responsavel_padrao` | `prazo_em = entrada na etapa + horas` (`prazo_situacao = 'calculado'`); `responsavel_papel` = papel da planilha | responsável `agente:*`: ver pergunta 1 | função SQL |
| K-5 | `api-pipeline` `catalogo_listar` | tenant da sessão | modelos 14.133 e, para tenant com etapa NX, também os modelos NX; cada um com `fase_codigo` e nome da fase | 401 / 403 (outro tenant) como hoje | membro do tenant |
| K-6 | Dashboard `SeletorCatalogo` | etapa com `fase_codigo` | abre filtrado nas tarefas da própria etapa, com "ver outras etapas"; etapa sem `fase_codigo` (Konnen) continua por fase da lei | — | admin do tenant |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-3 | **Dado** um tenant inserido, **então** ele tem 14 etapas com `fase_codigo` A01…R14 na ordem da planilha, R12/R13/R14 com desfecho vencida/perdida/descartada e R14 com `exige_motivo` | SQL `supabase/tests/nexor_tenant_novo_check.sql` |
| CA-2 | K-2, K-3 | **Dado** o tenant novo, **então** A01 tem NX-T01, NX-T02 (14133-F01-T01), NX-T03 e NX-T27; S10 tem NX-T16 (14133-F04-T01); S08 não tem tarefa; NX-T34 não existe | mesmo check |
| CA-3 | K-3 | **Regressão:** as etapas e tarefas da Konnen (contagem por etapa) ficam iguais antes e depois da migration | mesmo check (contagem fixa do dry-run) |
| CA-4 | K-4 | **Dado** NX-T04 (24h, `papel:operacao`) e entrada na etapa em t, **quando** a tarefa nasce, **então** `prazo_em = t + 24h`, `prazo_situacao = 'calculado'`, `responsavel_papel = 'operacao'` | mesmo check |
| CA-5 | K-4 | **Dado** modelo da 14.133 (Konnen), **quando** nasce, **então** prazo e responsável seguem a regra de hoje | mesmo check |
| CA-6 | K-5 | **Dado** usuário de tenant NX, `catalogo_listar` devolve os 23 NX com `fase_codigo`; usuário da Konnen não recebe NX; sem sessão 401 | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-7 | K-2 | **Dado** a planilha, o bloco da migration é igual ao que o gerador produz; NX-T05 em A02, NX-T19 em R13 | Deno `tests/supabase/scripts/import_spec_test.ts` |
| CA-8 | K-6 | **Dado** etapa com `fase_codigo` A01, o seletor abre nas tarefas de A01; etapa sem `fase_codigo` abre em "Escolha a fase" | vitest `src/test/pipeline-seletor-catalogo.test.tsx` |

## Fora de escopo

- Migrar a Konnen para as etapas NX (PR próprio, com dry-run e ok do Marcelo).
- Criar o tenant novo: o Marcelo cria pela tela Empresas depois do merge (dado de produção não entra por agente).
- Prazo em dias úteis por tarefa (0041 K-4) e as tarefas com prazo em texto (T05, T15–T18, T20, T23, T24, T28, T29, T33).
- Entrada automática pela API (S08–S13) e alertas dos guardrails.

## Impacto em dados

- **Migration:** sim, aditiva e idempotente (coluna nova, tabela gerada, funções `create or replace`, gatilho trocado).
- **Tabelas/funções:** `pipeline_etapas` (+`fase_codigo`), `nexor_etapa_tarefas_padrao` (nova), `pipeline_semear_etapas_trg`,
  novas `pipeline_semear_etapas_nx`/`pipeline_semear_tarefas_nx`, `pipeline_etapa_tarefas_criar`.
- **ACL/RLS:** tabela nova com RLS sem policy, `service_role` só lê; funções com `revoke` de PUBLIC/anon/authenticated.
- **Backfill:** não. Tenants existentes não mudam (CA-3).
- **Edge Functions republicadas:** todas (merge na `main`); muda `api-pipeline`.
- **Contrato com o Dashboard:** `catalogo_listar` ganha linhas NX e `fase_codigo`; etapa ganha `fase_codigo`. Aditivo.
- **Dado oficial × derivado:** tudo vem da planilha versionada; nenhum prazo ou responsável inventado.

## Decisões do Marcelo (08/11/2026)

- **Tenant novo:** todo tenant novo nasce NX (14 etapas e tarefas da planilha). A Konnen não muda.
- **Seletor do catálogo:** no tenant NX abre filtrado nas tarefas da própria etapa, com "ver outras etapas".
- **Responsável agente:** a tarefa NX nasce com `responsavel_tipo = 'agente'` e o agente mapeado
  (`juridico`, `edital`, `precos` → `preco`). NX-T29 e NX-T33, com dois agentes, ficam com o primeiro; o segundo vai
  na descrição.
- **Regulamento:** os modelos NX nascem em qualquer regulamento informado; os 10 apelidos 14.133 seguem a regra de hoje
  (só 14.133 e 14.981). Regulamento não informado continua bloqueando.
- **Nomes das etapas:** os da planilha.
