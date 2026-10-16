# 0026a: Mostrar a situação atual da oportunidade, com data, e corrigir a suspensão que não reconhece a reabertura

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** coletor + migrations + edge-functions + dashboard-contrato
- **Sequência:** 0026a (esta) → 0026b (rota e tela de suspensas) → 0027 (verificação de retomada das suspensas)
- **Depende do ok do Marcelo:** sim (mudança de classificação em produção, migration, republicação de funções e contrato com o Dashboard)

## Problema

A situação que o LicitaGym mostra não corresponde ao estado atual da compra. O fornecedor vê "Suspensa (documento)"
ou "Em andamento" quando a compra está recebendo propostas ou com sessão marcada.

**Decisões do Marcelo em 16/10/2026:**
- **(a)** A situação **espelha o estado atual, com data**, como "sessão marcada para DD/MM HH:MM", e não um rótulo
  genérico como "em andamento". Não precisa seguir o vocabulário de um portal específico (o filtro da ComprasBR —
  Aberta, Aguardando abertura, Encerrada, Suspensa — foi só exemplo).
- **(b)** "Em julgamento" quer dizer que ainda **não há vencedor definido nem homologado**, ou que **novas sessões
  ainda vão ocorrer**. Não é "encerrada".
- **(c)** "Abertura" tem **mais de um sentido**, e o sentido depende do objeto e do portal (ver o caso de Ibatiba
  abaixo).
- **(d)** Sem coletar a ComprasBR.

**Decisões do Marcelo em 16/10/2026, sobre as perguntas da primeira revisão:**
- **(e)** O **Portal de Compras Públicas sempre vence** o PNCP quando há leitura do portal.
- **(f)** A **operação** do portal ("Operação: Suspensa") entra nesta spec, porque está ligada à situação.
- **(g)** O rótulo é **"Em julgamento"**. **Homologada vira histórico e sai de Oportunidades.** **Suspensa também sai
  de Oportunidades** e vai para uma **rota própria de licitações suspensas**, com API, e um **cron que verifica
  cada suspensa conforme a regra do documento de suspensão**. A rota e a tela ficam na 0026b, o cron na 0027.
- **(h)** O cálculo fica na **view**.
- **(i)** Só documento do **tipo Edital** conta como reabertura. "Errata" em "Outros documentos" não conta: "não
  podemos ficar à mercê de erro de terceiros".
- **(j)** "Aguardando recebimento" é vago. O rótulo precisa dizer **o que** vai abrir e **quando**.

**Caso 1, Biguaçu/SC, `82892308000153-1-000174/2026` (id 2392), PERP 120/2026, na ComprasBR.**
- O aviso de suspensão *sine die* foi assinado em 19/08/2026 17:40 (texto colado pelo Marcelo).
- A errata 01, assinada em 29/09/2026 11:20, reabre o pregão. O edital pós-errata traz "Sessão pública: 23/10/2026;
  recebimento das propostas até 14h; início da sessão de disputa 14h15; endereço eletrônico ComprasBR.com.br" (print
  do edital mandado pelo Marcelo).
- O PNCP, consultado em 16/10/2026, mostra "Divulgada no PNCP", recebimento das propostas de 04/08/2026 18:00 a
  23/10/2026 14:00 e `dataAtualizacao` 29/09/2026 13:55:06. O aviso, a errata e o edital pós-errata foram enviados no
  mesmo upload, das 13:48 às 13:51 de 29/09.
- O LicitaGym mostra "Suspensa (documento)", em `monitorar`.
- **Causa:** em `services/coletor-externo/coletor/pncp.py`, `analise_documental` só neutraliza a suspensão com um
  documento do tipo Edital que tenha "republica" no título (`_DOC_REPUBLICACAO`). "Retificado", "errata" e
  "pós-errata" não contam, e a retificação da compra (13:55) caiu dentro da `TOLERANCIA_RETIFICACAO` de 10 min depois
  do aviso (13:48).

**Caso 2, Ibatiba/ES, Pregão Eletrônico nº 048/2026 (processo 050/2026), no Portal de Compras Públicas.**
- **O que o portal mostra** (pacote mandado pelo Marcelo em 16/10, lido sem o HAR):
  - "Suspensões/Reinícios": suspensão em **22/09/2026 16:01** (termo assinado pelo prefeito em 22/09);
    **reinício em 02/10/2026 09:03**, "com a respectiva reabertura do prazo integral para a apresentação das
    propostas"; nova **suspensão em 16/10/2026 16:22**, porque "o valor apresentado se encontra inferior a 50% do
    valor médio estimado";
  - na página: "Limite p/ Recebimento das Propostas 16/10/2026 às 15:00", "**Abertura das Propostas 16/10/2026 às
    15:01**", "Sessão pública iniciada" e "Operação: Suspensa", com item 73 "Suspenso".
- **No PNCP** existem duas publicações do mesmo pregão:
  - `27744150000166-1-000128/2026` (id 1315): situação oficial "Suspensa", sem data de abertura, encerramento
    28/09;
  - `27744150000166-1-000137/2026` (id 2660): "Divulgada no PNCP", **início do recebimento 02/10/2026** (é o
    reinício, não a "abertura das propostas" do portal), encerramento 16/10/2026.
- **No LicitaGym**, a 2660 aparece como "Suspensa (documento)" desde o termo de 22/09. Entre 02/10 e 16/10 isso
  estava errado: a compra recebia propostas. Hoje coincide com a suspensão de 16/10, mas pelo motivo errado. A
  suspensão de 16/10 não aparece no PNCP.
- **Leitura do portal que já existe:** `portal_consulta.situacao` da 2660 = "Sessão Pública Iniciada", lida em
  16/10/2026 às 16:19 (Brasília), 3 min antes da suspensão.

**Medição em produção** (somente leitura, 16/10/2026; datas comparadas com `now()`, aproximado em ±3 h pelo fuso das
colunas):
- **2.314** linhas em `licitacoes_externas`;
- **9** em "Suspensa (documento)", todas em `monitorar`. **4** delas têm propostas no futuro e um edital
  retificado, errata ou pós-errata no mesmo upload da suspensão: 2392, 2410, 3183 e 2660. Continuam suspensas a 492
  (aviso de 28/09 posterior ao edital de 23/09), a 1777 e a 2146 (de 2025). A 2816 tem só "justificativa para
  suspensão";
- **fases:** Recebendo propostas/leads 778, Homologada/com resultado 655, Em julgamento/monitorar 410, sem fase 376,
  Encerrada (itens finalizados) 21, Homologada (documento) 20, Suspensa 19, Revogada 12, Suspensa (documento) 9,
  Anulada 6, Registro de Preço 4, Homologação 3, Revogada/Anulada (documento) 1;
- **datas:** **1.400** sem `data_inicio`, **32** com `data_inicio` no futuro, **569** entre `data_inicio` e
  `data_fim`, **108** sem `data_fim`;
- **`portal_consulta`:** **25** compras lidas (todas HTTP 200), com `situacao` entre "Recebendo Propostas", "Sessão
  Pública Iniciada" e "Suspenso - Antes da Abertura";
- **"na ComprasBR todas aparecem abertas":** não medido (o coletor não lê a ComprasBR).

**Tela:** o card "Valor homologado" diz "Fase de julgamento ou disputa" sempre que não há valor homologado
(`OpportunityAcompanhamentoView.tsx`, ~linha 708 do Dashboard), inclusive numa compra recebendo propostas.

**Medição de homologadas e suspensas** (somente leitura, 16/10/2026, `prioridade` gravada na tabela):
- todas as fases de homologação, revogação, anulação e itens finalizados já estão em `historico` (656 + 20 + 22 +
  13 + 6 + 1), menos **3** em "Homologação" com prioridade nula (fora do escopo);
- **nenhuma** compra em `leads`/`monitorar` tem `data_homologacao` ou resultado em `resultados_itens_14133`;
- **28** suspensas estão em `monitorar` e por isso aparecem em Oportunidades: 19 "Suspensa" (oficial) e 9
  "Suspensa (documento)";
- **não reproduzido:** "temos vários homologados em oportunidades". Pelos dados, nenhuma homologada está fora do
  `historico`. Pode ser homologação que só o portal mostra (o PNCP ainda diz "Divulgada"). Falta um exemplo (pergunta 1).

**Decisões do Marcelo em 16/10/2026, sobre as perguntas da segunda revisão:**
- **(k)** A verificação de retomada das suspensas vira **spec própria** (0027).
- **(l)** Ordem: **primeiro a tela de suspensas, depois a mudança** que tira as suspensas de Oportunidades (0026b).
- **(m)** "Recebimento de propostas abre em…" **é lead**.
- **(n)** A spec se divide em 0026a, 0026b e 0027.

**Recebimento ainda por abrir** (medição de 16/10): as **41** compras com `data_inicio` no futuro já estão em
`leads`, mas com a fase "Recebendo propostas", que é falsa até a data de início. A prioridade não muda; muda o
rótulo.

## Critérios de aceite

`situacao_atual` é o campo novo: `{ codigo, rotulo, desde, ate, fonte, lido_em }`.
- `codigo`: `recebendo_propostas`, `propostas_abrem_em`, `em_julgamento`, `suspensa`, `encerrada` ou `null`.
- `rotulo`: texto com a data, por exemplo "Recebendo propostas até 23/10 14:00".
- `desde`/`ate`: as datas usadas, como vieram da fonte.
- `fonte`: `portal_compras_publicas`, `pncp` ou `documento_pncp`.
- `lido_em`: a hora da leitura do portal (nulo para o PNCP).

`situacao` (oficial do PNCP) e `fase` continuam expostos como hoje. Esta spec **não** tira nada da lista de
Oportunidades: isso é da 0026b, depois da tela de suspensas (decisão l).

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Regressão (Biguaçu):** **dado** um aviso de suspensão e, no mesmo upload ou depois, um documento do **tipo Edital** com "pos-errata"/"errata"/"retificado"/"republicado" no título, com o fim do recebimento depois do upload, **quando** `fase_da_compra` roda, **então** o edital retificado **neutraliza a suspensão** e a fase segue o cálculo comum por data: com o fim do recebimento **ainda no futuro**, "Recebendo propostas", `leads`, e o motivo traz "(suspensão anterior; edital retificado)"; com o fim do recebimento **já passado**, "Em julgamento", `monitorar`. | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-2 | **Dado** só um documento "Errata" em "Outros documentos" (tipo diferente de Edital) depois do aviso de suspensão, **ou** um aviso publicado mais de 10 min depois do último edital retificado (caso 492), **ou** um edital retificado sem fim de recebimento posterior ao upload, **quando** `fase_da_compra` roda, **então** continua "Suspensa (documento)" (decisão i). | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-3 | **Dado** uma leitura do Portal de Compras Públicas, **quando** a situação é calculada, **então** ela **sempre vence** o PNCP (decisão e), com `fonte` = `portal_compras_publicas` e `lido_em`. O `codigo` sai do `statusProcesso` e da operação, por tabela escrita: operação suspensa → `suspensa`, qualquer que seja o status; "Recebendo Propostas" → `recebendo_propostas`; "Sessão Pública Iniciada" e "Adjudicad…" (vencedor ainda não homologado; decisão b) → `em_julgamento`; "Suspenso…" → `suspensa`; **estados terminais** "Homologad…", "Revogad…", "Anulad…", "Cancelad…", "Desert…", "Fracassad…", "Encerrad…" e "Finalizad…" → `encerrada`. A lista exata de `statusProcesso` é conferida contra o schema da API do portal em `docs/` antes da implementação, e um valor novo entra na tabela por PR. Um valor **fora da tabela** não vence: a situação sai do PNCP (CA-5), com o texto cru do portal ao lado no `rotulo` ("Portal: <status>"), nunca um código inventado e nunca `null` por cima de uma classificação terminal do PNCP. As datas do rótulo, com `fonte` = `portal_compras_publicas`, vêm só das datas lidas do portal (CA-4); sem elas, o rótulo do portal sai sem data, e nunca com data do PNCP. | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-4 | **Dado** a página pública de uma compra no portal, **quando** o `sync-portal-compras` lê, **então** grava em `portal_consulta` também a operação crua (coluna nova `operacao`) e as datas cruas da página — limite do recebimento das propostas e abertura das propostas (colunas novas `limite_propostas_em` e `abertura_propostas_em`, com o texto original ao lado) —, junto do `statusProcesso`; campo ausente na resposta fica nulo e a leitura não falha. Fixture: o caso de Ibatiba ("Sessão Pública Iniciada" + "Operação: Suspensa"). | Deno `tests/supabase/functions/sync_portal_compras_test.ts` |
| CA-5 | **Dado** uma compra sem leitura do portal, **quando** a situação é calculada pelo PNCP, **então**: (i) fase de suspensão → `suspensa` "Suspensa desde DD/MM"; (ii) homologada, revogada, anulada, itens finalizados ou excluída → `encerrada`, com o motivo; (iii) "Em julgamento" → `em_julgamento` "Em julgamento desde DD/MM" (fim do recebimento; decisão g); (iv) `data_inicio` no futuro → `propostas_abrem_em` "Recebimento de propostas abre em DD/MM HH:MM" (decisão j); (v) `data_fim` no futuro → `recebendo_propostas` "Recebendo propostas até DD/MM HH:MM". | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-6 | **Dado** uma compra com `codigo` = `propostas_abrem_em`, **quando** a prioridade efetiva é calculada, **então** é `leads` (decisão m), como hoje para as 41 medidas; a view não a rebaixa por prazo. | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-7 | **Dado** dados insuficientes, **quando** a situação é calculada, **então** `codigo` = `null` e `rotulo` = "Situação não informada"; nunca `recebendo_propostas` por padrão. O rótulo nunca chama o início do recebimento do PNCP de "abertura das propostas" nem de "sessão". | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-8 | **Dado** um usuário com vínculo ativo, **quando** chama `api-dashboard-oportunidades` (`list` e `get`), **então** cada oportunidade traz `situacao_atual` igual à da view para aquela linha; sem token, 401; sem vínculo, 403. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-9 | **Dado** `situacao_atual`, **quando** o cabeçalho e o card "Valor homologado" renderizam, **então** o selo mostra o `rotulo` e a fonte ("Portal de Compras Públicas, lido às HH:MM" ou "PNCP"), e o subtítulo do card sem valor homologado acompanha o `codigo` ("Em julgamento" só com `em_julgamento`). | vitest `src/test/situacao-atual.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-10 | **Dado** o dry-run do reprocessamento das linhas em "Suspensa (documento)", **quando** roda com a regra nova, **então** só mudam as linhas com edital retificado no mesmo upload ou depois e com fim de recebimento futuro (medição de 16/10: 2392, 2410 e 3183). Contagem antes/depois no PR. | pytest `services/coletor-externo/tests/test_fase_compra.py` + dry-run no PR |

## Fora de escopo

- **Rota e tela de suspensas, e tirar suspensas e encerradas da lista de Oportunidades:** 0026b.
- **Verificação de retomada das suspensas (cron pela regra do documento):** 0027.
- Coletar a ComprasBR ou outro portal além do que o `sync-portal-compras` já lê (decisão d).
- **Hora da sessão de disputa:** em Biguaçu, 14h15, só no edital. Ler o horário do edital é trabalho do Agente de
  Edital. Esta spec mostra o fim do recebimento, que é o que o PNCP traz.
- **Alerta da sessão pública para oportunidade no pipeline:** spec própria, que usa `situacao_atual.ate` e, quando
  houver, a hora do edital.
- A URL da oportunidade com `CNPJ|processo` ambígua (duas publicações do mesmo pregão, como 2392/2393 e 1315/2660):
  item à parte. A exportação JSON já foi corrigida no Dashboard#96.
- A situação de cada item (`situacaoCompraItemNome`): continua a oficial do PNCP. Item 73 suspenso em Ibatiba não
  suspende a compra.

## Impacto em dados

- **Migrations:** sim, aditivas e idempotentes, cada uma com seu `_check.sql`:
  - `<timestamp>_portal_consulta_operacao.sql`: colunas `operacao text`, `limite_propostas_em timestamptz`,
    `abertura_propostas_em timestamptz` e o texto original das datas em `portal_consulta`;
  - `<timestamp>_situacao_atual.sql`: função `public.situacao_atual(...)` (`search_path` fixo, `revoke all`, grant
    mínimo) e a coluna derivada na view lida pela API (decisão h), juntando com `portal_consulta`.
- **Tabelas/views/funções tocadas:**
  - `licitacoes_externas.fase`/`prioridade`: o coletor grava; muda a regra em `analise_documental`;
  - `portal_consulta`: coluna nova, gravada pelo `sync-portal-compras`;
  - a view `licitacoes_externas_prioridade_efetiva` (ou a que a API lê);
  - `api-dashboard-oportunidades` e `sync-portal-compras`.
- **ACL/RLS:** nenhuma mudança em tabela; `portal_consulta` continua só para `service_role`.
- **Backfill/reprocessamento:** sim, das linhas em "Suspensa (documento)", com dry-run e contagem antes/depois.
- **Edge Functions republicadas no merge:** todas. O código muda em `api-dashboard-oportunidades` e
  `sync-portal-compras`.
- **Contrato com o Dashboard:** muda. Entra o campo `situacao_atual`. O backend vai ao ar antes do front, e o front
  atual ignora o campo. A lista de Oportunidades não muda.
- **Dado oficial x derivado:**
  - o `statusProcesso` e a operação do portal, a `situacao` do PNCP, os documentos e as datas aparecem como vieram,
    com a fonte e a hora da leitura;
  - `codigo` e `rotulo` saem de tabela escrita nesta spec;
  - nada é estimado: com dado insuficiente aparece "Situação não informada".

## Perguntas em aberto

1. **Homologadas em Oportunidades:** pelos dados, nenhuma homologada está fora do `historico`. Você tem um exemplo
   (link ou id)? Se for homologação que só o portal mostra, o CA-3 cobre pelos estados terminais ("Homologad…" →
   `encerrada`), mas preciso de um caso real para conferir o texto exato do `statusProcesso` na fixture.
