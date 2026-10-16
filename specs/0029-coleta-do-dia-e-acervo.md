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
| CA-1 | **Medição antes de construir:** **dado** um dia útil, **quando** se consulta `/contratacoes/publicacao` e `/contratacoes/atualizacao` para todas as modalidades, **então** o PR registra páginas, registros, tempo e respostas 429 por modalidade, e quantos registros passam no filtro de escopo. Esse número decide a frequência (pergunta 1). | relatório no PR (script de medição sem gravar); se a medição pedir outra frequência, o PR propõe o ajuste |
| CA-10 | **Escopo único, duas linguagens:** **dado** as regras de `services/coletor-externo/coletor/escopo.py` (992 linhas: `TERMOS_POR_PDM`, `TERMOS_GENERICOS`, `excluir_compra`, `servico_sem_material`, `academia_ar_livre`, `brinquedo_infantil`, `borracha` e afins), **quando** a trilha do dia classifica uma compra, **então** a decisão é a mesma do Python: (i) os **dados** das regras (termos, exclusões, padrões) saem do código para `services/coletor-externo/coletor/data/escopo-regras.json`, lido pelo Python e pela Edge Function (cópia gerada em `supabase/functions/_shared/escopo/`, com teste que falha se divergir do original); (ii) a **lógica** é portada para `supabase/functions/_shared/escopo/escopo.ts`; (iii) um único arquivo de casos, `services/coletor-externo/tests/fixtures/escopo-casos.json` (texto do objeto → decisão esperada e motivo), reúne os casos dos `test_escopo_*.py` atuais e roda nos dois lados. Caso que diverge reprova a CI. Mudança de regra passa a ser no JSON, com os dois testes. | pytest `services/coletor-externo/tests/test_escopo_casos_compartilhados.py` + Deno `tests/supabase/functions/escopo_casos_compartilhados_test.ts` |
| CA-1b | **Dado** a frequência decidida (a cada 2 h, das 06:00 às 22:00 de Brasília: 9 execuções por dia), **quando** a migration aplica, **então** o `pg_cron` agenda a trilha do dia nesses horários (em UTC no `cron.schedule`, com o horário de Brasília no comentário) e a primeira execução das 06:00 cobre a noite inteira desde o último cursor. | SQL `supabase/tests/coleta_dia_cron_check.sql` |
| CA-2 | **Dado** o cursor da última execução concluída (`private.coleta_cursor`, por fonte), **quando** a trilha do dia roda, **então** consulta publicações e atualizações **por data**: o PNCP só aceita `dataInicial`/`dataFinal` em `YYYYMMDD` (`formatPncpDate`), então a consulta pede os dias de calendário de Brasília que contêm `[cursor − 1 h, agora]` (normalmente ontem e hoje; o `formatPncpDate` atual usa a data UTC e passa a usar a de Brasília, senão as consultas entre 21:00 e 23:59 pulam o dia) e filtra localmente pelo instante do registro (`dataAtualizacao`/`dataPublicacaoPncp`, sem fuso = Brasília, regra da #332); o cursor guarda o maior instante gravado, e a sobreposição de 1 h com o upsert pela mesma chave cobre empate na borda sem duplicar; aplica o mesmo filtro de escopo do coletor (termos e regras de `escopo.py`, portadas e testadas com as mesmas fixtures) e grava em `licitacoes_externas` com `ingestao_origem = cron`; o cursor só avança se todas as fatias terminarem. Erro de página deixa a execução parcial e não avança o cursor. | Deno `tests/supabase/functions/sync_pncp_do_dia_test.ts` + pytest das fixtures de escopo compartilhadas |
| CA-3 | **Dado** uma compra em `leads` ou `monitorar`, ou no pipeline de alguma empresa, **quando** a trilha do dia roda, **então** as que tiveram atualização no PNCP no intervalo, ou cujo fim do recebimento passou nas últimas 48 h, são reconsultadas no detalhe; com `existeResultado` ou situação terminal, vão para `historico` na mesma execução. Fixture: caso 3035. | Deno `tests/supabase/functions/sync_pncp_do_dia_test.ts` |
| CA-4 | **Dado** uma execução que não cabe no tempo da Edge Function, **quando** o orçamento acaba, **então** ela termina como `incompleta` (como em `pagination-budget.ts`) e só vira `retomada` quando a execução seguinte assume a continuação pelo `private.acquire_sync_lock`; as fatias pendentes são retomadas sem duplicar linha e sem perder fatia, e o cursor só avança quando a cadeia termina `concluida`. | Deno, reaproveitando os testes de `pagination-budget.ts` |
| CA-5 | **Dado** o Sistema S, **quando** a trilha do dia roda, **então** consulta pelo mural (`PesquisarProcessos`) os processos abertos das fontes ativas, aplica o escopo e grava; **e** reconsulta no detalhe (`PesquisarProcessoDetalhes`) os processos do Sistema S já gravados em `leads`/`monitorar` que sumiram da lista de abertos, porque o processo encerrado sai do `PesquisarProcessos` e só aparece em `PesquisarProcessosMuralEstatistico`; encerrado vai para `historico` e entra na fila de resultados do acervo; a varredura por ID do SEST SENAT passa para o acervo. Fontes com WAF (FIEMG) continuam de fora. | Deno `tests/supabase/functions/sync_sistema_s_do_dia_test.ts` (fixtures do mural, sem rede) |
| CA-6 | **Dado** a trilha de acervo, **quando** roda no GitHub Actions, **então** usa grupo de concorrência próprio (não cancela nem espera a do dia), cobre histórico, recoleta ampla, documentos e OCR, e grava o progresso em `coleta_externa_run`; sua demora não muda a idade do dado do dia. | `tests/test_ci_coletor_pncp.py` |
| CA-7 | **Dado** uma compra que entra no pipeline, **quando** a etapa é gravada, **então** os documentos dessa compra entram na fila de download com prioridade sobre o acervo. | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-8 | **Dado** a saúde, **quando** `saude_operacional_resumo()` roda, **então** mostra separadas a idade do dado do dia (horas desde a última execução concluída) com limiar que conhece a agenda: dentro da janela 06:00–22:00 (Brasília), alerta quando passam 2 execuções seguidas sem conclusão (mais de 4 h e 30 min); fora da janela, o intervalo normal de 8 h (22:00 → 06:00) não alerta, e só alerta se a execução das 06:00 não concluir até as 08:30 e a do acervo (dias). | SQL `supabase/tests/saude_coleta_dia_check.sql` |
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

1. ~~Frequência da trilha do dia~~ **Decidido (Marcelo, 16/10/2026):** a cada 2 h, das 06:00 às 22:00 (Brasília),
   ajustável depois pela medição do CA-1.
2. ~~Escopo em TypeScript~~ **Decidido (Marcelo, 16/10/2026):** portar as regras de escopo para a Edge Function, com
   as mesmas fixtures do Python, para o lead aparecer na mesma execução (CA-10).
3. **Sistema S do dia:** quais fontes entram já (SEST SENAT e FIESC validadas em 24/09; Sesc pelo mural autorizado)?
4. **Spec 0028:** com esta spec, o Sistema S do dia sai do Cloud Run. A 0028 fica só com o registro de execução
   (`coleta_externa_run`) e o acervo do Sistema S no GitHub Actions, ou é absorvida por esta?
