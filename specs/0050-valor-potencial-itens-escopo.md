# 0050: Somar no "valor potencial" do painel só o valor dos itens no escopo

- **Status:** em implementação (aprovada em 09/11/2026, P-1 a P-6; backend no branch `claude/0050-valor-no-escopo` do
  LicitaGym, Dashboard no branch de mesmo nome)
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades), como correção da spec 0048 (números do
  painel calculados no servidor). Entra na mesma exceção à regra de foco de 09/11 da 0048 (P-1, decisão do Marcelo
  de 09/11).
- **Repositório:** os dois (backend LicitaGym vai ao ar antes do Dashboard)
- **Issue:** nenhuma
- **Área:** migrations | edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration, decisão de produto sobre quais itens contam, republicação de funções)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` (LicitaGym e Dashboard) | como roda, testa e entrega; merge publica | sim |
| 2 | `AGENTS.md` | zero alucinação; valor ausente aparece como ausente | sim (LicitaGym) |
| 3 | `.claude/rules/regras-negocio.md` | TR decide o escopo, CATMAT é apoio; "ar livre" fora; termo de busca sozinho não faz `forte` | sim (LicitaGym) |
| 4 | `docs/produto/ESCOPO.md` | módulo 1 e a exceção de 09/11 | não: ler |
| 5 | `specs/0048-dashboard-executivo-v2.md` | contrato K-1 a K-3 que esta spec corrige; CA-1 a CA-6 | não: ler |
| 6 | esta spec | contrato, CAs, fora de escopo | não: ler |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta |
| 8 | `supabase/migrations/20261109040000_dashboard_resumo_executivo.sql` | a função atual: soma `valor_total` do edital | não: ler |
| 8 | `supabase/tests/dashboard_resumo_executivo_check.sql` | checagens CA-1 a CA-3 da 0048 que continuam valendo | não: ler |
| 8 | `supabase/functions/api-dashboard-oportunidades/index.ts` (`resumo_executivo`, `RESUMO_EXECUTIVO_RPC`), `types.ts`, `README.md` (seção 5) e `docs/api-dashboard-oportunidades.md` | ação que repassa o resumo | não: ler |
| 8 | `supabase/migrations/20260924100000_pncp_itens_resultados.sql` | origem de `licitacao_itens.categoria_escopo` (`catmat`, `borracha`, `piso`, `obra_piso`, `forte`, `fraco`) e `valor_total_estimado` | não: ler |
| 8 | `services/coletor-externo/coletor/catmat_ancoras.py`, `services/coletor-externo/coletor/escopo.py` | como o item vira `forte` ou `fraco` (decisão de 03/10: `forte` só por âncora do catálogo) | não: ler |
| 8 | `tests/supabase/functions/api_dashboard_oportunidades_test.ts` | testes CA-4/CA-5 da 0048 | não: ler |
| 8 | Dashboard `src/components/dashboard/ExecutiveDashboard.tsx`, `src/data/resumoExecutivoApi.ts`, `src/test/painel-resumo-servidor.test.tsx` | KPI "Valor potencial" e a nota "N de M com valor estimado" | não: ler |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`; `.claude/agents/revisor-codigo.md`, `revisor-migration.md`, `revisor-seguranca.md`; Dashboard `.claude/agents/frontend-dashboard.md`, `.claude/agents/ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `.claude/skills/deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Problema

Medido em 09/11/2026 (~14:30 UTC), por consulta somente leitura no MCP do Supabase. A view
`licitacoes_externas_prioridade_efetiva` não foi lida (o papel do MCP não executa `pncp_instante_brt`): os números
abaixo usam a **prioridade gravada** em `public.licitacoes_externas` (`leads` + `monitorar`), sem o recorte de catálogo.

- **O KPI soma o edital inteiro.** `dashboard_resumo_executivo` faz `sum(valor_total)` do certame. Em produção o painel
  mostra R$ 2.817.565.725,32 ("1306 de 1465 com valor estimado"; print do Marcelo, 09/11). Na base gravada: 1798
  certames com valor somam R$ 4.254.992.099, mediana R$ 265.294; os 10 maiores são 37,0 % da soma e os 50 maiores,
  63,1 %; 56 certames acima de R$ 10 mi somam R$ 2.748.297.662.
- **Os maiores são editais amplos com poucos itens no escopo.** Nos 10 maiores, o edital soma ~R$ 1,57 bi e os itens com
  `categoria_escopo` preenchida ~R$ 325 mi. Exemplos: #5348 (combate a incêndio florestal) R$ 231,7 mi com 1 item no
  escopo (R$ 0,48 mi); #2120 (material de enfermagem) R$ 157,1 mi com 4 de 441 itens (R$ 0,37 mi).
- **Valor dos itens por `categoria_escopo`** (itens de certames `leads`/`monitorar`): `forte` 4997 itens em 853 certames,
  R$ 52.482.275; `fraco` 12.205 itens em 1487 certames, R$ 616.232.849; `piso` 288 itens, R$ 88.500.210; `obra_piso`
  148 itens, R$ 73.596.450; `catmat` 894 itens, R$ 13.807.337; `borracha` 52 itens, R$ 8.874.107; sem categoria
  144.531 itens, R$ 3.410.709.515.
- **Parte do `fraco` é o que a regra tira do escopo.** Itens com categoria e descrição com "ar livre", "playground",
  "parque infantil", "academia de praça" ou "academia da terceira idade": 501 `fraco` somando R$ 301.356.402 (quase
  metade do `fraco`). A classificação do item vem do CATMAT e de termos (coletor), não do TR.
- **Certame sem valor de item:** 5 certames do Sistema S (`sesc_senac_rs` 3, `sescba` 1, `findes` 1) estão em
  leads/monitorar sem nenhum item com `valor_total_estimado`. Os 2013 do PNCP têm item com valor.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration `<timestamp>_dashboard_resumo_valor_itens_escopo.sql`: `create or replace` de `public.dashboard_resumo_executivo(bigint[], timestamptz)` com a **mesma assinatura e as mesmas colunas** | igual à 0048 | `valor_potencial_total` = soma de `licitacao_itens.valor_total_estimado` dos itens das ativas cuja `categoria_escopo` está em (`forte`, `catmat`, `borracha`, `piso`, `obra_piso`, `manutencao`) (P-2 e P-6; `fraco` e null fora); `com_valor_total` = ativas com pelo menos um desses itens com valor; `prazo_amanha_valor` e `prazo_7_dias_valor` no mesmo critério. Contagens de leads, monitoradas e prazos inalteradas. Somas null quando nenhum item conta (nunca 0 inventado) | — | `security invoker`, `search_path` fixo, EXECUTE só `service_role` (inalterado) |
| K-2 | `api-dashboard-oportunidades` `action=resumo_executivo` | igual à 0048 | igual à 0048, mais `criterio_valor: "itens_no_escopo"` e `categorias_valor: [...]` (as de P-2), para a tela rotular o número | igual à 0048 (400/401/403/500) | membro do tenant |
| K-3 | Dashboard `ExecutiveDashboard`: KPI "Valor potencial" passa a "Valor no escopo" (P-4) | K-2 | título "Valor no escopo"; a nota diz que é a soma dos itens no escopo ("N de M com item no escopo valorado"; texto final pelo `ux-ui-licitagym`); "—" quando null | erro com "Tentar de novo" (inalterado) | membro do tenant |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Regressão do KPI inflado. Dado** um lead com `valor_total` 1.000.000 e 3 itens (um `forte`, valor 10.000; um sem categoria, valor 900.000; um `fraco`, valor 90.000), **quando** a função roda, **então** `valor_potencial_total` = 10.000 e `com_valor_total` = 1. | SQL `supabase/tests/dashboard_resumo_executivo_check.sql` (bloco novo "0050 CA-1") |
| CA-2 | K-1 | **Dado** ativas cujos itens não têm nenhuma categoria que conta (ou não têm valor), **quando** a função roda, **então** `valor_potencial_total` é null e `com_valor_total` = 0; `leads_total` e `monitoradas_total` não mudam. | idem ("0050 CA-2") |
| CA-3 | K-1 | **Dado** um lead com item que conta e prazo amanhã (Brasília), **quando** a função roda, **então** `prazo_amanha_valor` soma só o valor desse item, não o `valor_total` do certame. | idem ("0050 CA-3") |
| CA-4 | K-1 | **Negativo. Dado** a migration aplicada, **quando** `anon` ou `authenticated` executam a função, **então** recebem erro de permissão; `service_role` executa (CA-3 da 0048 continua passando). | idem (bloco "CA-3" da 0048, sem mudança) |
| CA-5 | K-2 | **Dado** usuário com tenant ativo, **quando** chama `resumo_executivo`, **então** a resposta traz `criterio_valor = "itens_no_escopo"` e `categorias_valor = ["forte", "catmat", "borracha", "piso", "obra_piso", "manutencao"]`. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` ("0050 CA-5") |
| CA-6 | K-2 | **Negativo (outro tenant). Dado** usuário sem vínculo ativo ou de empresa desativada, **quando** chama `resumo_executivo`, **então** 403 e nenhuma RPC é chamada (testes CA-5 da 0048 continuam passando). | idem (testes "CA-5: ..." da 0048) |
| CA-7 | K-3 | **Dado** resposta com `valor_potencial_total` 52.482.275 e `com_valor_total` 853 de 1465, **quando** o painel renderiza, **então** mostra o valor sob o título "Valor no escopo" (o texto "Valor potencial" não aparece) e a nota com 853 de 1465; com valor null, "—". | vitest `src/test/painel-resumo-servidor.test.tsx` (casos novos "0050") |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration`, `/implement` | SQL `_check`; skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` + `revisor-codigo` | skill `verificar-producao` + `get_advisors` |
| K-2 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` (tenant, `service_role`) | skill `verificar-producao` |
| K-3 | `/spec`, agente `ux-ui-licitagym` | agente `frontend-dashboard` | vitest + skill `run-dashboard` | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | skill `deploy-dashboard` |

Ordem: PR do LicitaGym (K-1, K-2) mergeado e publicado antes do PR do Dashboard (K-3). O K-2 é compatível (campos
novos), então o painel atual continua funcionando entre um merge e outro, só com o rótulo antigo.

## Fora de escopo

- Reclassificar itens (`categoria_escopo`) pelo TR ou pela regra de "ar livre": é trabalho do coletor e do agente de
  edital (0032). Esta spec só escolhe quais categorias já gravadas entram na soma.
- Certames em leads com objeto fora do escopo (enfermagem, incêndio florestal, mobiliário, material escolar): problema
  de classificação da prioridade, issue própria.
- Divergência entre o KPI de 7 dias (prazo efetivo) e o card "Próximos prazos" (`data_fim`), registrada no PR #124 do
  Dashboard.
- Valor do Sistema S sem item valorado: continua fora da soma (fica em "N de M").

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_dashboard_resumo_valor_itens_escopo.sql` (timestamp maior que o
  da `main`); `create or replace` com a mesma assinatura e o mesmo tipo de retorno; não destrutiva; idempotente.
- **Tabelas/views/funções tocadas:** altera `public.dashboard_resumo_executivo`; passa a ler `public.licitacao_itens`
  (`licitacao_id`, `categoria_escopo`, `valor_total_estimado`) além da view de prioridade. Quem lê: `api-dashboard-oportunidades`.
- **ACL/RLS:** nenhuma mudança (revoke/grant repetidos na migration para ficar idempotente). Função é `security invoker`:
  o `service_role` precisa de SELECT em `licitacao_itens` (conferir na implementação).
- **Desempenho:** a função hoje leva em média 1,36 s (6 chamadas, `pg_stat_statements`, 09/11). O join com
  `licitacao_itens` (~163 mil itens em leads/monitorar) precisa de medição com `explain analyze` na branch de preview;
  não medido.
- **Backfill/reprocessamento:** não. Contagem antes/depois do KPI no PR (resultado da função com e sem a mudança, na
  branch de preview).
- **Edge Functions republicadas no merge:** todas; muda `api-dashboard-oportunidades` (dois campos novos na resposta).
- **Contrato com o Dashboard:** muda o significado de `valor_potencial_total`, `com_valor_total` e `prazo_*_valor`
  (mesmos nomes); dois campos novos. O PR do backend vai ao ar antes do front.
- **Dado oficial x derivado:** `valor_total_estimado` do item vem da fonte (PNCP); `categoria_escopo` é derivada pelo
  coletor (CATMAT e termos, não TR). A soma é derivada no PostgreSQL; item sem valor não vira 0.

## Decisões do Marcelo

- 09/11/2026: abrir spec para o KPI somar só os itens no escopo.
- 09/11/2026 (P-1): a 0050 entra na exceção à regra de foco da 0048.
- 09/11/2026 (P-2): contam os itens `forte`, `catmat`, `borracha`, `piso` e `obra_piso`; `fraco` e item sem categoria
  ficam fora ("sem fraco"; R$ 237,3 mi na base gravada, sem recorte de catálogo).
- 09/11/2026 (P-6): itens `manutencao` (peças de reposição de aparelho; categoria do coletor) também contam.
  Em 09/11 eram 291 itens (R$ 603.351), nenhum em certame `leads`/`monitorar`.
- 09/11/2026 (P-3): vale somar pela `categoria_escopo` do coletor (CATMAT e termos), desde que o rótulo do KPI deixe o
  critério claro. Volta a ser revisto quando houver aderência pelo TR (0032).
- 09/11/2026 (P-4): o KPI passa a se chamar "Valor no escopo" (no lugar de "Valor potencial").
- 09/11/2026 (P-5): `prazo_amanha_valor` e `prazo_7_dias_valor` mudam junto, com o mesmo critério de itens no escopo.

## Perguntas em aberto

- (nenhuma)
