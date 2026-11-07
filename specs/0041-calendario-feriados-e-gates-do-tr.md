# 0041: Contar prazos em dias úteis com calendário de feriados e extrair os gates do TR

- **Status:** rascunho
- **Alimenta:** spec-mãe 0032, fase 2 (o limite de impugnação vira o prazo sugerido de "Ler o edital") e fase 3 (regras
  novas no agente de edital). A parte pós-vitória (minuta do art. 92, fluxo de pagamento, ARP) **não** alimenta fase
  da 0032 e fica `parada` (ver "Fora de escopo"), salvo decisão do Marcelo.
- **Repositório:** LicitaGym (o Dashboard só muda se a pergunta 4 for "sim")
- **Issue:** nenhuma
- **Área:** migrations | edge-functions (`_shared/agentes`, `_shared/prazos`)
- **Depende do ok do Marcelo:** sim (migration nova, regra de prazo e decisão de produto)

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template. Arquivos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` | fases 2 e 3; "feriados não verificados" nas perguntas em aberto |
| 5 | `specs/0018-tarefas-padrao-por-etapa.md`, `specs/0019-tarefas-equipe-instancia-por-certame.md` | prazo em dias úteis hoje vira `nao_calculado` (0019 CA-4) |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções |
| 8 | `supabase/functions/_shared/agentes/edital.ts` (`limiteImpugnacao`, achado `prazo.impugnacao`) | cálculo atual, sem feriados |
| 8 | `tests/supabase/functions/agentes_edital_test.ts` | teste atual que fixa o limite em 12/10/2026 (feriado) |
| 8 | `supabase/migrations/20260927100000_catalogo_tarefas_licitacao.sql`, `supabase/migrations/20261011110000_tarefas_equipe.sql`, `data/catalogo_tarefas_14133.yaml` | `prazo_unidade = dias_uteis`, `prazo_situacao` |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md` | migration e verificação |
| 10 | `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md` | revisão |
| — | `C:\Users\marce\Downloads\licitagym_sesc_126135_comparacao_agentes.csv` (fora do repo, não versionar) | gates, campos, regras de alerta e simulação. O conteúdo é do PE 138/2026 SR/PF/AL (SEI 08230.003137/2026-61), apesar do nome do arquivo citar o Sesc 126135 |

## Problema (medido em 07/11/2026, MCP somente leitura e leitura do código)

| Fato | Evidência |
|---|---|
| Não existe calendário de feriados no banco | 0 tabelas com "feriado" no nome (`information_schema.tables`) |
| 14 dos 84 modelos de tarefa têm prazo em dias úteis e nunca recebem data | `tarefas_catalogo` (`prazo_unidade = 'dias_uteis'`); `tarefas_equipe`: 20 linhas, 10 `sem_prazo` e 10 `sem_prazo_legal`, nenhuma com prazo calculado |
| O agente de edital calcula o limite de impugnação pulando só sábado e domingo | `limiteImpugnacao` em `_shared/agentes/edital.ts`; o achado grava `feriados_considerados: false` |
| **O teste atual fixa um limite que cai em feriado nacional** | `agentes_edital_test.ts`: abertura 15/10/2026 → limite `2026-10-12` (Nossa Senhora Aparecida). Com o calendário, o limite é 09/10/2026 |
| Abertura 14/10/2026: o código devolve 09/10; com 12/10 como feriado, o correto é 08/10 | cálculo manual conferido em 07/11 |
| O agente de edital não extrai os campos de execução do TR (entrega, garantia/AT, recebimento, liquidação, pagamento, reajuste, fiscalização) | `edital.ts` só tem `exigencia.*`, `especificacao.*`, `portal.*` e `prazo.impugnacao`; `exigencia.prazo_entrega` só detecta a menção, sem extrair o prazo |
| `agente_execucoes` tem 36 linhas | contagem em 07/11. Quantas trazem `prazo.impugnacao` com data em feriado: não medido |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `public.feriados_nacionais` (migration) | `data`, `nome`, `fundamento` (lei), `abrangencia = 'nacional'` | linhas só com fundamento legal; RLS ligada, sem policy; `select` só para `service_role` | — | desenvolvedor (migration); leitura via Edge Function |
| K-2 | `_shared/prazos/dias-uteis.ts`: `somarDiasUteis(data, n, sentido, feriados)` e `contarDiasUteis(inicio, fim, feriados)` | data local (America/Sao_Paulo), n, `antes_de`/`apos`, lista de feriados | data ISO + `feriados_considerados: string[]` + `abrangencia: 'nacional'` | `RangeError` se a lista não cobre o ano da data (nunca conta sem calendário em silêncio) | código interno |
| K-3 | Achado `prazo.impugnacao` do agente de edital | `data_abertura` | `data_limite` com feriados nacionais, `feriados_considerados: true`, aviso "feriados estaduais e municipais não verificados"; `REGRA_VERSAO` sobe | ano sem calendário → `situacao = nao_calculado` e o motivo, nunca data sem feriado | `api-agentes` (admin e operação do tenant) |
| K-4 | Prazo das tarefas em `dias_uteis` com evento datado (`tarefas_equipe`) | modelo com `prazo_unidade = dias_uteis` e data do evento conhecida | `prazo_em` calculado e `prazo_situacao = 'calculado'`; sem data do evento continua `nao_calculado` | — | função SQL ou Edge Function (decidir na implementação; pergunta 3) |
| K-5 | `simularFluxoPagamento` (puro, `_shared/prazos/fluxo-pagamento.ts`) | data de entrega, `recebimento_definitivo_du`, `liquidacao_du`, `pagamento_du`, prorrogação sim/não, feriados | datas de recebimento provisório, definitivo, fim da liquidação, limite de pagamento e total em dias úteis | campo ausente → etapa `null` com motivo, nunca valor padrão | agente de preço (fase 3) |
| K-6 | Achados novos do agente de edital (gates do TR) | chunks do edital/TR | um achado por campo encontrado (`execucao.prazo_entrega`, `execucao.garantia`, `execucao.at_regional`, `execucao.recebimento_definitivo`, `execucao.liquidacao`, `execucao.pagamento`, `execucao.reajuste`, `execucao.fiscalizacao`), com valor, cláusula, trecho e página; campo não achado não vira achado | — | `api-agentes` |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a migration aplicada, **quando** se consulta 2026, **então** existem as datas nacionais com fundamento legal, entre elas 12/10/2026, 25/12/2026 e 01/01/2027, e `anon`/`authenticated` não leem a tabela | SQL `supabase/tests/feriados_nacionais_check.sql` |
| CA-2 | K-2 | **Dado** abertura 14/10/2026 08:30, **quando** se somam 3 dias úteis antes, **então** o resultado é 08/10/2026; com lista de feriados vazia para 2026 o teste espera erro, não 09/10 | Deno `tests/supabase/functions/prazos_dias_uteis_test.ts` |
| CA-3 | K-3 | **Regressão:** **dado** abertura 15/10/2026, **quando** o agente de edital roda, **então** `data_limite = 2026-10-09` (não `2026-10-12`) e `feriados_considerados = true` | Deno `agentes_edital_test.ts` (troca a asserção atual) |
| CA-4 | K-5 | **Dado** entrega 01/12/2026, definitivo 7 du, liquidação 10 du e pagamento 10 du, **quando** se simula, **então** definitivo 10/12/2026, fim da liquidação 24/12/2026, limite de pagamento 11/01/2027 e 27 dias úteis; com prorrogações máximas, 44 dias úteis | Deno `tests/supabase/functions/prazos_fluxo_pagamento_test.ts` |
| CA-5 | K-4 | **Dado** tarefa de impugnação (`14133-F01-T04`) com data de abertura conhecida, **quando** a tarefa é criada, **então** `prazo_situacao = 'calculado'` e `prazo_em` no limite do CA-2; sem data de abertura continua `nao_calculado` (0019 CA-4 muda) | SQL `supabase/tests/tarefas_equipe_check.sql` |
| CA-6 | K-6 | **Dado** o trecho do TR do PE 138/2026 (cláusulas 5.1, 8.3, 8.10 e 8.20), **quando** o agente de edital roda, **então** gera `execucao.prazo_entrega` (30 dias corridos do empenho), `execucao.recebimento_definitivo` (7 du), `execucao.liquidacao` (10 du) e `execucao.pagamento` (10 du), cada um com cláusula e página | Deno `agentes_edital_test.ts` com o texto real |
| CA-7 | K-3, K-6 | **Dado** usuário de outra empresa, **quando** chama `analise_executar` ou `analise_obter` da oportunidade, **então** 403; sem sessão, 401 | Deno `api_agentes_test.ts` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration` | SQL `_check` + skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (RLS/ACL) | `verificar-producao` + `get_advisors` |
| K-2, K-5 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` | — |
| K-3, K-6 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` (`api-agentes`, tenant) | `verificar-producao` |
| K-4 | `/spec` | skill `nova-migration` ou `/implement` | SQL `_check` | `revisor-migration` + `revisor-codigo` | `verificar-producao` |

## Fora de escopo (`parada` até decisão)

- Esqueleto da minuta de contrato/ARP do art. 92 (seção 3 do CSV): não alimenta fase da 0032; é módulo 4 (Proposta)
  ou pós-vitória, ainda sem spec. Texto da lei não transcrito na fonte: revisão jurídica obrigatória.
- Exportação para Excel/Word (coluna `exporta_como`).
- Cadastro "Pessoa" (gestor/fiscal) e LG-T28.
- Gates de decisão Go/No-go automáticos: o agente aponta, a equipe decide (`ESCOPO.md`, "Modelo de IA decidindo sozinho").
- Feriados estaduais e municipais, e pontos facultativos.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_feriados_nacionais.sql` (aditiva, idempotente, `revoke all` + grant mínimo, RLS ligada). Talvez outra para K-4.
- **Tabelas/views/funções tocadas:** `feriados_nacionais` (nova; escrita só por migration, leitura pelas Edge Functions); `tarefas_equipe.prazo_em`/`prazo_situacao` (K-4); `agente_execucoes` (achados novos).
- **ACL/RLS:** tabela nova sem acesso a `anon`/`authenticated`.
- **Backfill/reprocessamento:** a decidir (pergunta 5). Se houver, contagem antes/depois no PR.
- **Edge Functions republicadas no merge:** todas (regra do repositório); muda de fato `api-agentes`.
- **Contrato com o Dashboard:** o achado `prazo.impugnacao` muda `feriados_considerados` para `true` e ganha aviso; achados `execucao.*` são novos. Campos aditivos.
- **Dado oficial x derivado:** feriados vêm de lei federal citada em `fundamento`. Datas-limite e simulação são cálculo do LicitaGym, rotulado como tal. Valores do TR vêm do edital com cláusula e página.

## Decisões do Marcelo

- (nenhuma ainda)

## Perguntas em aberto

1. **Códigos LG-T:** a planilha usa LG-T05 (impugnação) e LG-T30 a LG-T34. O banco usa `14133-Fxx-Tyy` (impugnação =
   `14133-F01-T04`). Os LG-T são modelos novos em `tarefas_catalogo` ou um de-para para os existentes? A planilha (13 abas,
   34 modelos, 14 etapas) não está no repositório nem em Downloads: onde está?
2. **Hora-limite:** o prompt diz "08/10/2026 17:00". De onde vem 17:00: edital, expediente do órgão ou regra fixa? Hoje o
   achado só tem data.
3. **Lista de feriados:** quais entram como nacionais? Proposta: só os de lei federal (01/01, 21/04, 01/05, 07/09, 12/10,
   02/11, 15/11, 20/11, 25/12). Sexta-feira da Paixão e Corpus Christi dependem de lei local, e Carnaval é ponto
   facultativo. Contar ou não?
4. **Tela:** o Dashboard mostra o aviso "feriados locais não verificados" e a simulação do fluxo de pagamento já nesta
   spec, ou só depois?
5. **Achados antigos:** recalcular `prazo.impugnacao` nas 36 execuções existentes ou só nas próximas análises?
6. **Pós-vitória:** minuta do art. 92 e fluxo financeiro entram no `ESCOPO.md` como módulo novo ou ficam no módulo 4
   (Proposta)? Linha proposta: "Execução do contrato: gates do TR pós-vitória, fluxo de recebimento e pagamento,
   minuta de contrato/ARP; spec 0041 (parte parada)".
