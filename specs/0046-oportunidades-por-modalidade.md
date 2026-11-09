# 0046: Organizar Oportunidades por modalidade e limitar o Histórico a 90 dias

- **Status:** rascunho
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades, "no ar, em ajuste"). Não alimenta fase
  da spec-mãe 0032: pela "regra de foco" do `ESCOPO.md`, entra só com ok do Marcelo (pergunta 1).
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** migrations, edge-functions (`api-dashboard-oportunidades`), dashboard-contrato, dashboard-tela, regras de produto
- **Depende do ok do Marcelo:** sim (migration, decisão de produto, revogação de regra)
- **Substitui:** spec 0045 (`parada`). A 0045 tirava credenciamento do escopo; o Marcelo decidiu o contrário em 09/11/2026.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` (dos dois repositórios) | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação; modalidade é identificador oficial | sim no backend |
| 3 | `.claude/rules/regras-negocio.md` | regra "credenciamento nunca vira lead" que esta spec revoga; prioridade `leads`/`monitorar`/`historico` | sim no backend |
| 4 | `docs/produto/ESCOPO.md` | módulo 1; "Fora de escopo: contrato de serviço: credenciamento..." muda | não: ler |
| 5 | esta spec e `specs/0045-credenciamento-nunca-vira-lead.md` (medições de 09/11) | contrato, CAs, histórico da decisão | não: ler |
| 6 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta: ler antes |
| 7 | `supabase/migrations/20261026000000_varredura_certames_historico.sql` | definição atual da view `licitacoes_externas_prioridade_efetiva` (colunas novas vão no fim) | não: ler |
| 8 | `supabase/functions/api-dashboard-oportunidades/README.md`, `query.ts` (`applyLicitacaoFilters`, `applyOportunidadesScope`), `validation.ts`, `types.ts` | filtro `modalidade` já existe; recorte padrão leads+monitorar; `historico` só do BI | não: ler |
| 9 | `services/coletor-externo/coletor/pncp.py` (`avaliar`, gravação de `modalidade` ~1484) e `escopo.py` (`servico_sem_material`) | o que hoje tira credenciamento do escopo | não: ler |
| 10 | Dashboard: `src/components/opportunities/OpportunityListView.tsx`, `filtrosUrl.ts`, `src/utils/prioridade.ts` | navegação e filtros atuais de Oportunidades | não: ler |
| 11 | `docs/pncp/schemas-consultas-pncp.md` | nomes oficiais de modalidade e de modo de disputa (`modoDisputaNome`) | não: ler |
| 12 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `revisor-migration.md`, `revisor-seguranca.md`; Dashboard: `.claude/agents/frontend-dashboard.md`, `ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Decisões do Marcelo (09/11/2026)

- Oportunidades é organizada pela **modalidade da contratação** (dado oficial), não por palavra do objeto. Abas:
  **Credenciamento**, **Pregão**, **Dispensa** e **Histórico – Homologados** (nomes no singular, substituindo
  "Credenciamentos", "Pregões", "Dispensas", "Histórico").
- **Credenciamento vira oportunidade** na sua aba. Revoga "credenciamento nunca vira lead" de
  `regras-negocio.md` e tira "credenciamento" da linha "Contrato de serviço" do `ESCOPO.md`.
- **Modalidade é o gate; tipo de disputa não é gate.** Dentro de cada aba pode haver filtro por tipo de disputa.
- **Histórico – Homologados mostra 90 dias.** Depois disso o registro sai da aba e continua no banco e no BI. Nada é
  apagado. `get` individual continua funcionando (links do BI), como decidido em 30/09/2026.
- Objeto com "CREDENCIAMENTO" em outra modalidade (id 191, Inexigibilidade) **não** vai para a aba Credenciamento.

## Problema

Medido em 09/11/2026 (MCP somente leitura, `licitacoes_externas`, prioridade **gravada**; a view efetiva não é legível
pelo papel do MCP):

| modalidade (PNCP) | leads | monitorar | historico | NULL |
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

- Tipo de disputa nas 2.013 PNCP em `leads`/`monitorar`, campo `raw.modo_disputa_nome` (busca do PNCP): Aberto 1.315,
  Aberto-Fechado 439, Dispensa Com Disputa 184, Não se aplica 51, Fechado-Aberto 23, Fechado 1. Não é coluna da
  tabela nem da view.
- `prioridade = 'historico'` (todas as fontes): 2.187 linhas; 1.643 com `data_homologacao`, das quais 696 nos últimos
  90 dias; 544 sem `data_homologacao` (encerradas, canceladas, desertas etc.).
- Hoje a lista do Dashboard filtra por prioridade (`Leads prioritários`, `Monitorar`) e a API já aceita
  `modalidade` (lista de valores exatos). Não há abas por modalidade na `main` do Dashboard; a navegação citada pelo
  Marcelo (imagem) não foi vista nesta sessão.
- Credenciamento hoje: `pncp.avaliar` tira do escopo só o credenciamento de serviço de pessoas
  (`servico_sem_material`); credenciamento de material entra (18 leads).

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: view `licitacoes_externas_prioridade_efetiva` ganha no fim `modalidade_grupo` (`credenciamento` \| `pregao` \| `dispensa` \| `concorrencia` \| `outras`, derivada de `modalidade` normalizada) e `modo_disputa` (de `raw->>'modo_disputa_nome'`, NULL se ausente) | linhas de `licitacoes_externas` | duas colunas novas; colunas existentes inalteradas | — | `service_role` (ACL da view inalterada) |
| K-2 | `api-dashboard-oportunidades` `action=list` (e contagem) com `aba` | `aba` ∈ `credenciamento`, `pregao`, `dispensa`, `historico` (+ o que a pergunta 2 decidir); `modo_disputa[]` opcional | aba de modalidade: `eh_canonica`, `modalidade_grupo = aba`, prioridade `leads`/`monitorar`; aba `historico`: prioridade efetiva `historico` com data de referência nos últimos 90 dias (pergunta 3) | 400 `aba` ou `modo_disputa` inválido; 401 sem token | usuário autenticado (`requireUserAuth`) |
| K-3 | `api-dashboard-oportunidades` `action=get` | id | inalterado: devolve a linha mesmo fora da janela de 90 dias | 404 / 401 | usuário autenticado |
| K-4 | Regra de produto | — | `regras-negocio.md` e `ESCOPO.md` atualizados (credenciamento entra; abas por modalidade; Histórico 90 dias) | — | PR desta spec |
| K-5 | Coletor: credenciamento de **material** continua no escopo; credenciamento de serviço de pessoas (oficineiros, aulas) continua fora (pergunta 4) | compra PNCP | sem mudança de código se a pergunta 4 confirmar | — | coletor |
| K-6 | Dashboard: Oportunidades com abas Credenciamento, Pregão, Dispensa, Histórico – Homologados; filtro de tipo de disputa dentro da aba; aba na URL | resposta de K-2 | estados carregando, vazio e erro explícitos por aba | — | usuário autenticado |

Contrato com o Dashboard: **muda** (parâmetro `aba` e `modo_disputa` na lista; campos `modalidade_grupo` e
`modo_disputa` na linha). Backend vai ao ar antes do front. Sem `aba`, a lista responde como hoje (compatível).

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** linhas com `modalidade` "Pregão - Eletrônico", "Pregão – Eletrônico Internacional " (travessão, espaço final), "Credenciamento", "Dispensa", "Concorrência - Eletrônica", "Inexigibilidade", **quando** se lê a view, **então** `modalidade_grupo` é `pregao`, `pregao`, `credenciamento`, `dispensa`, `concorrencia`, `outras`. | SQL `supabase/tests/oportunidades_modalidade_check.sql` |
| CA-2 | K-1 | **Dado** linha de modalidade Inexigibilidade com objeto "CREDENCIAMENTO DE PESSOAS..." (caso id 191), **quando** se lê a view, **então** `modalidade_grupo = 'outras'` (o objeto não decide). | SQL `supabase/tests/oportunidades_modalidade_check.sql` |
| CA-3 | K-2 | **Dado** um lead Credenciamento e um lead Pregão canônicos, **quando** `list` com `aba=credenciamento`, **então** só o Credenciamento volta e a contagem é 1. | Deno `tests/supabase/functions/api_dashboard_oportunidades_aba_test.ts` |
| CA-4 | K-2 | **Dado** dois leads Pregão com `modo_disputa` "Aberto" e "Aberto-Fechado", **quando** `list` com `aba=pregao&modo_disputa=Aberto`, **então** só o "Aberto" volta. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-5 | K-2 | **Dado** homologadas há 10 e há 120 dias (prioridade efetiva `historico`), **quando** `list` com `aba=historico`, **então** só a de 10 dias volta. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-6 | K-3 | **Dado** a homologada há 120 dias, **quando** `get` pelo id, **então** 200 com a linha (link do BI não quebra). | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-7 | K-2 | **Dado** `aba=leilao` ou sem token, **quando** `list`, **então** 400 `aba inválida` e 401, respectivamente. | Deno `.../api_dashboard_oportunidades_aba_test.ts` |
| CA-8 | K-2 | **Dado** `list` sem `aba`, **quando** chamada como hoje, **então** a resposta é igual à atual (leads+monitorar canônicas). Regressão do contrato. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-9 | K-6 | **Dado** a tela de Oportunidades, **quando** o usuário troca para a aba Credenciamento e escolhe um tipo de disputa, **então** a URL guarda os dois, a lista chama `aba=credenciamento&modo_disputa=...` e a aba vazia mostra estado vazio explícito. | vitest `src/test/oportunidades-abas-modalidade.test.tsx` (Dashboard) |

Tenant: `licitacoes_externas` não tem `tenant_id` (dado público compartilhado); a spec não muda auth, ACL nem
`service_role`. O CA negativo de acesso é o 401 do CA-7.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration` | skill `validar-migrations` + `_check.sql` | `revisor-migration` + `revisor-seguranca` (view `security_invoker`) | `verificar-producao` + `get_advisors` |
| K-2, K-3 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| K-4 | `/spec` | no PR do backend | — | `revisor-codigo` | skill `ciclo-janelas` |
| K-5 | `/spec` | só se a pergunta 4 pedir mudança | pytest do coletor | `revisor-codigo` | — |
| K-6 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` (pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |

## Fora de escopo

- Apagar ou arquivar linhas depois de 90 dias: a janela é só da aba; banco e BI ficam como estão.
- Mudar a view para devolver NULL ou outra prioridade a credenciamento (a 0045 está `parada`).
- Abas para Inexigibilidade, Leilão e Pré-qualificação, salvo o que a pergunta 2 decidir.
- Fontes fora do PNCP (Sistema S/Paradigma) sem `modalidade` no padrão PNCP: caem em `outras` até mapeamento próprio.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_oportunidades_modalidade_grupo.sql`: `create or replace view`
  acrescentando duas colunas no fim; aditiva, idempotente; mais `supabase/tests/oportunidades_modalidade_check.sql`.
- **Tabelas/views/funções tocadas:** view `licitacoes_externas_prioridade_efetiva` (lida por
  `api-dashboard-oportunidades` com `service_role` e pelo BI). `licitacoes_externas` não muda.
- **ACL/RLS:** nenhum grant novo; view segue `security_invoker = true`.
- **Backfill/reprocessamento:** não. Contagem por aba antes/depois (dry-run) no PR: as 18+3 compras Credenciamento em
  leads/monitorar passam a aparecer na aba Credenciamento; o total de leads+monitorar não muda.
- **Edge Functions republicadas no merge:** todas (merge na `main`); muda `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** muda (K-2, K-6); backend primeiro, sem `aba` continua compatível.
- **Dado oficial x derivado:** `modalidade` e `modo_disputa_nome` vêm do PNCP; `modalidade_grupo` é derivado por
  regra escrita e testada (CA-1). Nada inventado.

## Perguntas em aberto

1. **Foco:** a spec alimenta o módulo 1, não uma fase da 0032. Entra agora?
2. **Concorrência e outras:** Concorrência tem 77 leads hoje e não está entre as três abas. Ganha aba própria, entra
   em Pregão, ou fica sem aba? E Inexigibilidade (2 em monitorar) e Pré-qualificação (1 lead)?
3. **Data dos 90 dias:** contar a partir de `data_homologacao`? As 544 linhas `historico` sem `data_homologacao`
   (encerradas, canceladas, desertas) entram na aba "Histórico – Homologados" pela data de encerramento, ou ficam fora
   por não serem homologadas?
4. **Credenciamento de serviço de pessoas:** credenciamento de oficineiros/aulas continua fora do escopo (contrato de
   serviço), e só o de material vira oportunidade? Ou todo credenciamento entra?
5. **Tipo de disputa:** o filtro usa o modo de disputa do PNCP (Aberto, Aberto-Fechado, Fechado-Aberto, Fechado,
   Dispensa Com Disputa, Não se aplica) ou a forma (Eletrônico/Presencial, hoje embutida no nome da modalidade)?
6. **Regra de 120 dias:** o código só cita uma regra antiga de 120 dias (`backfill_prioridade_pncp.py`, docstring,
   já substituída pela prioridade por estado). Os 90 dias desta spec ficam registrados como decisão nova de 09/11/2026?
