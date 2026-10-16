# 0029: Separar a coleta do dia (minutos, várias vezes ao dia) da coleta de acervo (horas, sem pressa)

- **Status:** rascunho
- **Issue:** #357 (oportunidades sem coleta recorrente); relacionadas #372, #371, #187, #319
- **Área:** coletor + edge-functions + migrations + workflows
- **Depende do ok do Marcelo:** sim (muda de onde vêm as oportunidades em produção, cron novo e desligamento de etapas)

## Problema

Para quem começa a usar o LicitaGym hoje, o que vale é saber, **no mesmo dia**:
1. o que dá para disputar agora (recebendo proposta);
2. o que mudou nas compras que acompanha (situação, resultado);
3. por quanto vender (homologadas);
4. o edital da compra que vai disputar.

Os itens 1 e 2 dependem de **poucas centenas de compras por dia**. Hoje eles chegam pela mesma coleta que faz
trabalho de horas, e por isso chegam atrasados ou não chegam.

**Medição** (somente leitura, 16/10/2026):
- **Volume do dia:** compras PNCP novas gravadas por dia: 97 (16/10), 474 (15/10), 125 (14/10), das quais
  91, 426 e 115 em `leads`. Ativas hoje: cerca de 800 em `leads` e 450 em `monitorar`.
- **Duração da coleta atual** (`.github/workflows/coletor-pncp.yml`): a etapa `leads` busca ~160 termos e levou
  **3h43** em 15/10; com `monitorar` e `recoleta` em sequência, o run passa de 5 h. As execuções de 15/10 e 16/10 foram
  canceladas; a última concluída foi a de 14/10 (32 min, modo reduzido).
- **Efeito no usuário:** caso 3035 (spec 0026a): compra homologada em 16/10 às 15:55 continuava como lead, com a
  última coleta em 15/10.
- **Sistema S:** o coletor do SEST SENAT (`coletor.main`) varre IDs de 1 a 5.000, um por um. O mesmo portal é
  Paradigma, e o `coletor.paradigma` lista processos pelo mural (`PesquisarProcessos`), com a situação na resposta.
- **Documentos:** 5.283 nunca baixados (#372); baixar e fazer OCR de tudo é trabalho de acervo.
- **Peças que já existem:** `_shared/pncp/consulta-client.ts` consulta `/contratacoes/publicacao` e
  `/contratacoes/atualizacao` por data, e `_shared/pncp/pagination-budget.ts` divide o trabalho em fatias com
  continuação (padrão do PCA). A função `sync-pncp-contratacoes-editais` usa as duas, mas grava o espelho nacional em
  `contratacoes_editais`, desligado pelo portão `PNCP_NATIONAL_SYNC_ENABLED`.

## Desenho

| Trilha | O que faz | Duração alvo | Onde roda |
|---|---|---|---|
| **Do dia** | publicações e atualizações do PNCP desde o último ponto, filtradas pelo escopo; reconsulta das compras ativas; Sistema S aberto pelo mural | minutos por execução, várias vezes ao dia | Edge Function + `pg_cron`, com fatias e continuação |
| **Acervo** | histórico de homologadas, recoleta ampla por termo, documentos e OCR, varredura do SEST SENAT por ID | horas, sem prazo | GitHub Actions (coletor Python), fila própria |

A trilha do dia não espera o acervo; o acervo nunca é pré-requisito para o usuário ver uma oportunidade nova.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Medição antes de construir:** **dado** um dia útil, **quando** se consulta `/contratacoes/publicacao` e `/contratacoes/atualizacao` para todas as modalidades, **então** o PR registra páginas, registros, tempo e respostas 429 por modalidade, e quantos registros passam no filtro de escopo. Esse número decide a frequência (pergunta 1). | relatório no PR (script de medição sem gravar) |
| CA-2 | **Dado** o cursor da última execução concluída (`private.coleta_cursor`, por fonte), **quando** a trilha do dia roda, **então** consulta publicações e atualizações do intervalo `[cursor − 1 h, agora]`, aplica o mesmo filtro de escopo do coletor (termos e regras de `escopo.py`, portadas e testadas com as mesmas fixtures) e grava em `licitacoes_externas` com `ingestao_origem = cron`; o cursor só avança se todas as fatias terminarem. Erro de página deixa a execução parcial e não avança o cursor. | Deno `tests/supabase/functions/sync_pncp_do_dia_test.ts` + pytest das fixtures de escopo compartilhadas |
| CA-3 | **Dado** uma compra em `leads` ou `monitorar`, ou no pipeline de alguma empresa, **quando** a trilha do dia roda, **então** as que tiveram atualização no PNCP no intervalo, ou cujo fim do recebimento passou nas últimas 48 h, são reconsultadas no detalhe; com `existeResultado` ou situação terminal, vão para `historico` na mesma execução. Fixture: caso 3035. | Deno `tests/supabase/functions/sync_pncp_do_dia_test.ts` |
| CA-4 | **Dado** uma execução que não cabe no tempo da Edge Function, **quando** o orçamento acaba, **então** ela termina como `retomada` e a continuação seguinte pega as fatias pendentes (padrão do PCA), sem duplicar linha e sem perder fatia. | Deno, reaproveitando os testes de `pagination-budget.ts` |
| CA-5 | **Dado** o Sistema S, **quando** a trilha do dia roda, **então** consulta pelo mural (`PesquisarProcessos`) só os processos abertos das fontes ativas, aplica o escopo e grava; a varredura por ID do SEST SENAT passa para o acervo. Fontes com WAF (FIEMG) continuam de fora. | Deno `tests/supabase/functions/sync_sistema_s_do_dia_test.ts` (fixtures do mural, sem rede) |
| CA-6 | **Dado** a trilha de acervo, **quando** roda no GitHub Actions, **então** usa grupo de concorrência próprio (não cancela nem espera a do dia), cobre histórico, recoleta ampla, documentos e OCR, e grava o progresso em `coleta_externa_run`; sua demora não muda a idade do dado do dia. | `tests/test_ci_coletor_pncp.py` |
| CA-7 | **Dado** uma compra que entra no pipeline, **quando** a etapa é gravada, **então** os documentos dessa compra entram na fila de download com prioridade sobre o acervo. | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-8 | **Dado** a saúde, **quando** `saude_operacional_resumo()` roda, **então** mostra separadas a idade do dado do dia (horas desde a última execução concluída, alerta acima de 6 h) e a do acervo (dias). | SQL `supabase/tests/saude_coleta_dia_check.sql` |
| CA-9 | **Transição:** **dado** a trilha do dia ligada, **quando** passam 7 dias, **então** o PR de desligamento das etapas `leads` e `monitorar` do coletor diário traz a comparação: toda compra que o coletor achou e que estava no escopo também foi achada pela trilha do dia, ou a diferença explicada caso a caso. Antes disso, as duas convivem (upsert pela mesma chave). | relatório no PR de desligamento |

## Fora de escopo

- Onde guardar documentos (Supabase Storage × GCS × VM): #371.
- Mudar regras de escopo, prioridade ou classificação.
- Espelho nacional em `contratacoes_editais`: continua desligado.
- Portal de Compras Públicas e outros portais: seguem no `sync-portal-compras`.

## Impacto em dados

- **Migrations:** sim, aditivas e idempotentes, cada uma com `_check.sql`: `private.coleta_cursor` (cursor por
  fonte), os jobs do `pg_cron` da trilha do dia e o item da saúde. **Pede branch Supabase** (pg_cron).
- **Tabelas tocadas:** `licitacoes_externas` (mesma chave de upsert do coletor; duas trilhas convivem sem duplicar),
  `private.coleta_cursor`, `private.pncp_sync_run`, `private.coleta_externa_run`.
- **Edge Functions:** novas `sync-pncp-do-dia` e `sync-sistema-s-do-dia` (nomes a confirmar); todas republicadas no
  merge.
- **ACL/RLS:** tabelas novas só `service_role`.
- **Workflows:** `coletor-pncp.yml` vira a trilha de acervo depois do CA-9.
- **Contrato com o Dashboard:** não muda (a tela de Sincronizações já lista syncs da `api-syncs`).
- **Dado oficial x derivado:** os dados do PNCP e do Paradigma entram como vieram; cursor e reconsulta são controle.

## Perguntas em aberto

1. **Frequência da trilha do dia:** a cada 1 h, 2 h ou 4 h, das 06:00 às 22:00? O CA-1 mede o custo de cada uma.
2. **Escopo em TypeScript:** portar as regras de `escopo.py` (termos e exclusões) para a Edge Function, com fixtures
   compartilhadas, ou a Edge Function grava cru numa fila e o Python classifica? A proposta é portar, para o lead
   aparecer na mesma execução.
3. **Sistema S do dia:** quais fontes entram já (SEST SENAT e FIESC validadas em 24/09; Sesc pelo mural autorizado)?
4. **Spec 0028:** com esta spec, o Sistema S do dia sai do Cloud Run. A 0028 fica só com o registro de execução
   (`coleta_externa_run`) e o acervo do Sistema S no GitHub Actions, ou é absorvida por esta?
