# 0058: Reabrir plano esgotado quando a impressão mostrar mudança de quantidade ou valor

- **Status:** parada (11/11/2026: a premissa não está medida; ver "Por que está parada" e "Como retomar")
- **Alimenta:** etapa 1 (coleta) de `docs/produto/TRILHAS-E-INFORME.md`; módulo 1 de `docs/produto/ESCOPO.md` (Radar de
  oportunidades). Follow-up da `specs/0056-pca-em-camadas.md` (PR #523)
- **Repositório:** LicitaGym
- **Issue:** nenhuma. Os outros dois follow-ups da 0056 viraram as issues #525 (hash V3 na reprojeção) e #526
  (`saiu_escopo` na rota `ausente`)
- **Área:** pncp (`_shared/pncp/pca-impressao.ts`) | migrations (`private.pca_fila_enfileirar`)
- **Depende do ok do Marcelo:** sim (migration que troca uma função da fila em produção)

## Por que está parada

Medido em 11/11/2026 (produção, só leitura):

- **A premissa não está medida.** A spec só vale se a quantidade ou o valor de um plano mudarem na fonte **sem** a data
  mudar. O histórico de `pca_alteracoes` dos planos não guarda quantidade nem valor (só `data_atualizacao_origem`,
  título, descrição, status e metadado de sync). Esse dado só existe a partir da impressão (`private.pca_impressao_plano`),
  que roda pela primeira vez em 12/11/2026.
- **Não teria evitado o PR #524.** Os 200 planos reabertos à mão não tiveram mudança na fonte: a causa (vínculo,
  classe, HTTP 503) foi resolvida no código pela 0056. Reabertura disparada pela fonte nunca pega esse caso; ele
  continua sendo resolvido por reabertura pontual (migration ou `recuperar_esgotados`).
- **Frequência de mudança da fonte (para não inventar limite).** Mudanças de `data_atualizacao_origem` em planos, de
  01/10 a 06/11/2026 (37 dias, 26 com mudança): 654 mudanças em 422 dos 949 planos de 2026. Por plano: 268 mudaram 1
  vez, 122 mudaram 2 vezes, 32 mudaram de 3 a 8 vezes. Pior caso: 8 em 37 dias (cerca de 1 a cada 4,6 dias). É um piso:
  o sync não leu todos os dias, então duas mudanças entre leituras contam como uma. Com isso, não há base para teto de
  reaberturas (P-3 respondida: sem limite).

## Como retomar

Depois de 1 a 2 semanas de impressão diária (a partir de 12/11/2026), medir em `private.pca_impressao_plano` e na fila:

1. quantas vezes um plano teve `quantidade` ou `valor_total` diferente da leitura anterior com a mesma
   `data_atualizacao` (a impressão sobrescreve a linha a cada leitura; se não der para medir com o que existe, a
   primeira entrega é só a medição);
2. quantas dessas linhas estavam em `erro` esgotado na fila naquele momento.

Se (1) ou (2) for zero ou quase zero, encerrar a spec: a regra atual (reabre só com data mais nova) basta. Se não,
voltar a `rascunho` com os números e seguir o contrato abaixo.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega; o que não fazer | sim |
| 2 | `AGENTS.md` | zero alucinação; dado oficial não sobrescrito em silêncio | sim |
| 3 | `.claude/rules/regras-negocio.md` | regras de produto | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 1 | não: ler |
| 5 | `specs/0056-pca-em-camadas.md` (com a seção "Implementação") | o desenho em camadas e a impressão | não: ler |
| 6 | esta spec, inteira | premissa, contrato, CAs | não: ler |
| 7 | `.claude/rules/pncp.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções das áreas tocadas | ao abrir a pasta |
| 8 | `supabase/functions/_shared/pncp/pca-impressao.ts` (`planoMudou`, montagem do item da fila) | o que a impressão enfileira e com qual `data_atualizacao_fonte` | não: ler |
| 9 | `supabase/functions/_shared/pncp/pca-fila.ts` (`enfileirar`, tipo `ItemFila`) | o cliente da RPC | não: ler |
| 10 | `supabase/migrations/20261011100000_pca_plano_fila.sql` (`pca_fila_enfileirar`, `pca_fila_reservar`), `20261031223751_pca_fila_recuperacao_historico.sql`, `20261111220000_pca_fila_reabrir_esgotados_0056.sql` | a regra atual de reabertura e a reabertura manual do #524 | não: ler |
| 11 | `tests/supabase/functions/sync_pncp_pca_impressao_test.ts`, `supabase/tests/pca_plano_fila_check.sql` | onde entram os testes | não: ler |
| 12 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa | quando invocados |

## Problema

`private.pca_fila_enfileirar` só volta uma linha `erro` para `pendente` (com `tentativas = 0`) quando a
`data_atualizacao_fonte` recebida é maior que a gravada. A impressão (0056) enfileira o plano também quando
`quantidade` ou `valor_total` mudam com a mesma data (`planoMudou`). Se isso acontecer com uma linha esgotada
(`tentativas >= 5`), a mudança fica sem carga até a próxima data nova da fonte. Frequência desse caso: não medido.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | item da fila montado pela impressão (`pca-impressao.ts`) | `planoMudou` verdadeiro por quantidade ou valor | o item leva um campo novo (`mudou_impressao: true`; nome final na implementação) | — | `sync-pncp-pca` (service_role) |
| K-2 | `private.pca_fila_enfileirar(p_itens jsonb)` (migration nova, `create or replace`) | itens com `mudou_impressao` | linha `erro` **esgotada** volta para `pendente` com `tentativas = 0` e `erro` com o rastro anterior também quando `mudou_impressao` for verdadeiro; linha `erro` com menos de 5 tentativas não muda; linha `processando` recente continua intocada | os de hoje | `sync-pncp-pca` (service_role); `anon`/`authenticated` sem execução |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** um plano com impressão anterior e a mesma data, **quando** a impressão lê quantidade ou valor diferente, **então** o item enfileirado leva `mudou_impressao = true`; sem mudança de quantidade ou valor, o campo é falso ou ausente. | Deno `tests/supabase/functions/sync_pncp_pca_impressao_test.ts` |
| CA-2 | K-2 | **Dado** uma linha `erro` com `tentativas = 5` e a mesma `data_atualizacao_fonte`, **quando** chega um item com `mudou_impressao = true`, **então** a linha fica `pendente`, `tentativas = 0`, e `erro` guarda o rastro do erro anterior. | SQL `supabase/tests/pca_fila_reabrir_por_impressao_check.sql` |
| CA-3 | K-2 | **Dado** uma linha `erro` com `tentativas = 3`, **quando** chega um item com `mudou_impressao = true` e a mesma data, **então** status e tentativas não mudam. | SQL `supabase/tests/pca_fila_reabrir_por_impressao_check.sql` |
| CA-4 | K-2 | **Dado** uma linha `erro` esgotada, **quando** chega um item sem `mudou_impressao` e com a mesma data, **então** a linha continua `erro` com as tentativas que tinha (regressão da regra atual). | SQL `supabase/tests/pca_fila_reabrir_por_impressao_check.sql` |
| CA-5 | K-2 | **Dado** uma linha `processando` atualizada há menos de 15 min, **quando** chega um item com `mudou_impressao = true`, **então** status, tentativas, `plano` e `data_atualizacao_fonte` não mudam (regressão). | SQL `supabase/tests/pca_fila_reabrir_por_impressao_check.sql` |
| CA-6 | K-2 | **Dado** os papéis `anon` e `authenticated`, **quando** tentam executar `private.pca_fila_enfileirar`, **então** recebem erro de permissão; `service_role` executa. | SQL `supabase/tests/pca_fila_reabrir_por_impressao_check.sql` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | `/implement` (TDD) | `deno test tests/supabase` | `revisor-codigo` | skill `verificar-producao` |
| K-2 | `/spec` | skill `nova-migration` + `/implement` | skill `validar-migrations` | `revisor-codigo` + `revisor-migration` + `revisor-seguranca` (função `private` executada por `service_role`) | skill `verificar-producao` + `get_advisors` (security) |

## Fora de escopo

- Reabrir linha em erro cuja causa foi resolvida no código sem mudança na fonte (caso do #524): continua por migration
  ou `recuperar_esgotados`.
- Teto de reaberturas por plano ou por dia (P-3: sem limite, pela medição de 11/11/2026).
- Hash V3 na reprojeção (issue #525) e `saiu_escopo` na rota `ausente` (issue #526).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_pca_fila_reabrir_por_impressao.sql`: `create or replace` de
  `private.pca_fila_enfileirar` (idempotente; sem coluna nova)
- **Tabelas/views/funções tocadas:** `private.pca_fila_enfileirar` e `private.pca_plano_fila` (só `service_role`)
- **ACL/RLS:** nenhuma mudança; a função mantém `revoke` de `public`, `anon`, `authenticated` e `grant` a `service_role`
- **Backfill/reprocessamento:** não
- **Edge Functions republicadas no merge:** todas (por causa de `_shared`); muda `sync-pncp-pca`
- **Contrato com o Dashboard:** inalterado
- **Dado oficial x derivado:** quantidade, valor e data vêm da impressão do PNCP; o sinal de mudança e o rastro são
  derivados; nenhum valor inventado

## Decisões do Marcelo

- 11/11/2026: reabrir os 200 planos esgotados por migration (PR #524), não pela Edge Function.
- 11/11/2026 (P-1): o sinal de mudança vai como campo no item da fila, não em colunas novas.
- 11/11/2026 (P-2): reabrir só linha esgotada (`tentativas >= 5`).
- 11/11/2026 (P-3): não criar regra antes de medir; a medição de frequência da fonte não justifica teto.
- 11/11/2026: hash V3 e `saiu_escopo` saem da spec e viram as issues #525 e #526; a spec fica parada até medir a
  premissa.

## Perguntas em aberto

- Nenhuma de produto. A retomada depende da medição descrita em "Como retomar".
