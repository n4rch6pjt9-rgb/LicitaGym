# 0047: Levar o preço homologado ao histórico de preço até o dia seguinte à homologação

- **Status:** rascunho
- **Alimenta:** módulo 9 de `docs/produto/ESCOPO.md` (Preços e BI: "preço, marca e fornecedor de compra
  homologada"), que por sua vez alimenta a fase 3 da spec-mãe 0032 (agente de preço). O Marcelo pediu a spec em
  09/11/2026.
- **Repositório:** LicitaGym
- **Issue:** relacionadas: #393 (`coletar (monitorar)` estoura 330 min) e #396 (monitorar não cabe em 330 min; compras
  gravadas sem `last_synced_at` atualizado)
- **Área:** coletor (`services/coletor-externo/`), CI (`.github/workflows/coletor-pncp.yml`), migrations (se o gatilho
  for no banco), observabilidade
- **Depende do ok do Marcelo:** sim (decisão de gatilho, custo de chamadas ao PNCP, possível migration)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md`, `AGENTS.md`, `.claude/rules/regras-negocio.md` | preço só de compra homologada, com fonte e data; não inventar | sim |
| 2 | `docs/produto/ESCOPO.md` | módulo 9 | não: ler |
| 3 | `specs/0046-oportunidades-por-modalidade.md` | decisão de 09/11 que originou esta spec; Histórico 90 dias | não: ler |
| 4 | esta spec, inteira | contrato, CAs | não: ler |
| 5 | `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/pncp.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções | ao abrir a pasta: ler antes |
| 6 | `services/coletor-externo/coletor/pncp.py`: `MODOS`, `recoletar_atualizadas` (~1755), `_processar` (~1364), `_resultados_relevantes` (~1280), `motivo_prioridade` | como a compra em julgamento é revisitada e quando o resultado é gravado | não: ler |
| 7 | `services/coletor-externo/ci/coletor-pncp.sh` e `.github/workflows/coletor-pncp.yml` | etapas leads → monitorar → recoleta, `LIMITE_ETAPA` 330 min, `--limite-recoleta 200` | não: ler |
| 8 | `services/coletor-externo/README.md` | Cloud Run Job e execução local | não: ler |
| 9 | `docs/pncp/schemas-consultas-pncp.md` e `docs/pncp/openapi/pncp-consulta-v3-api-docs-2026-10-09.json` (`/v1/contratacoes/atualizacao`) | parâmetros obrigatórios (`dataInicial`, `dataFinal`, `codigoModalidadeContratacao`, `pagina`), `tamanhoPagina` ≤ 50 | não: ler |
| 10 | migration de `private.acquire_http_slot` e `private.job_queue` (procurar em `supabase/migrations/`) | limite de 1 req/s compartilhado para `pncp.gov.br`; fila de jobs existente | não: ler |
| 11 | `private.saude_operacional_resumo()` (migration) e `.github/workflows/saude.yml` | onde o atraso vira alerta | não: ler |
| 12 | issues #393 e #396 (com os comentários) | medições anteriores e opções já levantadas | não: ler |
| 13 | `.claude/skills/nova-migration/SKILL.md`, `validar-migrations/SKILL.md`, `verificar-producao/SKILL.md`; `.claude/agents/revisor-codigo.md`, `revisor-migration.md`, `revisor-seguranca.md` | procedimento de cada etapa | quando invocados |

## Problema

Decisão do Marcelo (09/11/2026): o preço homologado entra no histórico de preço **no mesmo dia ou no dia seguinte
(D+1) da homologação**. Medido em 09/11/2026 (MCP somente leitura; `gh run`):

**Atraso hoje.** Compras com `data_homologacao` nos últimos 90 dias e com resultado em `licitacao_resultados`, por
dia do primeiro resultado gravado (horário de Brasília) contra a `data_homologacao`:

| fonte | já estava no banco antes da homologação? | compras | até D+1 | mediana (dias) | p90 (dias) |
|---|---|---|---|---|---|
| pncp | sim | 312 | 200 (64%) | 1,2 | 8,4 |
| pncp | não (achada depois de homologada) | 386 | 19 (5%) | 22,1 | 50,1 |
| Sistema S (fiesc, sescba, sestsenat) | — | 4 | 1 | — | — |

Mais 6 compras homologadas no período não têm resultado nenhum. "Já estava no banco" = `created_at` da compra até a
`data_homologacao`.

**Coletor diário falhando.** O `coletor-pncp.yml` agenda 06:00 (Brasília), mas os runs começam por volta de
12:30–16:00 (atraso do agendador do GitHub; medido em `createdAt`). Nos 8 runs agendados de 31/10 a 08/11: 7
`failure` e 1 `cancelled`. Nos três inspecionados (01/11, 06/11, 07/11), `coletar (leads)` e `coletar (monitorar)`
pararam no limite de 330 min; `recoleta` passou em 01/11 e falhou em 06/11 e 07/11. O run de 08/11 terminou com
leads e monitorar em falha e recoleta sem conclusão registrada. Issues #393 e #396 já descreviam o estouro do
monitorar em outubro.

**Por que a compra conhecida demora.** A recoleta faz uma consulta de detalhe por compra em `leads`/`monitorar` no
escopo e, na CI, para em `--limite-recoleta 200`; com ~2.000 compras nesse recorte e o limite de 1 req/s do
`acquire_http_slot` compartilhado com os outros coletores, uma volta completa leva vários dias (cálculo a partir do
código; duração real por compra **não medida**).

**Por que a compra desconhecida demora.** A etapa `monitorar` busca `status=em_julgamento` por termo; compra que o
coletor nunca viu só entra quando a busca a acha, e a etapa não termina há dias.

`private.coleta_externa_run` não tem nenhuma linha nos últimos 14 dias (o coletor PNCP não registra lá; não medido
onde registra).

## Onde pôr o gatilho (decisão pedida: cron ou tempo real)

O PNCP não avisa ninguém: não há webhook nem notificação nos documentos em `docs/pncp/` e `docs/compras-gov/`. Então
**"tempo real" sobre o PNCP não existe**: alguém precisa perguntar. O que pode ser em tempo real é o lado de dentro,
depois que a mudança é vista.

| Opção | Como funciona | A favor | Contra |
|---|---|---|---|
| A. Cron mais frequente da recoleta atual | mesma recoleta (detalhe por compra), a cada poucas horas | nenhum código novo | custo cresce com o número de compras (≈2.000 detalhes por volta, 1 req/s compartilhado); não acha compra desconhecida |
| B. Supabase Realtime / gatilho no banco | reage a `insert`/`update` em tabela | instantâneo dentro do banco | não enxerga o PNCP; sozinho não resolve nada |
| **C. Híbrido (proposta)** | (1) **cron de varredura por data de atualização**: a cada N horas, `GET /v1/contratacoes/atualizacao` com a janela desde a última varredura, uma chamada por modalidade e página (≤ 50 por página), e cruza com as compras do banco em `monitorar`; (2) **fila por evento**: compra conhecida que mudou, ou compra nova no escopo já encerrada, entra em `private.job_queue` como "buscar resultados"; (3) um consumidor da fila busca itens/resultados só dessas | custo proporcional ao que mudou, não ao total; acha compra desconhecida pela data de atualização; reaproveita a fila e o lease HTTP que existem | código novo no coletor; depende de o `/atualizacao` refletir a homologação (conferir no `/implement`) |

**Decidido: opção C (híbrido)**, com varredura a cada 3 horas entre 06:00 e 23:00 de Brasília nos dias úteis e uma
vez por dia no sábado e no domingo (ver "Fim de semana"). A janela de cada varredura começa onde a anterior terminou
com sucesso, então uma execução que falha não perde nada: a seguinte cobre o mesmo intervalo.

## Onde roda (critério do Marcelo: menor custo)

Medido em 09/11/2026:
- **pg_cron (Supabase)** já roda 20 jobs; 3 deles conferidos nos últimos 7 dias começaram no segundo agendado (7 de 7,
  sem atraso). Chama Edge Function por `private.cron_chamar_edge` (timeout padrão 150 s), com o padrão "fila +
  continuação" já usado em `licitagym-sync-pncp-pca-fila` e `-fila-continuacao` (a cada 10 min das 06h às 07h).
  Custo marginal: invocações e tempo de Edge Function dentro da cota do plano do Supabase (uso da cota **não medido**).
- **GitHub Actions:** o repositório é público, então os minutos do runner padrão não são cobrados. Mas o agendado
  das 06:00 começa entre 12:30 e 16:00 (atraso de 6 a 10 h, medido nos runs de 31/10 a 08/11), o que sozinho já
  quebra o D+1 de uma homologação da tarde.
- **Cloud Run Job + Cloud Scheduler:** já existe o Job `coletor-precos`; cobra por uso de vCPU/memória e por job do
  Scheduler acima da cota gratuita (valores **não medidos**; nenhum preço inventado aqui).

**Proposta (menor custo com horário garantido):**
1. **Varredura (K-1) e enfileiramento (K-2): Edge Function chamada por pg_cron.** São poucas chamadas HTTP por
   execução (uma por modalidade e página do `/atualizacao`), cabem em 150 s com continuação, e não custam nada além
   da cota. Código novo em TypeScript, porque hoje não existe varredura por `/atualizacao` em lugar nenhum.
2. **Consumidor (K-3): o coletor Python que já existe (`_processar`)**, para não criar uma segunda implementação de
   itens/resultados (regra do `AGENTS.md`). Roda no GitHub Actions (grátis), disparado por `workflow_dispatch` pela
   própria Edge Function quando a fila tem job (o disparo manual não sofre o atraso do agendador; **não medido** o
   tempo até começar), com um agendamento de reserva a cada 3 h.
3. Se o disparo do GitHub não começar em minutos (medição do `/implement`), o consumidor vai para o Cloud Run Job,
   aí com custo a medir antes.

## Fim de semana

Medido em 09/11/2026 nas compras PNCP do banco, últimos 365 dias, por dia da semana (horário de Brasília):

| evento | seg | ter | qua | qui | sex | sáb | dom | sáb+dom |
|---|---|---|---|---|---|---|---|---|
| publicação (`data_publicacao`) | 553 | 718 | 794 | 842 | 681 | 11 | 11 | 22 de 3.610 (0,6%) |
| homologação (`data_homologacao`) | 198 | 223 | 246 | 260 | 241 | 3 | 1 | 4 de 1.172 (0,3%) |
| última atualização no PNCP (`pncp_data_atualizacao`) | 480 | 635 | 715 | 756 | 602 | 9 | 14 | 23 de 3.211 (0,7%) |

Há publicação e homologação no fim de semana, poucas. Por isso: **uma varredura por dia no sábado e no domingo**
(não a cada 3 h). Como a janela é contínua, nada se perde; o que cair no sábado fica no histórico de preço no
domingo (D+1). Limite da medição: só compras que estão no banco, e `pncp_data_atualizacao` guarda só a última
atualização.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Varredura por atualização (`coletor.pncp --varrer-atualizacoes --desde <ts>`, nome final no `/implement`) | janela `[desde, agora]`; modalidades do escopo; termos não entram | lista de compras alteradas na janela (id PNCP, `dataAtualizacao`); grava o fim da janela só se todas as páginas responderam | página com erro: a janela não avança (próxima execução repete); nunca vira "nada mudou" | Edge Function chamada por pg_cron (`requireCronAuth`) |
| K-2 | Enfileirar "buscar resultados" | compra alterada que está no banco em `monitorar`/`leads`, ou compra nova no escopo com sinal de encerramento | uma linha em `private.job_queue` por compra (idempotente por compra + `dataAtualizacao`) | — | K-1 |
| K-3 | Consumidor da fila | job "buscar resultados" | `_processar` da compra (itens + resultados + detalhe); resultado gravado em `licitacao_resultados`; prioridade e fase recalculadas como hoje | API fora: job volta para a fila com backoff (`Retry-After`), compra não é marcada "sem resultado" | job agendado |
| K-4 | Saúde: `pncp_resultado_atraso` em `private.saude_operacional_resumo()` | compras com `data_homologacao` ≤ D-2 e sem resultado, e janela de K-1 parada há mais de 6 h | contagem + estado `ok`/`alerta`; entra em `SAUDE_VERIFICACOES_ESPERADAS` do `saude.yml` | — | `api-saude`, cron de saúde |
| K-5 | Agendamento | — | execuções de K-1 (pg_cron: a cada 3 h das 06h às 23h nos dias úteis, uma vez no sábado e no domingo) e K-3 (disparo pela fila + reserva a cada 3 h), com registro de execução (início, fim, páginas, compras, erros) | execução que estoura o tempo termina como falha visível | pg_cron + GitHub Actions |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** respostas gravadas do `/v1/contratacoes/atualizacao` com 2 páginas, **quando** a varredura roda, **então** pede `tamanhoPagina` ≤ 50, passa `dataInicial`, `dataFinal`, `codigoModalidadeContratacao` e `pagina`, lê as duas páginas e devolve as compras alteradas. | pytest `services/coletor-externo/tests/test_varrer_atualizacoes.py` (sem API real) |
| CA-2 | K-1 | **Dado** a segunda página com HTTP 500, **quando** a varredura roda, **então** o fim da janela não é gravado e a execução termina com erro registrado (falha de API não é "nada mudou"). | pytest `.../test_varrer_atualizacoes.py` |
| CA-3 | K-2 | **Dado** a mesma compra alterada vista em duas varreduras com a mesma `dataAtualizacao`, **quando** enfileira, **então** existe um só job para ela. | pytest `.../test_varrer_atualizacoes.py` + SQL `supabase/tests/pncp_resultado_fila_check.sql` (se houver migration) |
| CA-4 | K-3 | **Dado** job de compra em `monitorar` cujo detalhe e resultados (gravados em fixture) mostram homologação, **quando** o consumidor roda, **então** `licitacao_resultados` recebe as linhas, a prioridade vai para `historico` e o job sai da fila. Regressão do atraso medido. | pytest `services/coletor-externo/tests/test_resultado_d1.py` |
| CA-5 | K-3 | **Dado** a API de resultados respondendo 429 com `Retry-After`, **quando** o consumidor roda, **então** o job volta para a fila com espera ≥ `Retry-After`, nada é gravado como "sem resultado" e `DELAY_SEGUNDOS` ≥ 1 é respeitado. | pytest `.../test_resultado_d1.py` |
| CA-6 | K-4 | **Dado** uma compra homologada em D-3 sem resultado, **quando** `saude_operacional_resumo()` roda, **então** `pncp_resultado_atraso` vem em `alerta` com contagem 1; e chamada da função por `anon`/`authenticated` é negada. | SQL `supabase/tests/saude_resultado_atraso_check.sql` |
| CA-7 | K-1..K-5 | **Dado** 7 dias corridos depois do deploy, **quando** se reconcilia cada janela varrida com o banco, **então** toda compra no escopo que o `/atualizacao` mostrou com homologação na janela tem resultado gravado até o fim do dia seguinte (D+1); cada exceção aparece listada com o motivo (API fora, compra fora do escopo, PNCP sem resultado publicado), nunca como número médio. | consulta da skill `verificar-producao` + relatório de reconciliação no PR de fechamento |

**Meta (decisão do Marcelo, 09/11/2026):** não há percentual. A coleta é determinística por data: toda compra que o
PNCP mostra como publicada ou atualizada numa janela é coletada nessa janela. Nada justifica um edital lançado hoje
ficar fora do cron; se ficar, é defeito, e o caso aparece nominalmente na reconciliação.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-3 | `/spec` | `/implement` (TDD) | pytest do coletor | `revisor-codigo` + `revisor-seguranca` (`service_role` no job) | `verificar-producao` |
| K-4 (e fila, se mudar schema) | `/spec` | skill `nova-migration` | skill `validar-migrations` + `_check.sql` | `revisor-migration` + `revisor-seguranca` (ACL de função `private`) | `verificar-producao` + `get_advisors` |
| K-5 | `/spec` | `/implement` | teste do script de CI (padrão `tests/test_ci_coletor_pncp.py`) | `revisor-codigo` | `verificar-producao` (CA-7) |

## Fora de escopo

- Consertar o estouro de tempo das etapas `leads` e `monitorar` do coletor diário (#393, #396). Esta spec tira dele a
  responsabilidade de achar homologação; o resto do conserto segue nas issues.
- Fontes do Sistema S (4 compras no período): coletor próprio, outra cadência.
- Tela de histórico de preço e BI: o dado chega mais cedo; a apresentação não muda.
- Baixar edital ou anexos.

## Impacto em dados

- **Migration:** sim: `cron.schedule` dos jobs novos (padrão `20260930180000_cron_sync_jobs.sql`); e, se K-4 (saúde) ou o tipo de job da fila exigirem: `supabase/migrations/<timestamp>_pncp_resultado_d1.sql`,
  aditiva e idempotente. Não medido se `private.job_queue` já aceita o tipo novo sem migration.
- **Tabelas/views/funções tocadas:** `licitacao_resultados`, `licitacao_itens`, `licitacoes_externas` (escritas pelo
  coletor, como hoje); `private.job_queue`; `private.saude_operacional_resumo()`; registro da varredura (onde: no
  `/implement`).
- **ACL/RLS:** nenhuma mudança esperada; função de saúde segue só para `service_role`.
- **Backfill/reprocessamento:** sim, uma vez: as 6 homologadas sem resultado e as que estão em `monitorar` com
  homologação já publicada; contagem antes/depois no PR.
- **Edge Functions republicadas no merge:** todas (merge na `main`); função nova de varredura (nome no `/implement`).
- **Segredo novo:** token do GitHub com permissão só de `actions:write` neste repositório, guardado como segredo da
  Edge Function (nunca no código).
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:** resultado e data de homologação vêm do PNCP sem alteração; nada é estimado.
- **Custo de chamadas ao PNCP:** proporcional ao número de compras alteradas por janela (não medido; o `/implement`
  mede uma semana em dry-run antes de ligar o consumidor).

## Decisões do Marcelo

- 09/11/2026: preço homologado no histórico até D+1 da homologação; spec própria.
- 09/11/2026: gatilho **híbrido** (opção C).
- 09/11/2026: infraestrutura **onde o custo for menor** (proposta na seção "Onde roda").
- 09/11/2026: **sem meta percentual**: a coleta é determinística por data; toda compra da janela é coletada.
- 09/11/2026: fim de semana decidido pela medição (seção "Fim de semana").

## Perguntas em aberto

1. **Proposta de infraestrutura:** varredura em Edge Function por pg_cron + consumidor Python no GitHub Actions
   disparado por `workflow_dispatch` (Cloud Run só se o disparo demorar) atende ao "menor custo"? O token do GitHub
   para o disparo fica como segredo da Edge Function: ok?
