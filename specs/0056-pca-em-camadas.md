# 0056: Sincronizar o PCA em camadas: impressão digital por órgão, carga só do que mudou e eventos

- **Status:** rascunho (perguntas respondidas; aguarda aprovação)
- **Alimenta:** etapa 1 (coleta) de `docs/produto/TRILHAS-E-INFORME.md`; módulo 1 de `docs/produto/ESCOPO.md` (Radar
  de oportunidades). A regra de foco da 0032 está suspensa desde 11/11/2026 (`ESCOPO.md` em revisão)
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** edge-functions (`sync-pncp-pca`) | pncp (`_shared/pncp/pca-fila.ts`, `integracao-client.ts`) | migrations
- **Depende do ok do Marcelo:** sim (migration, crons de produção, mudança da ingestão)

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega; o que não fazer | sim |
| 2 | `AGENTS.md` | zero alucinação; consultar schema antes de chamar API | sim |
| 3 | `.claude/rules/regras-negocio.md` | escopo (TR primeiro, ar livre fora) | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 1 e a regra de foco | não: ler |
| 5 | `docs/produto/TRILHAS-E-INFORME.md` | as 4 etapas; esta spec é a etapa 1 | não: ler |
| 6 | `specs/0012-pca-sync-cpu-pagina.md` | o desenho atual (descoberta pela consulta, carga pela integração, fila de planos) | não: ler |
| 7 | `specs/0013-pca-cruzamento-contratacao-ifc.md` | quem consome `grupo_contratacao_codigo` (plano → compra) | não: ler |
| 8 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 9 | `.claude/rules/pncp.md`, `.claude/rules/edge-functions.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções das áreas tocadas | ao abrir a pasta |
| 10 | `docs/pncp/schemas-consultas-pncp.md`, `docs/pncp/openapi/pncp-integracao-v3-api-docs-2026-10-09.json` | parâmetros de `consolidado/unidades`, `/itens`, `/itens/quantidade` | não: ler |
| 11 | `docs/pncp/avaliacao-apis-pca-2026-10.md` | medições de 09/10 (paginação da consulta que pula itens, `/pca/atualizacao` com 500) | não: ler |
| 12 | `docs/pncp/cron-sync-jobs.md` | limites de parede da Edge Function e cronograma dos crons | não: ler |
| 13 | `supabase/functions/sync-pncp-pca/index.ts`, `rotina-fila.ts` | rotinas `incremental`, `backfill`, `reconciliacao`, orçamento por invocação, continuação | não: ler |
| 14 | `supabase/functions/_shared/pncp/pca-fila.ts`, `pca-lote.ts`, `pca-atomico.ts`, `integracao-client.ts` | descoberta, fila, carga, validação de itens, gravação em lote | não: ler |
| 15 | `supabase/migrations/202609180004_pca.sql`, `20261011100000_pca_plano_fila.sql`, `20261011100300_pca_historico_orgao_ano.sql` | `pca_planos`, `pca_itens`, `pca_alteracoes`, `private.pca_plano_fila` | não: ler |
| 16 | `tests/supabase/functions/sync_pncp_pca_fila_test.ts`, `supabase/tests/pca_plano_fila_check.sql` | onde entram os testes dos CAs | não: ler |
| 17 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa | quando invocados |

## Problema

O sync do PCA não lê plano nenhum desde 07/11/2026. Medido em 11/11/2026 (consultas somente leitura no banco de
produção e GET público no PNCP):

- **Parado.** Desde 07/11, 32 execuções de `resource_type = 'pca'` receberam 0 registros. Os motivos são "descoberta:
  pausa de cota" (20), "descoberta: HTTP 503 on pncp.gov.br" (8) e "descoberta encerrada: 3 erros seguidos na classe
  7830 página 1" (4). A última execução com registro recebido e a última linha de `pca_alteracoes` são de 06/11.
- **A descoberta derruba tudo.** Hoje a descoberta é a consulta `/v1/pca/` por classe (fase A da 0012). Quando a página 1
  da classe 7830 falha, nenhum plano entra na fila, nem os planos de órgãos que o sistema já conhece. São 946 planos
  ativos de 2026, de 329 órgãos, em `pca_planos`.
- **A fila acumula erro.** `private.pca_plano_fila`: 838 `feito` e 200 `erro`. Os erros: "1 erro(s) na gravação em lote"
  (140, causa **não diagnosticada**), "HTTP 503 on pncp.gov.br" (21) e "classificacaoSuperiorCodigo inválida" (39: um
  único item com código de classe fora do padrão faz o plano inteiro falhar, por decisão de não inativar item sem
  prova).
- **O código "inválido" tem duas origens** (6 dos 39 planos lidos em 11/11/2026 por `/itens`, 355 itens fora do padrão):
  - **erro nosso, 298 itens (84%):** itens de **serviço** (`classificacaoCatalogoId = 2`) com código de 2 dígitos, como
    "09" (ADMINISTRACAO GERAL), "14", "07", "86". É o formato da classificação de serviços na própria fonte, e a regra
    de `pca-fila.ts` só aceita 4 dígitos (ou 3 para serviço);
  - **erro da administração, 57 itens:** item de **material** (`classificacaoCatalogoId = 1`) com código de serviço de
    3 dígitos (ex.: "979", "622", "853"), código de item no lugar da classe (ex.: "445484", "625421"), texto livre
    ("110" com a descrição do item no nome da classe) ou "Não se aplica.".
  - Um dos 6 planos (`20622890000180/2026/5`) devolveu exatamente 2.000 itens na página 1; as páginas seguintes não
    foram lidas. Quantos dos 39 planos só têm o primeiro tipo: não medido.
- **Existe um caminho estável por órgão.** `GET /v1/orgaos/{cnpj}/pca/{ano}/consolidado/unidades` (IFPR, 2026) respondeu
  200 em 0,9 s e lista um plano por UASG com `codigoUnidade`, `sequencialPca`, `quantidade`, `valorTotal`,
  `dataAtualizacao`, `dataAtualizacaoGlobalPCA` e `numeroControlePNCP`. **A rota pagina:** sem parâmetro devolve 10
  planos, `tamanhoPagina=50` devolve os 20; a página depois da última responde **404 com a mensagem "CNPJ do
  Órgão/Entidade inválido."**, que não pode ser lida como erro do órgão nem como "sem plano".
- **O evento do plano não diz o que mudou.** `pca_alteracoes` tem 8.247 linhas (`insert` 7.303, `update` 755,
  `inativacao` 189), sem o tipo de evento que a tela precisa ("PCA novo", "item detectado", "item atualizado"), sem a
  data da fonte e sem os campos alterados.
- **A chave plano → compra não é gravada.** `pca_itens` não tem `grupo_contratacao_codigo`, que a 0013 usa para achar a
  compra (formato `UASG-N/ANO`, provado na USP em 10/11: 113 grupos ligados).
- Não medido: quantos órgãos têm plano alterado por dia; a causa dos 140 "erros na gravação em lote".

## Contrato

As quatro camadas, da mais barata à mais cara. Uma camada que falha não impede as outras de rodar com o que já
conhecem.

| Camada | Fonte | Frequência | O que faz |
|---|---|---|---|
| 0 | Consulta `/v1/pca/` por classe do escopo | semanal | só descobre órgão novo (CNPJ que ainda não está em `pca_planos` do ano) |
| 1 | Integração `consolidado/unidades` por órgão conhecido | diária | grava a impressão digital de cada plano e põe na fila só o plano novo ou alterado |
| 2 | Integração `/itens` + `/itens/quantidade` por plano da fila | diária, depois da 1 | lê todos os itens do plano, confere o total e grava os do escopo (carga da 0012) |
| 3 | Comparação entre a carga e o que estava gravado | na mesma transação da 2 | grava eventos com tipo, data da fonte e campos alterados |

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: `private.pca_impressao_plano` (nova); colunas novas em `public.pca_alteracoes` e `public.pca_itens`; crons | — | `pca_impressao_plano`: `orgao_cnpj`, `ano`, `codigo_unidade`, `sequencial`, `quantidade`, `valor_total`, `data_atualizacao`, `data_atualizacao_global`, `numero_controle_pncp`, `lido_em`, `sync_run_id`; chave `(orgao_cnpj, ano, sequencial)`. `pca_alteracoes` ganha `evento` (`pca_novo` \| `pca_atualizado` \| `pca_removido` \| `item_detectado` \| `item_atualizado` \| `item_removido` \| `entrou_escopo` \| `saiu_escopo`), `detectado_em`, `data_fonte`, `campos_alterados text[]`. `pca_itens` ganha `grupo_contratacao_codigo` e `grupo_contratacao_nome`. As linhas antigas de `pca_alteracoes` ficam com `evento` nulo | — | escrita e leitura: só `service_role` |
| K-2 | `sync-pncp-pca` rotina `impressao` (camada 1) | `{ rotina: "impressao", ano?, orcamento_ms?, limite_orgaos? }`; órgãos = CNPJs distintos de `pca_planos` do ano, na ordem da impressão mais antiga | Para cada órgão: lê todas as páginas de `consolidado/unidades` (`tamanhoPagina=50`) até a página vir com menos de 50 linhas; grava a impressão; enfileira em `pca_plano_fila` (motivo `impressao`) o plano sem impressão anterior ou com `data_atualizacao`, `quantidade` ou `valor_total` diferente. Plano gravado que não vem na lista do órgão gera `pca_removido` com situação "a confirmar" e **não** inativa itens; só inativa (e gera `item_removido` dos itens do escopo) se continuar fora em duas leituras diárias seguidas (P-4). Continuação como as outras rotinas (orçamento por invocação, lock próprio) | 401 sem token de cron; 404 na página 1 → erro do órgão (não "sem plano"); 404 em página > 1 depois de página cheia → fim da lista; 429/503 → pausa e retomada, sem marcar o órgão | cron (`validateCronAuth`, como hoje em `sync-pncp-pca`) |
| K-3 | Carga do plano (camada 2), na fila existente | plano da fila | Lê `/itens` e `/itens/quantidade` (já na 0012). Confere o total lido com `/itens/quantidade` **e** com a `quantidade` da impressão; divergência → erro, nada inativado. Grava `grupo_contratacao_codigo` e `grupo_contratacao_nome` como vieram do DTO (nulo quando ausente; nunca derivado). **Classe do item:** item de serviço (`classificacaoCatalogoId = 2`) com código de 2 a 4 dígitos é válido e fica fora do escopo de material; item com classe fora do padrão (erro da administração) é gravado como "classe desconhecida" com o valor original guardado, fica fora do escopo, não conta para ausência (nunca gera `item_removido`) e o plano segue; a falha só derruba o plano quando o item desconhecido já estava gravado como do escopo | erro do plano registrado na fila, com mensagem | interno do K-2 / rotina de carga |
| K-4 | Eventos (camada 3) | estado gravado antes da carga × itens lidos | Uma linha em `pca_alteracoes` por evento: `pca_novo` (plano sem linha anterior), `pca_atualizado` (cabeçalho mudou), `item_detectado` (item do escopo novo no plano), `item_atualizado` (com `campos_alterados`, ex.: `{valor_total_estimado}`), `item_removido` (item do escopo que não veio numa leitura completa), `entrou_escopo` / `saiu_escopo` (a classe do item mudou para dentro ou para fora do escopo). `detectado_em = now()`; `data_fonte` = `dataAtualizacao` do item (ou do plano, nos eventos de plano). `tipo_operacao` continua sendo gravado como hoje | — | interno |
| K-5 | `sync-pncp-pca` rotina `descoberta` (camada 0) e cronograma | `{ rotina: "descoberta", ano? }` | Usa a descoberta atual por classe, mas só para achar CNPJ novo: grava a impressão do órgão novo (K-2) em vez de enfileirar plano a plano. Crons: `impressao` diário, `descoberta` semanal, carga e continuação diárias. Os crons ativos hoje (`licitagym-sync-pncp-pca-fila`, `licitagym-sync-pncp-pca-fila-continuacao`, `licitagym-sync-pncp-pca-reconciliacao`) são substituídos na mesma migration; os legados já estão desligados | como hoje; falha da camada 0 não afeta K-2 | cron (`validateCronAuth`) |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** os papéis `anon` e `authenticated`, **quando** leem `private.pca_impressao_plano` ou as colunas novas por PostgREST, **então** recebem erro de permissão; `service_role` lê e grava. A migration roda duas vezes sem erro | SQL `supabase/tests/pca_impressao_plano_check.sql` |
| CA-2 | K-2 | **Dado** um órgão com 20 planos (`tamanhoPagina=50`: página 1 com 20 linhas), e outro com 60 (página 1 com 50, página 2 com 10), **quando** a rotina `impressao` roda, **então** grava 20 e 60 impressões e não pede página além da última | Deno `tests/supabase/functions/sync_pncp_pca_impressao_test.ts` (0056 CA-2) |
| CA-3 | K-2 | **Dado** um órgão cuja página 1 responde 404 "CNPJ do Órgão/Entidade inválido.", **quando** a rotina roda, **então** o órgão fica com erro registrado, nenhum plano dele é marcado como removido e a rotina segue para o próximo órgão | Deno `sync_pncp_pca_impressao_test.ts` (0056 CA-3) |
| CA-4 | K-2 | **Dado** três planos com impressão anterior (um igual, um com `dataAtualizacao` nova, um com `valorTotal` diferente e mesma data) e um plano sem impressão, **quando** a rotina roda, **então** entram na fila só os três últimos, com motivo `impressao`; e um plano gravado que não veio na lista gera `pca_removido` "a confirmar" sem inativar item | Deno `sync_pncp_pca_impressao_test.ts` (0056 CA-4) |
| CA-5 | K-3 | **Dado** um plano com `quantidade = 629` na impressão e `/itens` devolvendo 628 itens, **quando** a carga roda, **então** o plano fica em `erro`, nenhum item é inativado e nenhum evento `item_removido` é gravado | Deno `tests/supabase/functions/sync_pncp_pca_fila_test.ts` (0056 CA-5) |
| CA-6 | K-3, K-4 | **Dado** um plano já gravado com o item 7 do escopo (R$ 1.000) e uma leitura completa em que o item 7 vale R$ 1.200, o item 8 do escopo é novo e o item 9 do escopo sumiu, **quando** a carga roda, **então** há exatamente um `item_atualizado` (item 7, `campos_alterados = {valor_total_estimado}`, `data_fonte` = `dataAtualizacao` do item), um `item_detectado` (item 8) e um `item_removido` (item 9); e o item com `grupoContratacaoCodigo = "158141-5/2026"` é gravado com esse valor literal, enquanto o item sem o campo fica com `grupo_contratacao_codigo` nulo | Deno `sync_pncp_pca_fila_test.ts` (0056 CA-6) |
| CA-7 | K-3, K-4 | **Dado** um item cuja classe passa de 7830 (escopo) para 7520 (fora), e outro que passa de fora para 7830, **quando** a carga roda, **então** sai `saiu_escopo` para o primeiro e `entrou_escopo` para o segundo; e, no mesmo plano, um item de serviço com classe "09" e um item de material com classe "Não se aplica." (casos reais de 11/11/2026) não fazem o plano falhar: o primeiro fica fora do escopo, o segundo vira "classe desconhecida" com o valor original guardado, e nenhum dos dois gera `item_removido` | Deno `sync_pncp_pca_fila_test.ts` (0056 CA-7, regressão dos 39 planos em erro) |
| CA-8 | K-5 | **Dado** a consulta `/v1/pca/` respondendo 503 em todas as tentativas (o incidente de 07/11), **quando** os crons do dia rodam, **então** a rotina `impressao` lê os órgãos conhecidos e enfileira os planos alterados normalmente | Deno `sync_pncp_pca_impressao_test.ts` (0056 CA-8, regressão do incidente de 07/11) |
| CA-9 | K-2, K-5 | **Dado** uma chamada a `sync-pncp-pca` com `rotina = "impressao"` ou `"descoberta"` sem o token de cron (anônima ou com JWT de usuário), **quando** chega à função, **então** recebe 401 e nada é gravado | Deno `sync_pncp_pca_impressao_test.ts` (0056 CA-9) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration` (via `/implement`) | skill `validar-migrations` + `supabase/tests/pca_impressao_plano_check.sql` | `revisor-migration` + `revisor-seguranca` (ACL) + `revisor-codigo` | skill `verificar-producao` + `get_advisors` (security); crons ativos conferidos |
| K-2 | `/spec` | `/implement` (TDD) | Deno `sync_pncp_pca_impressao_test.ts` | `revisor-codigo` + `revisor-seguranca` (auth de cron, `service_role`) | skill `verificar-producao`: execuções `pca` com registros recebidos |
| K-3 | `/spec` | `/implement` | Deno `sync_pncp_pca_fila_test.ts` | `revisor-codigo` | skill `verificar-producao`: fila sem erro novo |
| K-4 | `/spec` | `/implement` | Deno `sync_pncp_pca_fila_test.ts` | `revisor-codigo` | skill `verificar-producao`: eventos por tipo no primeiro dia |
| K-5 | `/spec` | `/implement` + skill `nova-migration` (crons) | Deno `sync_pncp_pca_impressao_test.ts` | `revisor-codigo` + `revisor-migration` | skill `verificar-producao` |

## Fora de escopo

- Ligar plano e compra pelo `grupo_contratacao_codigo` (é a 0013; esta spec só grava o campo).
- Mostrar os eventos na tela (Sala de agentes, radar do PCA, hierarquia órgão / UASG / futura contratação): specs
  próprias depois desta.
- Baixar o CSV do órgão (`/v1/orgaos/{cnpj}/pca/{ano}/csv`): decidido em 11/11/2026 (P-2) que não entra.
- PCA de anos anteriores a 2026 e a tabela `pca_historico_orgao_ano`.
- Ranking de órgãos como lista de acompanhamento (etapa 2 de `TRILHAS-E-INFORME.md`).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_pca_impressao_eventos.sql`. Aditiva e idempotente: tabela nova,
  colunas novas com `add column if not exists`, `check` do `evento` dentro de `do $$ ... if not exists`, crons por
  `cron.unschedule`/`cron.schedule` condicionais.
- **Tabelas/views/funções tocadas:** `private.pca_impressao_plano` (nova; escreve e lê `sync-pncp-pca`);
  `public.pca_alteracoes` (colunas novas; escreve `sync-pncp-pca`; lê `api-pncp-pca`, que não muda);
  `public.pca_itens` (colunas novas; escreve `sync-pncp-pca`; lê `link-pca-edital` depois da 0013);
  `private.pca_plano_fila` (novo motivo `impressao`); `cron.job` (crons do PCA).
- **ACL/RLS:** tabela nova com RLS ligada sem policy; `revoke all` de `anon`, `authenticated`, `PUBLIC`; grant só a
  `service_role`. Colunas novas herdam a ACL das tabelas.
- **Backfill/reprocessamento:** a primeira rotina `impressao` lê os 329 órgãos conhecidos e enfileira os planos cuja
  data mudou desde a última carga (a contagem sai no PR, por dry-run somente leitura). `grupo_contratacao_codigo` só
  é preenchido quando o plano for recarregado; a recarga única dos 946 planos (P-5) roda depois do merge, em fatias, e o PR traz o plano dela. Os 200 itens em `erro` da fila
  voltam pela impressão se o plano mudou; os outros ficam como estão.
- **Edge Functions republicadas no merge:** todas (regra do repositório); muda o comportamento de `sync-pncp-pca`.
- **Contrato com o Dashboard:** inalterado. Os eventos novos ainda não aparecem em tela.
- **Dado oficial x derivado:** quantidade, valor, datas, `grupoContratacaoCodigo` e classe do item são da fonte
  (PNCP), gravados como vieram; o tipo do evento e os campos alterados são derivados pela comparação, com regra
  testada. Nenhum valor inventado.

## Decisões do Marcelo

- 10/11/2026: tratar o PCA por camadas: primeiro saber se o plano mudou, só depois ler os itens.
- 10/11/2026: os eventos têm nome de negócio: "PCA novo", "item detectado", "item atualizado".
- 11/11/2026: os eventos alimentam a atividade da Sala de agentes, só na tela (`TRILHAS-E-INFORME.md`, P-1 e P-1b).
- 11/11/2026 (P-1): `ESCOPO.md` em revisão e regra de foco suspensa; esta spec alimenta a etapa 1 de
  `TRILHAS-E-INFORME.md` e não fica `parada`.
- 11/11/2026 (P-2): sem CSV. A camada 2 é a leitura por plano (`/itens`), a única com data da fonte por item.
- 11/11/2026 (P-3): os 140 "erros na gravação em lote" são diagnosticados dentro desta spec, como primeiro passo do
  `/implement`; a causa vira CA de regressão antes do código novo.
- 11/11/2026 (P-4): plano que some da lista do órgão gera `pca_removido` "a confirmar" e não inativa itens; só inativa
  se continuar fora em duas leituras diárias seguidas.
- 11/11/2026 (P-5): recarga única dos 946 planos de 2026 depois do merge, em fatias, para preencher
  `grupo_contratacao_codigo`.
- 11/11/2026 (P-6): primeiro investigar a causa; se for erro da administração, o item vira "classe desconhecida"; se
  for erro nosso, ajustar o modelo. A investigação do mesmo dia achou os dois (ver "Problema"): a regra passa a aceitar
  o código de serviço de 2 a 4 dígitos (erro nosso) e trata o resto como "classe desconhecida" (erro da
  administração), conforme K-3 e CA-7.

## Perguntas em aberto

- Nenhuma (P-1 a P-6 respondidas em 11/11/2026, ver "Decisões do Marcelo").
