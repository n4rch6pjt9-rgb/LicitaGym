# 0026: Mostrar a situação da oportunidade no vocabulário do ComprasBR e corrigir a suspensão que não reconhece o edital retificado

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** coletor + migrations + edge-functions + dashboard-contrato
- **Depende do ok do Marcelo:** sim (mudança de classificação em produção, migration, republicação de funções e contrato com o Dashboard)

## Problema

O fornecedor compara o LicitaGym com a plataforma onde a compra corre, e a situação não bate. O Marcelo filtra a
ComprasBR por **Aberta, Aguardando abertura, Encerrada e Suspensa** e diz que lá todas as oportunidades aparecem
abertas, enquanto o LicitaGym mostra fases como "Suspensa (documento)" e "Em julgamento". Decisão do Marcelo em
16/10/2026: usar esse vocabulário na tela, calculado com os dados que já temos (situação do PNCP, documentos, prazos,
resultado), **sem coletar a ComprasBR**.

O caso que abriu a discussão mostra um defeito na regra atual, além do vocabulário:

- **Biguaçu/SC, `82892308000153-1-000174/2026` (`licitacoes_externas.id` 2392), PERP 120/2026.**
  - O aviso de suspensão *sine die* foi assinado em 19/08/2026 17:40. O texto foi colado pelo Marcelo e a data vem
    da assinatura digital.
  - A errata 01 foi assinada em 29/09/2026 11:20 e reabre o pregão.
  - No PNCP, consultado em 16/10/2026: `situacaoCompraNome` "Divulgada no PNCP", propostas até 23/10/2026 14:00,
    `dataAtualizacao` 29/09/2026 13:55:06, e os 52 itens em "Em andamento".
  - O órgão subiu o aviso, a errata, o `Edital-PERP-120.2026-_pos-errata-01_.pdf` (tipo Edital) e os anexos
    pós-errata no mesmo upload, entre 13:48 e 13:51 de 29/09.
  - Mesmo assim, o LicitaGym mostra a compra como "Suspensa (documento)", em `monitorar`.
- **Causa** (`services/coletor-externo/coletor/pncp.py`, `analise_documental`):
  - a suspensão só é neutralizada por um documento do tipo Edital com "republica" no título (`_DOC_REPUBLICACAO`);
  - "retificado", "errata" e "pós-errata" não contam;
  - a retificação da compra (13:55) caiu dentro da `TOLERANCIA_RETIFICACAO` de 10 min depois do aviso (13:48), então
    não encerrou a suspensão.
- **Medição em produção** (somente leitura, 16/10/2026; datas comparadas com `now()`, aproximado em ±3 h por causa do
  fuso das colunas):
  - **2.314** linhas em `licitacoes_externas`;
  - **9** em "Suspensa (documento)", todas em `monitorar`. **4** delas têm propostas no futuro e um edital
    retificado, errata ou pós-errata no mesmo upload da suspensão: ids 2392, 2410, 3183 e 2660. Outras 3 continuam
    suspensas de fato: a 492 tem aviso de suspensão de 28/09 depois do edital de 23/09, e a 1777 e a 2146 são de 2025,
    sem nada depois. Na 2816 há edital e "justificativa para suspensão", sem sinal de reabertura;
  - distribuição de fase × prioridade:

    | fase | prioridade | n |
    |---|---|---|
    | Recebendo propostas | leads | 778 |
    | Homologada / com resultado | historico | 655 |
    | Em julgamento | monitorar | 410 |
    | (sem fase) | (sem prioridade) | 357 |
    | Encerrada (itens finalizados) | historico | 21 |
    | Homologada (documento) | historico | 20 |
    | Suspensa | monitorar | 19 |
    | (sem fase) | monitorar | 17 |
    | Revogada | historico | 12 |
    | Suspensa (documento) | monitorar | 9 |
    | Anulada | historico | 6 |
    | Registro de Preço | historico | 4 |
    | Homologação | (sem prioridade) | 3 |
    | (sem fase) | historico | 2 |
    | Revogada/Anulada (documento) | historico | 1 |

  - **datas:** **1.400** sem data de abertura das propostas (`data_inicio` nula), **32** com abertura no futuro,
    **569** entre a abertura e o encerramento, **108** sem data de encerramento (`data_fim` nula);
  - **"todas abertas na ComprasBR":** não medido. O coletor não lê a ComprasBR, e nenhuma oportunidade foi comparada
    com a página da plataforma.
- **Tela da oportunidade:** o card "Valor homologado" diz "Fase de julgamento ou disputa" sempre que não há valor
  homologado (`OpportunityAcompanhamentoView.tsx`, ~linha 708 do Dashboard), inclusive numa compra recebendo
  propostas, como a de Biguaçu.

## Critérios de aceite

`situacao_comprasbr` é o campo novo, com um dos valores `aberta`, `aguardando_abertura`, `encerrada`, `suspensa`, ou
`null` quando os dados não bastam. A situação oficial do PNCP (`situacao`) e a fase (`fase`) continuam sendo expostas
como hoje.

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Regressão (Biguaçu):** **dado** um aviso de suspensão e, no mesmo upload, um documento do tipo Edital com "pos-errata"/"errata"/"retificado" no título, com propostas encerrando depois do upload, **quando** `fase_da_compra` roda, **então** a fase é "Recebendo propostas", a prioridade é `leads` e o motivo traz "(suspensão anterior; retificado)". | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-2 | **Dado** um aviso de suspensão publicado mais de 10 min **depois** do último edital retificado ou republicado (caso 492), **quando** `fase_da_compra` roda, **então** continua "Suspensa (documento)" / `monitorar`. | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-3 | **Dado** um edital retificado no mesmo upload da suspensão, mas com o encerramento das propostas **anterior ou igual** ao upload, **quando** `fase_da_compra` roda, **então** continua "Suspensa (documento)": sem prazo novo, a retificação não prova a reabertura. | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-4 | **Dado** cada fase existente (tabela acima) com prazos conhecidos, **quando** a função SQL `situacao_comprasbr(fase, situacao, data_inicio, data_fim, agora)` é chamada, **então** devolve exatamente o valor da tabela de mapeamento da spec, depois de respondidas as perguntas 1 e 2. | SQL `supabase/tests/situacao_comprasbr_check.sql` |
| CA-5 | **Dado** fase nula e situação oficial que não é de encerramento, ou datas nulas que impedem decidir, **quando** a função roda, **então** devolve `null` ("Situação não informada"), nunca `aberta` por padrão. | SQL `supabase/tests/situacao_comprasbr_check.sql` |
| CA-6 | **Dado** um usuário com vínculo ativo, **quando** chama `api-dashboard-oportunidades` (`list` e `get`), **então** cada oportunidade traz `situacao_comprasbr` igual ao da função para aquela linha; **e** sem token a resposta continua 401, e usuário sem vínculo 403, sem o campo novo vazar. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-7 | **Dado** `situacao_comprasbr`, **quando** o cabeçalho e o card "Valor homologado" da oportunidade renderizam, **então** o selo mostra Aberta, Aguardando abertura, Encerrada, Suspensa ou "Situação não informada", e o subtítulo do card sem valor homologado acompanha a situação. Exemplo: aberta → "Recebendo propostas até DD/MM". Nunca aparece "Fase de julgamento ou disputa" numa compra aberta ou aguardando abertura. | vitest `src/test/situacao-comprasbr.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-8 | **Dado** o dry-run do reprocessamento das linhas em "Suspensa (documento)", **quando** ele roda com a regra nova, **então** só mudam as linhas com edital retificado no mesmo upload ou depois e com prazo futuro; pela medição de 16/10, as 4 (2392, 2410, 3183 e 2660). A contagem antes e depois vai no PR. | pytest `services/coletor-externo/tests/test_fase_compra.py`, com fixtures dos 4 casos e da 492, mais o dry-run registrado no PR |

**Tabela de mapeamento** (proposta; depende das perguntas 1 a 3):

| Condição, em ordem; a primeira que casar vence | `situacao_comprasbr` |
|---|---|
| fase "Suspensa" ou "Suspensa (documento)" | `suspensa` |
| fase de encerramento: Homologada (todas), Revogada, Anulada, Revogada/Anulada (documento), Encerrada (itens finalizados), Registro de Preço, Excluída do PNCP, Cancelada | `encerrada` |
| fase "Em julgamento" (propostas encerradas, sem resultado) | **pergunta 2** |
| `data_inicio` no futuro | `aguardando_abertura` |
| `data_inicio` passada ou nula **e** `data_fim` no futuro | `aberta` (com `data_inicio` nula: **pergunta 3**) |
| `data_fim` vencida | `encerrada` |
| nada acima decide | `null` |

## Fora de escopo

- Coletar a situação na ComprasBR ou em outra plataforma (decisão do Marcelo, 16/10: só o vocabulário).
- Mudar `situacao`, a situação oficial do PNCP, que continua exposta como veio.
- A situação de cada item (`situacaoCompraItemNome`): continua a oficial do PNCP.
- Corrigir os 194 `leads` com prazo vencido na tabela. A view `licitacoes_externas_prioridade_efetiva` já rebaixa
  esses casos na leitura (#319).
- Ler o texto do PDF da errata para confirmar a reabertura. A regra usa o título, o tipo e as datas; o texto do
  documento é trabalho do Agente de Edital.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_situacao_comprasbr.sql`, aditiva e idempotente:
  - função `public.situacao_comprasbr(...)`, `immutable`/`stable`, `search_path` fixo, `revoke all` + grant mínimo;
  - coluna derivada na view `licitacoes_externas_prioridade_efetiva` (ou na view que a API lê; ver pergunta 7).
  - Checagem em `supabase/tests/situacao_comprasbr_check.sql`.
- **Tabelas/views/funções tocadas:**
  - `licitacoes_externas.fase`/`prioridade`: o coletor grava, e a regra muda em `analise_documental`;
  - a view `licitacoes_externas_prioridade_efetiva`: a API lê;
  - `api-dashboard-oportunidades`: lê a view e devolve ao Dashboard.
- **ACL/RLS:** nenhuma mudança em tabela. A função nova recebe só o grant que a view precisa.
- **Backfill/reprocessamento:** sim, das linhas em "Suspensa (documento)", com dry-run e contagem antes e depois no
  PR. Pela medição de 16/10, devem mudar 4 linhas, que passam a `leads`. As demais mudam na próxima coleta diária.
- **Edge Functions republicadas no merge:** todas (a integração republica o repositório). O código muda em
  `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** muda. Entra o campo `situacao_comprasbr`, e o Dashboard troca o selo do cabeçalho e o
  subtítulo do card. O backend vai ao ar antes do front, e o front atual ignora o campo novo.
- **Dado oficial x derivado:** `situacao`, os documentos e as datas vêm do PNCP como gravados. `fase`,
  `prioridade` e `situacao_comprasbr` são derivados por regra escrita nesta spec. A tela mostra "Situação não
  informada" quando a regra não decide; nunca "aberta" por padrão.

## Perguntas em aberto

1. **O que a ComprasBR chama de "Aberta" e de "Aguardando abertura"?** A proposta lê "Aguardando abertura" como
   "a abertura das propostas ainda não chegou" e "Aberta" como "recebendo propostas". Se na ComprasBR
   "Aguardando abertura" quer dizer "propostas recebidas, esperando a sessão de disputa", o mapeamento muda.
2. **"Em julgamento"** (propostas encerradas, sem resultado; 410 linhas em 16/10) vira `encerrada` ou `aberta`? Na
   ComprasBR, a sessão em andamento pode aparecer como "Aberta".
3. **Sem data de abertura** (1.400 de 2.314 linhas) e com encerramento no futuro: `aberta`, ou `null` ("não
   informada")? A proposta diz `aberta`, porque o PNCP só publica a compra quando ela já pode receber propostas. Isso
   não foi verificado na documentação do PNCP.
4. **Sinal de reabertura:** só documento do **tipo Edital** com "retificado/errata/pós-errata/republicado" no título,
   ou também um documento "Errata" em "Outros documentos"? Em Biguaçu existem os dois.
5. **`aguardando_abertura` entra nos `leads`?** Hoje o lead é "recebendo proposta". Uma compra que ainda vai abrir
   pode valer como lead, para o fornecedor se preparar.
6. **Validação com a ComprasBR:** como "todas abertas na ComprasBR" não foi medido, o Marcelo pode mandar de 5 a 10
   links da ComprasBR de oportunidades que divergem, para virarem fixture dos testes e conferência do mapeamento?
7. **Onde calcular:** na view (SQL, testável em `_check.sql`, uma regra para a API e para o BI) ou na Edge Function.
   A proposta é a view.
