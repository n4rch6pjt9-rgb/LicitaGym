# 0046: Organizar Oportunidades por modalidade, enxugar as colunas e limitar o Histórico a 90 dias

- **Status:** rascunho
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades, "no ar, em ajuste"). Não alimenta fase
  da spec-mãe 0032; o Marcelo autorizou em 09/11/2026 que entre agora, fora da "regra de foco".
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** migrations, edge-functions (`api-dashboard-oportunidades`), coletor (resultados), dashboard-contrato,
  dashboard-tela, regras de produto
- **Depende do ok do Marcelo:** sim (migration, reclassificação do objeto canônico, decisão de produto, revogação de regra)
- **Substitui:** spec 0045 (`parada`). A 0045 tirava credenciamento do escopo; o Marcelo decidiu o contrário em 09/11/2026.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` (dos dois repositórios) | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação; UASG, número da compra e modalidade são identificadores oficiais | sim no backend |
| 3 | `.claude/rules/regras-negocio.md` | regra "credenciamento nunca vira lead" que esta spec revoga; prioridade `leads`/`monitorar`/`historico`; preço vem de compra homologada | sim no backend |
| 4 | `docs/produto/ESCOPO.md` | módulo 1; "Fora de escopo: contrato de serviço: credenciamento..." muda | não: ler |
| 5 | esta spec e `specs/0045-credenciamento-nunca-vira-lead.md` (medições de 09/11) | contrato, CAs, histórico da decisão | não: ler |
| 6 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/coletor.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta: ler antes |
| 7 | `supabase/migrations/20261026000000_varredura_certames_historico.sql` | definição atual da view `licitacoes_externas_prioridade_efetiva` (colunas novas vão no fim) | não: ler |
| 8 | `supabase/migrations/20261004140000_objeto_canonico.sql` | catálogo `objeto_categorias` (slug `credenciamento`, ordem 10) e `objeto_reclassificar()` | não: ler |
| 9 | `supabase/functions/api-dashboard-oportunidades/README.md`, `query.ts` (`applyLicitacaoFilters`, `applyOportunidadesScope`), `validation.ts`, `types.ts` | filtro `modalidade` já existe; recorte padrão leads+monitorar; `historico` só do BI | não: ler |
| 10 | `services/coletor-externo/coletor/pncp.py` (montagem de `numero_edital` ~1322, gravação ~1484, coleta de resultados) e `escopo.py` (`servico_sem_material`) | rótulo "Modalidade nº N/ANO"; o que tira credenciamento de serviço do escopo; quando o resultado homologado é gravado | não: ler |
| 11 | `supabase/functions/api-fornecedores-homologados/index.ts` e a view `homologacoes_itens` | de onde o histórico de preço lê o homologado | não: ler |
| 12 | Dashboard: `src/components/opportunities/OpportunityListView.tsx` (colunas, decisão de 07/11/2026), `filtrosUrl.ts`, `src/data/providers/supabaseProvider.ts` (`numero_edital_rotulo`) | colunas e filtros atuais | não: ler |
| 13 | `docs/pncp/schemas-consultas-pncp.md` e `docs/pncp/openapi/pncp-consulta-v3-api-docs-2026-10-09.json` (`modoDisputaId`, `modoDisputaNome`, `codigoModoDisputa`) | campos oficiais de modalidade, modo de disputa, número, ano e unidade | não: ler |
| 14 | `docs/produto/FASE-1-FRONTEND.md` §4 | kit de filtros multirrota (frente própria; esta spec não cria filtro paralelo) | não: ler |
| 15 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `revisor-migration.md`, `revisor-seguranca.md`; Dashboard: `.claude/agents/frontend-dashboard.md`, `ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Decisões do Marcelo (09/11/2026)

- Oportunidades é organizada pela **modalidade da contratação** (dado oficial), não por palavra do objeto. Abas:
  **Credenciamento**, **Pregão**, **Concorrência**, **Dispensa** e **Histórico – Homologados** (singular,
  substituindo "Credenciamentos", "Pregões", "Dispensas", "Histórico").
- **Credenciamento vira oportunidade** na sua aba. Revoga "credenciamento nunca vira lead" de
  `regras-negocio.md` e tira "credenciamento" da linha "Contrato de serviço" do `ESCOPO.md`. **Credenciamento de
  serviço de pessoas** (oficineiros, aulas, instrutores) **continua fora** do escopo, como hoje.
- **Modalidade é o gate; tipo de disputa não é gate.** Dentro de cada aba há filtro por tipo de disputa.
- Objeto com "CREDENCIAMENTO" em outra modalidade (id 191, Inexigibilidade) **não** vai para a aba Credenciamento.
- **Histórico – Homologados:** a compra fica na aba por **90 dias contados da `data_homologacao`**. Depois sai da
  aba e continua no banco e no BI; nada é apagado; `get` individual continua funcionando (links do BI, decisão de
  30/09/2026). Compra `historico` sem `data_homologacao` (encerrada, cancelada, deserta) não entra nesta aba.
- **O preço homologado alimenta o histórico de preço no mesmo dia ou no dia seguinte (D+1) da homologação**,
  independente dos 90 dias da aba.
- **Rótulo do edital só com o número** ("6/2026", não "Credenciamento nº 6/2026"): a modalidade já está na aba e
  na coluna; a mesma informação não se repete em campos diferentes.
- **A lista aproveita melhor a tabela:** entram valor previsto e UASG. Revê a decisão de 07/11/2026 ("valor fica no
  detalhe", comentário em `OpportunityListView.tsx`).
- **A coluna do código da unidade se chama "UASG"** (decisão final de 09/11, revendo "Unidade (código)" do mesmo
  dia). Como no PNCP o `unidade_codigo` só é UASG quando a unidade é do SIASG, a dica da coluna (`title`) diz "Código
  da unidade compradora no PNCP".
- **Objeto canônico:** a categoria `credenciamento` sai do catálogo para todas as linhas. O BI não pesa na decisão:
  o Marcelo não tem BI entregue nem definição do frontend do BI (ver Fora de escopo).

## Tipo de disputa (definição usada nesta spec)

O filtro "tipo de disputa" usa o **modo de disputa** que o órgão informa no PNCP (`modoDisputaNome`; na busca,
`modo_disputa_nome`). É como os lances são dados, conforme a Lei 14.133/2021, art. 56:

| Valor no PNCP | O que é |
|---|---|
| Aberto | os licitantes dão lances públicos e sucessivos, crescentes ou decrescentes |
| Fechado | as propostas ficam em sigilo até a data e hora marcadas para a divulgação |
| Aberto-Fechado | fase de lances abertos seguida de lance final fechado |
| Fechado-Aberto | propostas fechadas; os melhores classificados passam a uma fase de lances abertos |
| Dispensa Com Disputa | dispensa eletrônica com fase de lances (regulamentação federal da dispensa eletrônica; o `/implement` cita o ato exato) |
| Não se aplica | contratação sem disputa (credenciamento, inexigibilidade, dispensa sem disputa) |

Os seis valores foram lidos dos dados gravados em 09/11/2026 (contagens no Problema). A tabela oficial de domínio do
PNCP (ids) **não foi conferida** nesta spec: o `/implement` confere no Manual de Integração do PNCP antes de fixar a
lista; as opções do filtro vêm dos valores presentes no banco, nunca de lista inventada.

A **forma** (Eletrônico/Presencial, art. 17 §2º) não é tipo de disputa: hoje vem dentro do nome da modalidade
("Pregão - Eletrônico") e aparece na coluna "Forma" das abas Pregão e Concorrência (ver colunas).

## Problema

Medido em 09/11/2026 (MCP somente leitura, `licitacoes_externas`, prioridade **gravada**; a view efetiva não é legível
pelo papel do MCP):

**Modalidade x prioridade (PNCP)**

| modalidade | leads | monitorar | historico | NULL |
|---|---|---|---|---|
| Pregão - Eletrônico | 864 | 803 | 1185 | 244 |
| Pregão - Presencial | 13 | 6 | 20 | 2 |
| Pregão – Eletrônico Internacional (com travessão e espaço no fim) | 0 | 0 | 0 | 1 |
| Dispensa | 103 | 113 | 423 | 61 |
| Concorrência - Eletrônica | 76 | 10 | 11 | 23 |
| Concorrência - Presencial | 1 | 0 | 0 | 2 |
| Credenciamento | 18 | 3 | 6 | 16 |
| Inexigibilidade | 0 | 2 | 5 | 8 |
| Pré-qualificação | 1 | 0 | 0 | 0 |
| Leilão (Eletrônico/Presencial) | 0 | 0 | 0 | 4 |

**Modo de disputa** nas 2.013 PNCP em `leads`/`monitorar` (`raw.modo_disputa_nome`): Aberto 1.315, Aberto-Fechado 439,
Dispensa Com Disputa 184, Não se aplica 51, Fechado-Aberto 23, Fechado 1. Não é coluna da tabela nem da view.

**Histórico** (todas as fontes): 2.187 linhas `historico`; 1.643 com `data_homologacao`, 696 nos últimos 90 dias;
544 sem `data_homologacao`.

**Atraso do preço homologado:** das 708 compras com `data_homologacao` nos últimos 90 dias, 702 têm resultado em
`licitacao_resultados` e 6 não têm. Só 220 das 702 tiveram o primeiro resultado gravado até D+1 da homologação
(horário de Brasília); mediana 8,1 dias, máximo 71,9 dias. A causa não foi medida (pode ser o coletor achar a
homologação tarde, ou gravar o resultado tarde); o `/implement` investiga antes de mudar código.

**Colunas da lista** (2.024 linhas em `leads`/`monitorar`, todas as fontes):
- Rótulo = `numero_edital` montado pelo coletor como `"{modalidade} nº {numeroCompra}/{ano}"` (`pncp.py` ~1322) e
  repassado pelo Dashboard como `numero_edital_rotulo`. 2.013 repetem a modalidade no rótulo.
- 70 têm o ano duplicado ("05/2025/2025"): em 71 PNCP o `raw.numero` já termina em "/ANO" e o coletor acrescenta de novo.
- 31 trazem o processo no rótulo ("Pregão - Eletrônico nº 40 | Processo 2587/2026").
- Objeto canônico "CREDENCIAMENTO" em 16 delas (44 no banco): `credenciamento` tem ordem 10 no catálogo e vence as
  outras, então a coluna Objeto repete a modalidade e esconde o que é comprado (id 125: material de expediente).
- Valor previsto (`valor_total` > 0): 1.798 de 2.024; ausente em 226.
- Código da unidade: `raw.unidade_codigo` em 2.013 de 2.013 PNCP; 0 nas 11 do Sistema S. Não é coluna da view.
  Quantas são unidades SIASG (UASG de fato): não medido.
- Hoje: seis colunas (rótulo, órgão, objeto canônico, modalidade, UF, prazo) + Pipeline, decididas em 07/11/2026.

## Colunas da lista (proposta para o Marcelo validar)

Abas Credenciamento, Pregão, Concorrência e Dispensa:

| Nº | Órgão licitante | Objeto | Valor previsto | UASG | UF | Prazo | Forma ou disputa | Pipeline |
|---|---|---|---|---|---|---|---|---|
| 6/2026 | FUNDO MUNICIPAL DE EDUCACAO - FME | AQUISIÇÃO DE MATERIAL (era "CREDENCIAMENTO") | R$ … ou "não informado" | código ou "não informado" | TO | 01/09, 02:59 | Eletrônico / Presencial (Pregão, Concorrência); modo de disputa (Dispensa, Credenciamento) | botão |

- **Nº:** `numero_compra_rotulo`; o processo vai na dica (`title`), como hoje.
- **Sai a coluna Modalidade** (a aba já diz). No lugar, "Forma ou disputa": a forma onde a modalidade tem mais de uma.
- Aba **Histórico – Homologados:** troca Prazo por "Homologada em" (`data_homologacao`) e Pipeline por "Valor
  homologado" quando houver.
- Celular: cards, como hoje, com Nº, órgão, objeto, valor e prazo.

O valor do exemplo não é um dado: é marcador de formato.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: view `licitacoes_externas_prioridade_efetiva` ganha no fim `modalidade_grupo` (`credenciamento` \| `pregao` \| `concorrencia` \| `dispensa` \| `outras`), `forma` (`eletronica` \| `presencial` \| NULL, do nome da modalidade), `modo_disputa` (`raw->>'modo_disputa_nome'`), `numero_compra` (`raw->>'numero'`), `ano_compra` (`raw->>'ano'`) e `unidade_codigo` (`raw->>'unidade_codigo'`); NULL quando ausente | linhas de `licitacoes_externas` | colunas novas; colunas existentes inalteradas | — | `service_role` (ACL da view inalterada) |
| K-2 | `api-dashboard-oportunidades` `action=list` (e contagem) com `aba` e `modo_disputa[]` | `aba` ∈ `credenciamento`, `pregao`, `concorrencia`, `dispensa`, `historico` | aba de modalidade: canônicas, `modalidade_grupo = aba`, prioridade `leads`/`monitorar`; aba `historico`: prioridade efetiva `historico` com `data_homologacao` nos últimos 90 dias (calendário de Brasília). Sem `aba`: igual a hoje | 400 `aba` ou `modo_disputa` inválido; 401 sem token | usuário autenticado (`requireUserAuth`) |
| K-3 | `api-dashboard-oportunidades` `action=get` | id | inalterado: devolve a linha mesmo fora da janela de 90 dias | 404 / 401 | usuário autenticado |
| K-4 | Rótulo do número: função pura `rotuloNumeroCompra(linha)` na API; campo novo `numero_compra_rotulo` na linha da lista | `numero_compra`, `ano_compra`, `numero_edital` | `"{numero}/{ano}"`, sem repetir o ano quando `numero` já termina em `/{ano}`; sem `numero_compra`: `numero_edital` sem o prefixo "Modalidade nº" e sem "\| Processo ..."; nada disponível: NULL ("s/n" na tela). `numero_edital` gravado **não muda** | — | API |
| K-5 | Migration: objeto canônico sem a categoria `credenciamento` (`ativo = false` no catálogo + `objeto_reclassificar()`) | 44 linhas com `objeto_categoria = 'credenciamento'` | cada uma recebe a próxima categoria que casa, ou `outros` | — | migration |
| K-6 | Regra de produto | — | `regras-negocio.md` e `ESCOPO.md` atualizados: credenciamento de material entra; abas por modalidade; Histórico 90 dias da homologação; preço até D+1 | — | PR do backend |
| K-7 | Coletor: credenciamento de material no escopo; de serviço de pessoas fora (`servico_sem_material`) | compra PNCP | sem mudança de código (comportamento atual); só teste que trava a regra | — | coletor |
| K-8 | Preço homologado até D+1: o resultado da compra homologada é gravado em `licitacao_resultados` (e aparece em `homologacoes_itens`) até o fim do dia seguinte à `data_homologacao` | compras PNCP em `monitorar` | resultado gravado em D ou D+1; atraso acima disso aparece em `private.saude_operacional_resumo()` | falha de API não vira "sem resultado" | coletor PNCP (Cloud Run Job) |
| K-9 | Dashboard: abas Credenciamento, Pregão, Concorrência, Dispensa, Histórico – Homologados; filtro de tipo de disputa dentro da aba; aba e filtro na URL; colunas da seção acima | resposta de K-2 e K-4 | estados carregando, vazio e erro explícitos por aba; valor ou UASG ausente aparece como "não informado", nunca zero | — | usuário autenticado |

Contrato com o Dashboard: **muda** (parâmetros `aba` e `modo_disputa`; campos `modalidade_grupo`, `forma`,
`modo_disputa`, `numero_compra_rotulo`, `unidade_codigo`, `valor_total` na linha da lista). Backend vai ao ar antes do
front. Sem `aba`, a lista responde como hoje (compatível); campos novos são só acréscimo.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** linhas com `modalidade` "Pregão - Eletrônico", "Pregão – Eletrônico Internacional " (travessão, espaço final), "Credenciamento", "Dispensa", "Concorrência - Presencial" e uma Inexigibilidade com objeto "CREDENCIAMENTO DE PESSOAS..." (caso id 191), **quando** se lê a view, **então** `modalidade_grupo` é `pregao`, `pregao`, `credenciamento`, `dispensa`, `concorrencia`, `outras` e `forma` é `eletronica`, `eletronica`, NULL, NULL, `presencial`, NULL (o objeto não decide). | SQL `supabase/tests/oportunidades_modalidade_check.sql` |
| CA-2 | K-2 | **Dado** leads canônicos: um Credenciamento, um Pregão "Aberto" e um Pregão "Aberto-Fechado", **quando** `list` com `aba=credenciamento` e depois `aba=pregao&modo_disputa=Aberto`, **então** volta só o Credenciamento (total 1) e depois só o Pregão "Aberto" (total 1). | Deno `tests/supabase/functions/api_dashboard_oportunidades_aba_test.ts` |
| CA-3 | K-2, K-3 | **Dado** homologadas há 10 e há 120 dias e uma `historico` sem `data_homologacao`, **quando** `list` com `aba=historico` e depois `get` da de 120 dias, **então** a lista traz só a de 10 dias e o `get` responde 200 com a de 120 (link do BI não quebra). | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-4 | K-2 | **Dado** `aba=leilao` ou chamada sem token, **quando** `list`, **então** 400 `aba inválida` e 401, respectivamente. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-5 | K-2 | **Dado** `list` sem `aba`, **quando** chamada como hoje, **então** as linhas e o total são os atuais (leads+monitorar canônicas). Regressão do contrato. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-6 | K-4 | **Dado** (`numero`="6", `ano`="2026"), (`numero`="05/2025", `ano`="2025"), linha sem `numero_compra` com `numero_edital`="Pregão - Eletrônico nº 40 \| Processo 2587/2026", e linha sem nada, **quando** `rotuloNumeroCompra` roda, **então** devolve "6/2026", "05/2025", "40" e NULL; `numero_edital` não é alterado. Regressão do ano duplicado. | Deno `tests/supabase/functions/api_dashboard_oportunidades_rotulo_test.ts` |
| CA-7 | K-5, K-7 | **Dado** objeto "CREDENCIAMENTO PARA AQUISIÇÃO DE MATERIAL DE EXPEDIENTE" (caso id 125), **quando** a migration roda duas vezes, **então** `objeto_categoria` deixa de ser `credenciamento` e o resultado é o mesmo nas duas; e, no coletor, credenciamento de oficineiros (caso Angatuba, id 229) continua com categoria `None`. | SQL `supabase/tests/oportunidades_modalidade_check.sql` + skill `validar-migrations`; pytest `services/coletor-externo/tests/test_escopo_servicos.py` |
| CA-8 | K-8 | **Dado** compra em `monitorar` cujo detalhe no PNCP passa a ter homologação e resultado no dia D, **quando** o coletor roda em D ou D+1, **então** `licitacao_resultados` tem as linhas da compra; e, se a API de resultados falhar, a compra não é marcada como "sem resultado" e o atraso aparece na saúde operacional. | pytest `services/coletor-externo/tests/test_resultado_d1.py` + consulta da skill `verificar-producao` (percentual até D+1 no PR, antes e depois) |
| CA-9 | K-9 | **Dado** a tela de Oportunidades, **quando** o usuário abre a aba Credenciamento e escolhe um tipo de disputa, **então** a URL guarda os dois, a lista chama `aba=credenciamento&modo_disputa=...`, o rótulo mostra só o número, não há coluna Modalidade, a coluna "UASG" tem a dica "Código da unidade compradora no PNCP", valor e UASG ausentes aparecem como "não informado" e a aba vazia mostra estado vazio explícito. | vitest `src/test/oportunidades-abas-modalidade.test.tsx` (Dashboard) |

Tenant: `licitacoes_externas` não tem `tenant_id` (dado público compartilhado); a spec não muda auth, ACL nem
`service_role`. O CA negativo de acesso é o 401 do CA-4.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-5 | `/spec` | skill `nova-migration` | skill `validar-migrations` + `_check.sql` | `revisor-migration` + `revisor-seguranca` (view `security_invoker`) | `verificar-producao` + `get_advisors` |
| K-2, K-3, K-4 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| K-6 | `/spec` | no PR do backend | — | `revisor-codigo` | skill `ciclo-janelas` |
| K-7, K-8 | `/spec` | `/implement` (TDD) | pytest do coletor | `revisor-codigo` | `verificar-producao` (percentual até D+1) |
| K-9 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` (pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |

## Dry-run (contagem antes/depois, no PR)

- Abas: as 18+3 compras Credenciamento em leads/monitorar passam a aparecer na aba Credenciamento; Concorrência
  (77+10) ganha aba; o total de leads+monitorar não muda (nenhuma prioridade é regravada). Inexigibilidade (2 em
  monitorar) e Pré-qualificação (1 lead) ficam sem aba (pergunta 2).
- Objeto canônico (K-5): antes, 44 linhas com `objeto_categoria = 'credenciamento'`. Depois: **não medido** (o papel
  do MCP não executa `objeto_classificar`); o `/implement` roda a contagem por categoria nova no Supabase Preview e
  anexa ao PR.
- Rótulo (K-4): antes, 2.013 com modalidade no rótulo, 70 com ano duplicado, 31 com "| Processo". Depois: 0 nos três
  (campo novo; `numero_edital` intacto).
- Preço até D+1 (K-8): antes, 220 de 702 (31%). Depois: medido 7 dias após o deploy do coletor.

## Fora de escopo

- **BI:** não há BI entregue nem definição do frontend do BI (fala do Marcelo, 09/11/2026). Esta spec só garante o
  dado (Histórico na API, preço até D+1, `get` estável). Definir o BI é frente própria.
- Apagar ou arquivar linhas depois de 90 dias: a janela é só da aba.
- Regravar `numero_edital` no banco ou mudar a montagem do rótulo no coletor (o rótulo novo é derivado na API).
- UASG do Sistema S (não existe nessas fontes): aparece "não informado".
- **Filtros inteligentes multirrota** (`api-metadados`, `src/filtros/`, FilterBar v2, visões salvas;
  `docs/produto/FASE-1-FRONTEND.md` §4): frente própria. Esta spec só acrescenta `aba` e `modo_disputa` ao filtro
  atual de Oportunidades; o kit, quando vier, reaproveita os dois.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_oportunidades_modalidade_grupo.sql`: `create or replace view`
  acrescentando seis colunas no fim (aditiva) e `update objeto_categorias set ativo = false where slug =
  'credenciamento'` + `objeto_reclassificar()` (muda classificação de 44 linhas; idempotente); mais
  `supabase/tests/oportunidades_modalidade_check.sql`.
- **Tabelas/views/funções tocadas:** view `licitacoes_externas_prioridade_efetiva` (lida por
  `api-dashboard-oportunidades` com `service_role`); `objeto_categorias` e `licitacoes_externas.objeto_categoria`
  (K-5); `licitacao_resultados` escrita pelo coletor (K-8, mais cedo; sem mudança de schema). Prioridade não muda.
- **ACL/RLS:** nenhum grant novo; view segue `security_invoker = true`.
- **Backfill/reprocessamento:** sim, só `objeto_categoria` (K-5), com contagem antes/depois no PR.
- **Edge Functions republicadas no merge:** todas (merge na `main`); muda `api-dashboard-oportunidades`. O coletor
  só muda depois do deploy do Cloud Run Job.
- **Contrato com o Dashboard:** muda (K-2, K-4, K-9); backend primeiro, sem `aba` continua compatível.
- **Dado oficial x derivado:** `modalidade`, `modo_disputa_nome`, `numero`, `ano`, `unidade_codigo`, `valor_total` e
  resultados vêm do PNCP sem alteração; `modalidade_grupo`, `forma`, `numero_compra_rotulo` e `objeto_categoria` são
  derivados por regra escrita e testada (CA-1, CA-6, CA-7). Nada inventado; ausente aparece como "não informado".

## Perguntas em aberto

1. **Colunas:** a proposta da seção "Colunas da lista" atende? Algo mais entra (município, data de abertura,
   registro de preço)?
2. **Inexigibilidade e Pré-qualificação:** hoje 2 em monitorar e 1 lead. Ficam sem aba, ou ganham uma aba "Outras"?
3. **Tipo de disputa:** a definição da seção "Tipo de disputa" (modo de disputa do PNCP, art. 56) está certa? A forma
   Eletrônico/Presencial fica como coluna e não como filtro?
4. **K-8 na mesma spec:** o preço até D+1 mexe no coletor e pode virar uma spec própria se a causa do atraso for
   grande. Mantém aqui?
