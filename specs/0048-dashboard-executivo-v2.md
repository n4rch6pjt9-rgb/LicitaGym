# 0048: Calcular no servidor os números do Painel Executivo (Dashboard Executivo V2)

- **Status:** aprovada (Marcelo, 09/11/2026)
- **Alimenta:** spec 0040 (marca NEXOR e linguagem Geist), contrato K-5 ("`ExecutiveDashboard` enxuto") e K-7 ("saúde e
  aderência sem dado inventado"). Por decisão do Marcelo de 09/11/2026 ("ligado à 0040"), é exceção à regra de foco do
  `ESCOPO.md` (não alimenta fase da 0032). Ver P-1.
- **Repositório:** os dois (backend LicitaGym vai ao ar antes do Dashboard)
- **Issue:** Dashboard #42 (resumo calculado no servidor, citado no próprio `ExecutiveDashboard.tsx` da `main`)
- **Área:** migrations | edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration, decisão de produto sobre os blocos do painel, republicação de funções)

Esta spec substitui `docs/produto/PLANO-DASHBOARD-EXECUTIVO-V2-NEXOR-GEIST.md` (não versionado) e consolida o que
ficou sem commit no checkout principal do LicitaGym e no branch `feat/rebrand-nexor` do Dashboard.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` (LicitaGym e Dashboard) | como roda, testa e entrega; merge publica | sim |
| 2 | `AGENTS.md` | zero alucinação; dado ausente aparece como ausente | sim (LicitaGym) |
| 3 | `.claude/rules/regras-negocio.md` | TR decide o escopo; CATMAT é apoio; prioridade efetiva só rebaixa | sim (LicitaGym) |
| 4 | `docs/produto/ESCOPO.md` | regra de foco e a exceção registrada em 09/11 | não: ler |
| 5 | `specs/0040-rebrand-nexor-linguagem-geist.md` | K-5, K-7, CA-6, CA-8, CA-9 e P4/P6, que esta spec resolve | não: ler |
| 6 | esta spec | contrato, CAs, fora de escopo | não: ler |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta |
| 8 | `supabase/functions/api-dashboard-oportunidades/index.ts`, `types.ts`, `validation.ts` e `docs/api-dashboard-oportunidades.md` | ação `list` (recorte de catálogo/CATMAT) que o resumo reutiliza | não: ler |
| 8 | `supabase/functions/api-saude/index.ts` | hoje só admin e cron (403 para membro) | não: ler |
| 8 | view `public.licitacoes_externas_prioridade_efetiva` (migrations) | base dos números; `eh_canonica`, `prioridade` efetiva, `valor_total`, `data_fim` (BRT gravado como UTC) | não: ler |
| 8 | Dashboard `src/components/dashboard/ExecutiveDashboard.tsx` (main) | painel atual: soma só as 100 primeiras linhas, prazos e radar por amostra | não: ler |
| 8 | Dashboard `origin/feat/rebrand-nexor`: `src/components/dashboard/{ActionCenter,CriticalDeadlines,IntelligenceInsights,OperationalHealth,PipelineBoard,PriceIntelligence,PriorityLeads,StrategicKpis}.tsx` | blocos candidatos (P-2) | não: ler |
| 8 | Rascunho sem commit (`C:\Users\marce\licitagym`, branch `feat/nexor-fase0-base`): `supabase/migrations/20261105120000_dashboard_resumo_executivo.sql` e a ação `resumo_executivo` | ponto de partida do K-1/K-2 (não copiar a "alta aderência" nem as "dimensões" da saúde; ver Problema) | não: ler |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`; agentes `revisor-codigo`, `revisor-migration`, `revisor-seguranca` (LicitaGym); Dashboard `.claude/agents/frontend-dashboard.md`, `.claude/agents/ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `.claude/skills/deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Problema

Medido em 09/11/2026 (05:39 UTC), por consulta somente leitura no MCP do Supabase e leitura do código da `main`:

- **O painel soma uma amostra.** O `ExecutiveDashboard.tsx` da `main` lê `TAMANHO_BASE = 100` oportunidades e, quando a
  base é maior, mostra "A soma das N contratações ainda não é calculada no servidor" (issue #42 do Dashboard). A base
  é muito maior: em `public.licitacoes_externas`, pela **prioridade gravada**, há 1079 `leads` (969 com valor, soma
  R$ 2.239.435.442,33) e 945 `monitorar` (829 com valor, soma R$ 2.015.556.656,42); 411 leads com `data_fim` nos
  próximos 7 dias. **A prioridade efetiva (view `licitacoes_externas_prioridade_efetiva`) não foi medida:** a view
  chama `pncp_instante_brt`, que o papel somente leitura do MCP não executa. Os números do painel virão da view.
- **A função de resumo não existe em produção** (`to_regprocedure('public.dashboard_resumo_executivo(bigint[],timestamptz)')`
  é nulo). O rascunho sem commit tem a migration `20261105120000_dashboard_resumo_executivo.sql`, com timestamp anterior
  à última da `main` (`20261109030000`): precisa de timestamp novo.
- **O rascunho repete dois erros que a 0040 já apontou:**
  - "alta aderência" contada a partir de `interesse_borracha`, `objeto_categoria` ou `licitacao_match` (CATMAT): contra
    a regra de 20/10 (o TR decide o escopo; CATMAT só apoia). 0040 CA-8.
  - "dimensões" da `api-saude` que ligam verificações de sync a pilares "jurídico" e "pipeline" sem relação real
    (ex.: `juridico` = `pncp_sync_dias_sem_sucesso`). 0040 K-7.
- **Saúde não é do membro:** a `api-saude` da `main` responde 403 para quem não é admin da plataforma (o detalhe traz
  erro interno). Um pilar de saúde no painel do cliente não tem fonte hoje (0040 P6).
- **Altura e excesso de ação** no painel do rebrand (0040, medido em 06/11): 2703 px contra 1722 px na `main`, 11 de 18
  botões primários. Na `main` depois do #115: não medido.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration `<timestamp>_dashboard_resumo_executivo.sql`: `public.dashboard_resumo_executivo(p_ids_filtro bigint[] default null, p_agora timestamptz default now())`, sobre `licitacoes_externas_prioridade_efetiva` com `eh_canonica` | recorte opcional de ids; instante | uma linha: `leads_total`, `monitoradas_total` (leads + monitorar), `valor_potencial_total` (soma de `valor_total` das ativas; **null se nenhuma tem valor**, nunca 0 inventado), `com_valor_total`, `prazo_amanha_total`/`_valor`, `prazo_7_dias_total`/`_valor` (janelas em Brasília), `calculado_em`. **Sem "alta aderência"** (P-3) | — | `security invoker`, `search_path` fixo, EXECUTE só `service_role` |
| K-2 | `api-dashboard-oportunidades` `action=resumo_executivo` | mesmos filtros de recorte da `action=list` (catálogo/CATMAT do tenant) | `{ resumo: K-1, recorte: {...}, fonte: "licitacoes_externas_prioridade_efetiva" }` | 400 filtro inválido; 401 sem JWT; 403 sem tenant ativo; 500 sem detalhe interno | membro do tenant |
| K-3 | Dashboard `ExecutiveDashboard`: KPIs e prazos lidos de K-2 | — | total de leads, monitoradas, valor potencial (ou "—" quando null), prazos de amanhã e 7 dias; o aviso "ainda não é calculada no servidor" sai | erro com "Tentar de novo"; nunca número de amostra rotulado como total | membro do tenant |
| K-4 | Blocos do painel | decisão P-2: KPIs, funil, prazos e leads do radar (estrutura da `main`) | só esses blocos; nenhum estado fixo (`status="processing"`, "OK" sem leitura); sem "alta aderência" (P-3) | ausente aparece como "—" ou "Não verificada" | membro do tenant |
| K-5 | Saúde no painel | decisão P-4 | admin da plataforma: resumo da `api-saude` como está; membro comum: o bloco não aparece | leitura falha: "Não verificada", nunca "OK" | admin / membro |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** licitações de teste (2 leads com valor, 1 lead sem valor, 1 monitorar, 1 histórico, 1 não canônica), **quando** a função roda, **então** `leads_total = 3`, `monitoradas_total = 4`, `com_valor_total` e a soma contam só as ativas canônicas com valor; histórico e não canônica ficam fora. | SQL `supabase/tests/dashboard_resumo_executivo_check.sql` |
| CA-2 | K-1 | **Dado** ativas sem nenhum `valor_total`, **quando** a função roda, **então** `valor_potencial_total` é null (não 0) e `com_valor_total = 0`. Prazo às 23:59 de amanhã (Brasília) entra em "amanhã"; 00:00 do dia seguinte, não. | idem |
| CA-3 | K-1 | **Dado** a migration, **quando** `anon` ou `authenticated` executam a função, **então** recebem erro de permissão; `service_role` executa. | idem |
| CA-4 | K-2 | **Dado** um usuário com tenant ativo, **quando** chama `resumo_executivo` com o mesmo recorte de catálogo da lista, **então** recebe K-1 calculado só sobre os ids do recorte; sem JWT, 401. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-5 | K-2 | **Negativo. Dado** um usuário sem vínculo com tenant ativo, ou de outro tenant, **quando** chama `resumo_executivo`, **então** recebe 403 e o recorte nunca usa o catálogo de outra empresa. | idem |
| CA-6 | K-3 | **Dado** o resumo com 1079 leads e valor null, **quando** o painel renderiza, **então** mostra 1079 e "—" no valor, sem o texto "ainda não é calculada no servidor"; com erro da API, mostra "Tentar de novo" e nenhum número. | vitest `src/test/painel-resumo-servidor.test.tsx` |
| CA-7 | K-4 | **Regressão P0 (0040 CA-6/CA-8). Dado** o painel, **quando** renderiza sem fonte de preço e com oportunidade só com CATMAT casado, **então** não aparece "Processando base histórica..." nem "Alta aderência". | vitest `src/test/painel-dados-honestos.test.tsx` |
| CA-8 | K-5 | **Negativo (0040 CA-9). Dado** um membro que não é admin, **quando** o painel abre, **então** o bloco de saúde não aparece (nem chama a `api-saude`); com a `api-saude` falhando para admin, o bloco mostra "Não verificada", nunca "OK". | vitest `src/test/painel-dados-honestos.test.tsx` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration`, `/implement` | SQL `_check`; skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` + `revisor-codigo` | skill `verificar-producao` + `get_advisors` |
| K-2 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` (tenant, `service_role`) | skill `verificar-producao` |
| K-3 a K-5 | `/spec`, agente `ux-ui-licitagym` | agente `frontend-dashboard` | vitest + skill `run-dashboard` | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | skill `deploy-dashboard` |

Ordem: PR do LicitaGym (K-1, K-2) mergeado e publicado antes do PR do Dashboard (K-3 a K-5).

## Fora de escopo

- "Alta aderência" no painel, até existir aderência calculada pelo TR (agente de edital, 0032): ver P-3.
- "Dimensões" da saúde (pipeline, jurídico, inteligência, prazos, dados) do rascunho: os pilares não têm verificação real
  correspondente. A saúde do cliente, se entrar, é uma spec própria (P-4).
- Restante da 0040 (tokens, primitivos, tipografia, marca): já entrou em boa parte pelo #115; o que sobrar fica na 0040.
- Histórico do PCA no front (patch salvo em `D:\Backup_2026-11-09\dashboard-clone-principal\C1-pca-historico.patch`).
- Trabalho sem commit de 06/11 no worktree `C:\Users\marce\dash-rebrand-nexor` (outra sessão): quem retomar o branch
  confere antes de portar.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_dashboard_resumo_executivo.sql` (timestamp maior que o da `main`);
  aditiva (só cria função), idempotente.
- **Tabelas/views/funções tocadas:** cria `public.dashboard_resumo_executivo`; lê `licitacoes_externas_prioridade_efetiva`.
  Quem lê: `api-dashboard-oportunidades` (`resumo_executivo`).
- **ACL/RLS:** função sem EXECUTE para `anon`/`authenticated`; só `service_role`. Nenhuma tabela nova.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas; muda `api-dashboard-oportunidades` (ação nova).
- **Contrato com o Dashboard:** ação nova `resumo_executivo` (compatível); o PR do backend vai ao ar antes do front.
- **Dado oficial x derivado:** `valor_total` e `data_fim` vêm da fonte (PNCP/portais); contagens e somas são derivadas
  no PostgreSQL, sem estimativa; valor ausente fica null.

## Decisões do Marcelo

- 09/11/2026: o Dashboard Executivo V2 fica ligado à 0040, como exceção à regra de foco.
- 09/11/2026 (P-1): a 0040 sai de `parada`.
- 09/11/2026 (P-2): blocos do painel = estrutura da `main` (KPIs, funil, prazos, leads do radar) com os números do
  servidor. Os blocos do branch do rebrand (`ActionCenter`, `PriorityLeads`, `CriticalDeadlines`, `PriceIntelligence`,
  `IntelligenceInsights`, `StrategicKpis`) não entram nesta spec.
- 09/11/2026 (P-3): "alta aderência" sai do painel até existir aderência pelo TR.
- 09/11/2026 (P-4): o bloco de saúde aparece só para admin da plataforma; o membro comum não vê bloco de saúde.
- 09/11/2026 (P-5): o rascunho sem commit é portado para um branch novo saído da `main`; o checkout principal é limpo
  depois.

## Perguntas em aberto

- (nenhuma)
