# 0026: Mostrar a situação atual da oportunidade, com data, e corrigir a suspensão que não reconhece a reabertura

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** coletor + migrations + edge-functions + dashboard-contrato
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

## Critérios de aceite

`situacao_atual` é o campo novo: um objeto `{ codigo, rotulo, desde, ate, fonte }`.
- `codigo`: `recebendo_propostas`, `aguardando_recebimento`, `sessao_ou_julgamento`, `suspensa`, `encerrada` ou
  `null`.
- `rotulo`: texto com a data, por exemplo "Recebendo propostas até 23/10 14:00".
- `desde`/`ate`: as datas usadas, como vieram da fonte.
- `fonte`: `portal_compras_publicas`, `pncp` ou `documento_pncp`.

`situacao` (oficial do PNCP) e `fase` continuam expostos como hoje.

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Regressão (Biguaçu):** **dado** um aviso de suspensão e, no mesmo upload, um documento do tipo Edital com "pos-errata"/"errata"/"retificado" no título, com o fim do recebimento depois do upload, **quando** `fase_da_compra` roda, **então** a fase é "Recebendo propostas", a prioridade é `leads`, e o motivo traz "(suspensão anterior; retificado)". | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-2 | **Dado** um aviso de suspensão publicado mais de 10 min **depois** do último edital retificado ou republicado (caso 492), **ou** um edital retificado sem fim de recebimento posterior ao upload, **quando** `fase_da_compra` roda, **então** continua "Suspensa (documento)" / `monitorar`. | pytest `services/coletor-externo/tests/test_fase_compra.py` |
| CA-3 | **Dado** uma compra com leitura do Portal de Compras Públicas de **até 24 h** (`portal_consulta.consultado_em`), **quando** a situação é calculada, **então** `fonte` = `portal_compras_publicas` e o `codigo` sai do `statusProcesso` cru, por tabela escrita: "Recebendo Propostas" → `recebendo_propostas`; "Sessão Pública Iniciada" → `sessao_ou_julgamento`; "Suspenso…" → `suspensa`. Um valor fora da tabela vira `null`, com o texto cru no `rotulo`, nunca um código inventado. | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-4 | **Dado** uma compra sem leitura recente do portal, **quando** a situação é calculada pelo PNCP, **então**: (i) fase de suspensão → `suspensa` "Suspensa desde DD/MM" (data do documento ou da situação oficial); (ii) homologada, revogada, anulada, itens finalizados, registro de preço ou excluída → `encerrada`, com o motivo; (iii) "Em julgamento" → `sessao_ou_julgamento` "Propostas encerradas em DD/MM; sem vencedor homologado" (resposta b); (iv) `data_inicio` no futuro → `aguardando_recebimento` "Recebimento das propostas a partir de DD/MM HH:MM"; (v) `data_fim` no futuro → `recebendo_propostas` "Recebendo propostas até DD/MM HH:MM". | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-5 | **Dado** dados insuficientes (fase nula e datas nulas, ou situação oficial desconhecida), **quando** a situação é calculada, **então** `codigo` = `null` e `rotulo` = "Situação não informada"; nunca `recebendo_propostas` por padrão. O rótulo nunca chama a data de início do recebimento do PNCP de "abertura das propostas" nem de "sessão" (resposta c). | SQL `supabase/tests/situacao_atual_check.sql` |
| CA-6 | **Dado** um usuário com vínculo ativo, **quando** chama `api-dashboard-oportunidades` (`list` e `get`), **então** cada oportunidade traz `situacao_atual` igual à da função para aquela linha; **e** sem token a resposta continua 401, e usuário sem vínculo, 403. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-7 | **Dado** `situacao_atual`, **quando** o cabeçalho e o card "Valor homologado" renderizam, **então** o selo mostra o `rotulo` com a data e a fonte ("Portal de Compras Públicas, lido às HH:MM" ou "PNCP"), e o subtítulo do card sem valor homologado acompanha o `codigo`; "Fase de julgamento ou disputa" só aparece com `sessao_ou_julgamento`. | vitest `src/test/situacao-atual.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-8 | **Dado** o dry-run do reprocessamento das linhas em "Suspensa (documento)", **quando** ele roda com a regra nova, **então** só mudam as linhas com edital retificado no mesmo upload ou depois e com fim de recebimento futuro; pela medição de 16/10, 2392, 2410 e 3183. A 2660 já passou do prazo, e o portal dela diz "Sessão Pública Iniciada". A contagem antes/depois vai no PR. | pytest `services/coletor-externo/tests/test_fase_compra.py`, com fixtures dos casos e da 492, mais o dry-run no PR |

## Fora de escopo

- Coletar a ComprasBR ou outro portal além do que o `sync-portal-compras` já lê (decisão d).
- **Hora da sessão de disputa:** em Biguaçu, 14h15, só no edital. Ler o horário do edital é trabalho do Agente de
  Edital. Esta spec mostra o fim do recebimento, que é o que o PNCP traz.
- **Alerta da sessão pública para oportunidade no pipeline** (pedido do Marcelo em 16/10): vira spec própria, que usa
  `situacao_atual.ate` e, quando houver, a hora do edital.
- A URL da oportunidade com `CNPJ|processo` ambígua (duas publicações do mesmo pregão, como 2392/2393 e 1315/2660):
  item à parte. A exportação JSON já foi corrigida no Dashboard#96.
- A situação de cada item (`situacaoCompraItemNome`): continua a oficial do PNCP.
- Os 194 `leads` com prazo vencido na tabela: a view `licitacoes_externas_prioridade_efetiva` já os rebaixa (#319).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_situacao_atual.sql`, aditiva e idempotente:
  - função `public.situacao_atual(...)` com `search_path` fixo, `revoke all` e grant mínimo;
  - coluna derivada na view lida pela API (pergunta 4), juntando com `portal_consulta`;
  - checagem em `supabase/tests/situacao_atual_check.sql`.
- **Tabelas/views/funções tocadas:**
  - `licitacoes_externas.fase`/`prioridade`: o coletor grava; muda a regra em `analise_documental`;
  - `portal_consulta`: só leitura, o `sync-portal-compras` continua gravando;
  - a view `licitacoes_externas_prioridade_efetiva` (ou a que a API lê);
  - `api-dashboard-oportunidades`.
- **ACL/RLS:** nenhuma mudança em tabela. A função nova só recebe o grant que a view precisa. `portal_consulta`
  continua só para `service_role`.
- **Backfill/reprocessamento:** sim, das linhas em "Suspensa (documento)", com dry-run e contagem antes/depois no PR;
  as demais mudam na próxima coleta diária.
- **Edge Functions republicadas no merge:** todas. O código muda em `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** muda. Entra o campo `situacao_atual`. O backend vai ao ar antes do front, e o front
  atual ignora o campo.
- **Dado oficial x derivado:**
  - o `statusProcesso` do portal, a `situacao` do PNCP, os documentos e as datas aparecem como vieram, com a fonte
    e a hora da leitura;
  - `codigo` e `rotulo` saem de tabela escrita nesta spec;
  - nada é estimado: com dado insuficiente aparece "Situação não informada".

## Perguntas em aberto

1. **Portal × PNCP:** quando o portal diz uma coisa e o PNCP outra (em Ibatiba, o portal disse "Sessão Pública
   Iniciada" e o PNCP "Divulgada"), o portal vence sempre que a leitura tiver até 24 h? Outra janela de validade?
2. **"Operação: Suspensa" com status "Sessão Pública Iniciada":** a página do portal tem os dois campos, e o
   `portal_consulta` guarda só o `statusProcesso`. Ler também a operação (mudança no `sync-portal-compras`) entra
   aqui ou vira spec à parte?
3. **Rótulo de `sessao_ou_julgamento`:** "Propostas encerradas em DD/MM; sem vencedor homologado" atende à resposta
   b, ou prefere "Em julgamento desde DD/MM"?
4. **Onde calcular:** na view (SQL, testável em `_check.sql`, uma regra para a API e para o BI) ou na Edge Function.
   A proposta é a view.
5. **Sinal de reabertura:** só documento do **tipo Edital** com "retificado/errata/pós-errata/republicado" no título,
   ou também um documento "Errata" em "Outros documentos"? Em Biguaçu existem os dois.
6. **`aguardando_recebimento` entra nos `leads`?** Hoje lead é "recebendo proposta"; uma compra que ainda vai abrir
   pode valer como lead, para o fornecedor se preparar.
