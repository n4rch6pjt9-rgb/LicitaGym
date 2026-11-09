# 0046: Organizar Oportunidades por modalidade, enxugar as colunas e limitar o Histórico a 90 dias

- **Status:** rascunho
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades, "no ar, em ajuste"). Não alimenta fase
  da spec-mãe 0032: pela "regra de foco" do `ESCOPO.md`, entra só com ok do Marcelo (pergunta 1).
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** migrations, edge-functions (`api-dashboard-oportunidades`), dashboard-contrato, dashboard-tela, regras de produto
- **Depende do ok do Marcelo:** sim (migration, reclassificação do objeto canônico, decisão de produto, revogação de regra)
- **Substitui:** spec 0045 (`parada`). A 0045 tirava credenciamento do escopo; o Marcelo decidiu o contrário em 09/11/2026.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` (dos dois repositórios) | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação; UASG, número da compra e modalidade são identificadores oficiais | sim no backend |
| 3 | `.claude/rules/regras-negocio.md` | regra "credenciamento nunca vira lead" que esta spec revoga; prioridade `leads`/`monitorar`/`historico` | sim no backend |
| 4 | `docs/produto/ESCOPO.md` | módulo 1; "Fora de escopo: contrato de serviço: credenciamento..." muda | não: ler |
| 5 | esta spec e `specs/0045-credenciamento-nunca-vira-lead.md` (medições de 09/11) | contrato, CAs, histórico da decisão | não: ler |
| 6 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta: ler antes |
| 7 | `supabase/migrations/20261026000000_varredura_certames_historico.sql` | definição atual da view `licitacoes_externas_prioridade_efetiva` (colunas novas vão no fim) | não: ler |
| 8 | `supabase/migrations/20261004140000_objeto_canonico.sql` | catálogo `objeto_categorias` (slug `credenciamento`, ordem 10) e `objeto_reclassificar()` | não: ler |
| 9 | `supabase/functions/api-dashboard-oportunidades/README.md`, `query.ts` (`applyLicitacaoFilters`, `applyOportunidadesScope`), `validation.ts`, `types.ts` | filtro `modalidade` já existe; recorte padrão leads+monitorar; `historico` só do BI | não: ler |
| 10 | `services/coletor-externo/coletor/pncp.py` (montagem de `numero_edital` ~1322, gravação ~1484) e `escopo.py` (`servico_sem_material`) | de onde vem o rótulo "Modalidade nº N/ANO" e o que tira credenciamento do escopo | não: ler |
| 11 | Dashboard: `src/components/opportunities/OpportunityListView.tsx` (colunas, decisão de 07/11/2026), `filtrosUrl.ts`, `src/data/providers/supabaseProvider.ts` (`numero_edital_rotulo`) | colunas e filtros atuais | não: ler |
| 12 | `docs/pncp/schemas-consultas-pncp.md` | campos oficiais: modalidade, modo de disputa, `numeroCompra`, `anoCompra`, `unidadeOrgao.codigoUnidade` | não: ler |
| 13 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `revisor-migration.md`, `revisor-seguranca.md`; Dashboard: `.claude/agents/frontend-dashboard.md`, `ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Decisões do Marcelo (09/11/2026)

- Oportunidades é organizada pela **modalidade da contratação** (dado oficial), não por palavra do objeto. Abas:
  **Credenciamento**, **Pregão**, **Dispensa** e **Histórico – Homologados** (singular, substituindo
  "Credenciamentos", "Pregões", "Dispensas", "Histórico").
- **Credenciamento vira oportunidade** na sua aba. Revoga "credenciamento nunca vira lead" de
  `regras-negocio.md` e tira "credenciamento" da linha "Contrato de serviço" do `ESCOPO.md`.
- **Modalidade é o gate; tipo de disputa não é gate.** Dentro de cada aba pode haver filtro por tipo de disputa.
- **Histórico – Homologados mostra 90 dias.** Depois o registro sai da aba e continua no banco e no BI. Nada é
  apagado. `get` individual continua funcionando (links do BI), como decidido em 30/09/2026.
- Objeto com "CREDENCIAMENTO" em outra modalidade (id 191, Inexigibilidade) **não** vai para a aba Credenciamento.
- **Rótulo do edital só com o número** ("6/2026", não "Credenciamento nº 6/2026"): a modalidade já está na aba e
  na coluna; a mesma informação não se repete em campos diferentes.
- **A lista aproveita melhor a tabela:** entram colunas como UASG e valor previsto. Revê a decisão de 07/11/2026
  ("valor fica no detalhe", comentário em `OpportunityListView.tsx`).

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

**Tipo de disputa** nas 2.013 PNCP em `leads`/`monitorar`, campo `raw.modo_disputa_nome` (busca do PNCP): Aberto 1.315,
Aberto-Fechado 439, Dispensa Com Disputa 184, Não se aplica 51, Fechado-Aberto 23, Fechado 1. Não é coluna da tabela
nem da view.

**Histórico** (todas as fontes): 2.187 linhas `historico`; 1.643 com `data_homologacao`, 696 delas nos últimos
90 dias; 544 sem `data_homologacao` (encerradas, canceladas, desertas etc.).

**Colunas da lista** (2.024 linhas em `leads`/`monitorar`, todas as fontes):
- Rótulo = `numero_edital` montado pelo coletor como `"{modalidade} nº {numeroCompra}/{ano}"` (`pncp.py` ~1322) e
  repassado pelo Dashboard como `numero_edital_rotulo`. 2.013 repetem a modalidade no rótulo.
- 70 têm o ano duplicado ("05/2025/2025"): em 71 PNCP o `raw.numero` já termina em "/ANO" e o coletor acrescenta de
  novo.
- 31 vêm do título da busca com processo ("Pregão - Eletrônico nº 40 | Processo 2587/2026").
- Objeto canônico "CREDENCIAMENTO" em 16 delas: o catálogo `objeto_categorias` tem `credenciamento` na ordem 10
  (vence todas as outras), então a coluna Objeto repete a modalidade e esconde o que é comprado (id 125: material de
  expediente).
- Valor previsto (`valor_total` > 0): 1.798 de 2.024. Ausente em 226.
- Código da unidade compradora: `raw.unidade_codigo` em 2.013 de 2.013 PNCP; 0 nas 11 do Sistema S. Não é coluna da
  view. No PNCP é o código da unidade no órgão; só é UASG do Compras.gov quando a unidade é do SIASG (não medido
  quantas são).
- Hoje: seis colunas (rótulo, órgão, objeto canônico, modalidade, UF, prazo) + Pipeline, decididas em 07/11/2026.

**Credenciamento hoje:** `pncp.avaliar` tira do escopo só o credenciamento de serviço de pessoas
(`servico_sem_material`); credenciamento de material entra (18 leads).

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: view `licitacoes_externas_prioridade_efetiva` ganha no fim `modalidade_grupo` (`credenciamento` \| `pregao` \| `dispensa` \| `concorrencia` \| `outras`, da `modalidade` normalizada), `modo_disputa` (`raw->>'modo_disputa_nome'`), `numero_compra` (`raw->>'numero'`), `ano_compra` (`raw->>'ano'`) e `unidade_codigo` (`raw->>'unidade_codigo'`); NULL quando ausente | linhas de `licitacoes_externas` | colunas novas; colunas existentes inalteradas | — | `service_role` (ACL da view inalterada) |
| K-2 | `api-dashboard-oportunidades` `action=list` (e contagem) com `aba` e `modo_disputa[]` | `aba` ∈ `credenciamento`, `pregao`, `dispensa`, `historico` (+ o que a pergunta 2 decidir) | aba de modalidade: canônicas, `modalidade_grupo = aba`, prioridade `leads`/`monitorar`; aba `historico`: prioridade efetiva `historico` com data de referência nos últimos 90 dias (pergunta 3). Sem `aba`: igual a hoje | 400 `aba` ou `modo_disputa` inválido; 401 sem token | usuário autenticado (`requireUserAuth`) |
| K-3 | `api-dashboard-oportunidades` `action=get` | id | inalterado: devolve a linha mesmo fora da janela de 90 dias | 404 / 401 | usuário autenticado |
| K-4 | Rótulo do número: função pura `rotuloNumeroCompra(linha)` na API; campo novo `numero_compra_rotulo` na linha da lista | `numero_compra`, `ano_compra`, `numero_edital` | `"{numero}/{ano}"`, sem repetir o ano quando `numero` já termina em `/{ano}`; sem `numero_compra` (Sistema S): `numero_edital` sem o prefixo "Modalidade nº" e sem "\| Processo ..."; nada disponível: NULL ("s/n" na tela). `numero_edital` gravado **não muda** | — | API |
| K-5 | Migration: objeto canônico deixa de ter a categoria `credenciamento` (`ativo = false` no catálogo + `objeto_reclassificar()`), para a coluna Objeto mostrar o que é comprado | 44 linhas hoje com `objeto_categoria = 'credenciamento'` (pergunta 7) | cada uma recebe a próxima categoria que casa, ou `outros` | — | migration |
| K-6 | Regra de produto | — | `regras-negocio.md` e `ESCOPO.md` atualizados (credenciamento entra; abas por modalidade; Histórico 90 dias) | — | PR do backend |
| K-7 | Coletor: credenciamento de **material** continua no escopo; credenciamento de serviço de pessoas (oficineiros, aulas) continua fora (pergunta 4) | compra PNCP | sem mudança de código se a pergunta 4 confirmar | — | coletor |
| K-8 | Dashboard: Oportunidades com abas Credenciamento, Pregão, Dispensa, Histórico – Homologados; filtro de tipo de disputa dentro da aba; aba e filtro na URL; colunas da lista revistas (proposta abaixo) | resposta de K-2 e K-4 | estados carregando, vazio e erro explícitos por aba; valor ou código ausente aparece como "não informado", nunca zero | — | usuário autenticado |

**Proposta de colunas (K-8), para o Marcelo validar (pergunta 6):** Nº (`numero_compra_rotulo`, com o processo no
`title`) · Órgão licitante · Objeto (canônico, sem "CREDENCIAMENTO") · Valor previsto (`valor_total`) · UASG/código da
unidade (`unidade_codigo`) · UF · Prazo · Pipeline. A coluna Modalidade sai (a aba já diz); em Pregão e Concorrência
a forma (Eletrônico/Presencial) ou o tipo de disputa podem ocupar o lugar dela (pergunta 5). Celular: cards, como hoje.

Contrato com o Dashboard: **muda** (parâmetros `aba` e `modo_disputa`; campos `modalidade_grupo`, `modo_disputa`,
`numero_compra_rotulo`, `unidade_codigo`, `valor_total` na linha da lista). Backend vai ao ar antes do front. Sem
`aba`, a lista responde como hoje (compatível); campos novos são só acréscimo.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** linhas com `modalidade` "Pregão - Eletrônico", "Pregão – Eletrônico Internacional " (travessão, espaço final), "Credenciamento", "Dispensa", "Concorrência - Eletrônica" e uma Inexigibilidade com objeto "CREDENCIAMENTO DE PESSOAS..." (caso id 191), **quando** se lê a view, **então** `modalidade_grupo` é `pregao`, `pregao`, `credenciamento`, `dispensa`, `concorrencia`, `outras` (o objeto não decide). | SQL `supabase/tests/oportunidades_modalidade_check.sql` |
| CA-2 | K-2 | **Dado** um lead Credenciamento e um lead Pregão canônicos, **quando** `list` com `aba=credenciamento`, **então** só o Credenciamento volta e a contagem é 1. | Deno `tests/supabase/functions/api_dashboard_oportunidades_aba_test.ts` |
| CA-3 | K-2 | **Dado** dois leads Pregão com `modo_disputa` "Aberto" e "Aberto-Fechado", **quando** `list` com `aba=pregao&modo_disputa=Aberto`, **então** só o "Aberto" volta. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-4 | K-2, K-3 | **Dado** homologadas há 10 e há 120 dias (prioridade efetiva `historico`), **quando** `list` com `aba=historico` e depois `get` da de 120 dias, **então** a lista traz só a de 10 dias e o `get` responde 200 com a de 120 (link do BI não quebra). | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-5 | K-2 | **Dado** `aba=leilao` ou chamada sem token, **quando** `list`, **então** 400 `aba inválida` e 401, respectivamente. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-6 | K-2 | **Dado** `list` sem `aba`, **quando** chamada como hoje, **então** as linhas e o total são os atuais (leads+monitorar canônicas). Regressão do contrato. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-7 | K-4 | **Dado** (`numero`="6", `ano`="2026"), (`numero`="05/2025", `ano`="2025"), linha sem `numero_compra` com `numero_edital`="Pregão - Eletrônico nº 40 \| Processo 2587/2026", e linha sem nada, **quando** `rotuloNumeroCompra` roda, **então** devolve "6/2026", "05/2025", "40" e NULL; `numero_edital` não é alterado. Regressão do ano duplicado. | Deno `tests/supabase/functions/api_dashboard_oportunidades_rotulo_test.ts` |
| CA-8 | K-5 | **Dado** objeto "CREDENCIAMENTO PARA AQUISIÇÃO DE MATERIAL DE EXPEDIENTE" (caso id 125), **quando** a migration roda e `objeto_reclassificar()` termina, **então** `objeto_categoria` deixa de ser `credenciamento` e a migration é idempotente (rodar duas vezes dá o mesmo resultado). | SQL `supabase/tests/oportunidades_modalidade_check.sql` + skill `validar-migrations` |
| CA-9 | K-8 | **Dado** a tela de Oportunidades, **quando** o usuário abre a aba Credenciamento e escolhe um tipo de disputa, **então** a URL guarda os dois, a lista chama `aba=credenciamento&modo_disputa=...`, o rótulo mostra só o número, não há coluna Modalidade, valor e UASG ausentes aparecem como "não informado" e a aba vazia mostra estado vazio explícito. | vitest `src/test/oportunidades-abas-modalidade.test.tsx` (Dashboard) |

Tenant: `licitacoes_externas` não tem `tenant_id` (dado público compartilhado); a spec não muda auth, ACL nem
`service_role`. O CA negativo de acesso é o 401 do CA-5.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-5 | `/spec` | skill `nova-migration` | skill `validar-migrations` + `_check.sql` | `revisor-migration` + `revisor-seguranca` (view `security_invoker`) | `verificar-producao` + `get_advisors` |
| K-2, K-3, K-4 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| K-6 | `/spec` | no PR do backend | — | `revisor-codigo` | skill `ciclo-janelas` |
| K-7 | `/spec` | só se a pergunta 4 pedir mudança | pytest do coletor | `revisor-codigo` | — |
| K-8 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` (pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |

## Dry-run (contagem antes/depois, no PR)

- Abas: as 18+3 compras Credenciamento em leads/monitorar passam a aparecer na aba Credenciamento; o total de
  leads+monitorar não muda (nenhuma prioridade é regravada).
- Objeto canônico (K-5): antes, 44 linhas com `objeto_categoria = 'credenciamento'` (16 em leads/monitorar). Depois:
  **não medido** (o papel do MCP não executa `objeto_classificar`); o `/implement` roda a contagem por categoria
  nova num Postgres descartável com cópia das 44 linhas, ou no Supabase Preview, e anexa ao PR.
- Rótulo (K-4): antes, 2.013 com modalidade no rótulo, 70 com ano duplicado, 31 com "| Processo". Depois: 0 nos três
  (campo novo; `numero_edital` intacto).

## Fora de escopo

- Apagar ou arquivar linhas depois de 90 dias: a janela é só da aba; banco e BI ficam como estão.
- Regravar `numero_edital` no banco ou mudar a montagem do rótulo no coletor (o rótulo novo é derivado na API).
- Abas para Inexigibilidade, Leilão e Pré-qualificação, salvo o que a pergunta 2 decidir.
- UASG do Sistema S (não há código de unidade nessas fontes): aparece "não informado".
- **Filtros inteligentes multirrota** (`api-metadados`, `src/filtros/`, FilterBar, visões salvas; consolidação de
  28/10/2026 citada pelo Marcelo): frente própria. Esta spec só acrescenta `aba` e `modo_disputa` ao filtro atual de
  Oportunidades, sem criar um sistema de filtros paralelo; se aquela frente já tiver `filtros_aplicados`/`ignorados[]`
  na API, a implementação segue o mesmo formato.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_oportunidades_modalidade_grupo.sql`: `create or replace view`
  acrescentando cinco colunas no fim (aditiva) e `update objeto_categorias set ativo = false where slug =
  'credenciamento'` + `objeto_reclassificar()` (muda classificação de 44 linhas; idempotente); mais
  `supabase/tests/oportunidades_modalidade_check.sql`.
- **Tabelas/views/funções tocadas:** view `licitacoes_externas_prioridade_efetiva` (lida por
  `api-dashboard-oportunidades` com `service_role` e pelo BI); `objeto_categorias` e
  `licitacoes_externas.objeto_categoria` (K-5). Prioridade não muda.
- **ACL/RLS:** nenhum grant novo; view segue `security_invoker = true`.
- **Backfill/reprocessamento:** sim, só `objeto_categoria` (K-5), com contagem antes/depois no PR.
- **Edge Functions republicadas no merge:** todas (merge na `main`); muda `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** muda (K-2, K-4, K-8); backend primeiro, sem `aba` continua compatível.
- **Dado oficial x derivado:** `modalidade`, `modo_disputa_nome`, `numero`, `ano`, `unidade_codigo` e `valor_total`
  vêm do PNCP sem alteração; `modalidade_grupo`, `numero_compra_rotulo` e `objeto_categoria` são derivados por regra
  escrita e testada (CA-1, CA-7, CA-8). Nada inventado; ausente aparece como "não informado".

## Perguntas em aberto

1. **Foco:** a spec alimenta o módulo 1, não uma fase da 0032. Entra agora?
2. **Concorrência e outras:** Concorrência tem 77 leads e não está entre as três abas. Aba própria, dentro de Pregão,
   ou sem aba? E Inexigibilidade (2 em monitorar) e Pré-qualificação (1 lead)?
3. **Data dos 90 dias:** a partir de `data_homologacao`? As 544 linhas `historico` sem `data_homologacao`
   (encerradas, canceladas, desertas) entram em "Histórico – Homologados" pela data de encerramento, ou ficam fora?
4. **Credenciamento de serviço de pessoas:** oficineiros/aulas continuam fora (contrato de serviço) e só o de
   material vira oportunidade? Ou todo credenciamento entra?
5. **Tipo de disputa:** o filtro usa o modo de disputa do PNCP (Aberto, Aberto-Fechado, Fechado-Aberto, Fechado,
   Dispensa Com Disputa, Não se aplica) ou a forma (Eletrônico/Presencial, hoje dentro do nome da modalidade)?
6. **Colunas:** a proposta (Nº, Órgão, Objeto, Valor previsto, UASG/código da unidade, UF, Prazo, Pipeline) atende?
   Algo mais entra (município, data de abertura, registro de preço)?
7. **Objeto canônico:** desativar a categoria `credenciamento` vale para todas as 44 linhas (inclusive `historico`
   e NULL), mudando também o que o BI mostra como objeto?
8. **UASG x código da unidade:** no PNCP, `unidade_codigo` só é UASG quando a unidade é do SIASG. A coluna se chama
   "UASG" mesmo assim, ou "Unidade (código)"?
9. **90 dias como decisão:** o código só cita uma regra antiga de 120 dias (`backfill_prioridade_pncp.py`, docstring,
   já substituída). Registro os 90 dias como decisão nova de 09/11/2026?
