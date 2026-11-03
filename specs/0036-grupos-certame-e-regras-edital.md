# 0036: Tratar o certame por grupo com dado do Compras.gov.br e completar as regras do agente de Edital

- **Status:** rascunho
- **Alimenta:** spec-mãe 0032, fase 3 (conteúdo: regras do edital e da aderência; CA-5 da 0032, restrições de
  participação por lote). Também o módulo 2 do `docs/produto/ESCOPO.md` (pipeline), porque a escolha do grupo nasce
  no "Enviar para pipeline".
- **Repositório:** os dois. O backend vai ao ar antes do front.
- **Issue:** nenhuma. Pedido do Marcelo em 22/10/2026, na thread da leitura do Pregão 29/2026 PM-SP (licitação 2430).
- **Área:** coletor | migrations | edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim. Há migration, decisão de produto e mudança de tela.

## Leitura obrigatória antes de implementar

Os itens 1 a 4 e 10 do template valem como estão. Arquivos específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` | fase 3 e CA-5 (restrições por lote) |
| 5 | `specs/0035-agentes-na-rota-propria.md` | onde os achados aparecem e como são revisados |
| 7 | `.claude/rules/coletor.md`, `python-ingestion.md`, `database-migrations.md`, `edge-functions.md`, `tests.md` | convenções das áreas |
| 8 | `services/coletor-externo/coletor/compras_itens_contratacao.py` | já chama o endpoint 2.1 de itens do Compras.gov.br (só para preço); reaproveitar cliente, retry e regra de duplicata |
| 8 | `services/coletor-externo/coletor/pncp.py` | de onde vêm hoje os itens da oportunidade (`licitacao_itens`) |
| 8 | `supabase/functions/api-dashboard-oportunidades/README.md` e `acompanhamento.ts` | contrato do `get` e da lista de itens do detalhe |
| 8 | `supabase/functions/api-pipeline/README.md`, `index.ts`, `repo.ts` | `pipeline_adicionar` |
| 8 | `supabase/functions/_shared/agentes/edital.ts`, `juridico.ts`, `aderencia.ts`, `preco.ts` e `api-agentes/repo.ts` | regras atuais e o `data_abertura: null` |
| 8 | Dashboard `src/components/opportunities/OpportunityDetailView.tsx` e `src/test/detalhe-sem-mock.test.tsx` | tabela de itens do detalhe e o teste de "sem mock" |
| 8 | `/mnt/project-files/knowledge/claude/dicionario-aparelhos-v0.1.md` | vocabulário de tipo de aparelho para a regra de divergência TR × CATMAT |
| 9 | `docs/pncp/openapi/compras-dadosabertos-v3-api-docs-2026-10-09.json` (`VwFtPNCPCompraItemDTO`, endpoint 2.1, `tipo` = `idCompra` ou `numeroControlePNCPCompra`) | campos `numeroGrupo`, `numeroItemCompra`, `numeroItemPncp`, `criterioJulgamentoNome`, `tipoBeneficioNome`, `orcamentoSigiloso`. O `docs/compras-gov/schemas-consultas.md` ainda não documenta esse endpoint: K-3 inclui essa atualização |
| 9 | `docs/pncp/openapi/pncp-integracao-v3-api-docs-2026-10-09.json` (`RecuperarCompraItemSigiloDTO`, endpoint `/api/pncp/v1/.../itens` usado em `pncp.py`) | confirmar que o item do PNCP não tem grupo |

Leitura de referência (o caso real): Claude Doc "Pregão 29/2026 PM-SP (15º BAEP)", aba "Leitura do agente de Edital",
https://claude.ai/artifact/SDP2jXTmBxKkPjdbWLpmHa, e o PDF do edital da 2430 (62 páginas, 263 trechos indexados).

## Problema

1. **O certame não aparece por grupo.** A 2430 tem 2 grupos (itens 1 a 4 e 5 a 8, edital p. 6 e 7). A tela de
   oportunidade e o detalhe mostram os 8 itens soltos. Causa conferida no OpenAPI oficial (09/10/2026): o item do PNCP
   (`RecuperarCompraItemSigiloDTO`, em `pncp-integracao-v3`) não tem campo de grupo. Só o item do Compras.gov.br Dados Abertos (`VwFtPNCPCompraItemDTO`, endpoint
   `2.1_consultarItensContratacoes_PNCP_14133_Id`) tem `numeroGrupo`. Em 22/10/2026, nenhum dos 213.632 itens de
   `licitacao_itens` tem grupo no `raw`.
2. **A fonte é o PNCP mesmo quando o portal é o Compras.gov.br.** Isso contraria o `AGENTS.md` (o portal oficial é a
   fonte primária). Em 22/10/2026 havia 172 de 761 `leads` e 158 de 734 `monitorar` com link de origem do
   Compras.gov.br. Os itens da 2430 estão sem `catalogo_codigo_item`. Os códigos só aparecem no TR (p. 20 e 21).
3. **O pipeline guarda a licitação inteira.** `pipeline_oportunidades` não tem escolha de grupo ou item. No
   Compras.gov.br o lance é por grupo, e quem entra no grupo cota todos os itens dele.
4. **O agente de Edital deixou passar o essencial da 2430.** Ele gravou 6 achados em 22/10/2026 às 04h22 UTC. Ficaram
   de fora a exclusividade de ME/EPP (3.5.1, p. 2), o CREA/CAU com CAT (8.23, p. 41), o atestado limitado a 5 anos
   (8.26.3, p. 42, contra o art. 67, § 2º), o laudo ISO 20957 classe S (8.30, p. 42) e as divergências entre TR e
   CATMAT dos itens 3, 4 e 7. O achado `exigencia.laudo_certificacao` citou a cláusula ambiental do Inmetro (4.1.5,
   p. 24): é falso positivo. O `prazo.impugnacao` não saiu, porque `api-agentes/repo.ts` passa `data_abertura: null`
   por falta de data inequívoca da sessão. O edital traz a data na p. 1 ("DATA E HORA DA ABERTURA DA SESSÃO PÚBLICA:
   22/10/2026 às 09h00min").
5. **O detalhe tem itens de demonstração no código.** Em `OpportunityDetailView.tsx` (linha 461 na `main` de
   22/10/2026), a tabela usa dois itens fixos de "Aparelho Ginástica Ar Livre" quando `opportunity.items` está vazio.
   Não medi se esse caminho é alcançado no modo `supabase`.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: duas tabelas espelho do Compras.gov.br. **`public.compras_gov_compras_oportunidade`**, uma linha por licitação consultada: `licitacao_id`, `id_compra`, `numero_controle_pncp`, `encontrada` (bool), `consultado_em`, `ultimo_erro`, `itens_ausentes_na_fonte`. **`public.licitacao_itens_compras_gov`**, uma linha por item: `licitacao_id`, `id_compra`, `id_compra_item`, `numero_item_compra`, `numero_item_pncp` (pode ser null), `numero_grupo` (null quando a fonte não traz grupo ou traz 0), `criterio_julgamento_nome`, `tipo_beneficio_nome`, `situacao_compra_item_nome`, `orcamento_sigiloso`, `cod_item_catalogo`, `descricao_resumida`, `quantidade`, `valor_unitario_estimado` (null quando 0 ou ausente), `data_atualizacao_pncp`, `ausente_na_fonte` (bool), `raw`, `payload_hash`, `coletado_em` | chaves: `licitacao_id` na primeira; `(licitacao_id, numero_item_compra)` na segunda | — | escrita só por `service_role`, leitura só por Edge Function: RLS ligada, sem policy, `revoke all` de `anon` e `authenticated` |
| K-2 | Migration: tabela `public.pipeline_oportunidade_escopo` e coluna `escopo jsonb` em `pipeline_historico` | `tenant_id`, `licitacao_id`, `numero_grupo` ou `numero_item_pncp` (exatamente um), `criado_por`, `criado_em`. Chave única `(tenant_id, licitacao_id, coalesce(numero_grupo,-1), coalesce(numero_item_pncp,-1))`. Escopo e evento gravados pela mesma função SQL, na mesma transação da entrada no pipeline | sem linha = escopo "todos os itens"; `pipeline_remover` apaga o escopo do tenant junto | — | só `service_role` via `api-pipeline`: RLS ligada, sem policy |
| K-3 | Coletor `compras_itens_oportunidade` (Cloud Run Job), reaproveitando o cliente, o retry e a `escolher_linhas` de `compras_itens_contratacao.py` | licitações `leads` e `monitorar` com portal Compras.gov.br. Chamada: `GET /modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id?tipo=numeroControlePNCPCompra&codigo=<codigo_externo>`. Sem `codigo_externo`: `tipo=idCompra` com o `compra=` do link | Dedup de várias linhas por item: fica uma linha por `numeroItemCompra` (regra da `escolher_linhas`), e linhas repetidas com `numeroGrupo` diferente contam como falha da compra. Upsert idempotente em K-1. Item que some de uma resposta não vazia vira `ausente_na_fonte = true` e nunca é apagado. O doc `docs/compras-gov/schemas-consultas.md` ganha o endpoint 2.1 e os campos usados | HTTP ≠ 200, JSON fora do contrato e erro de gravação: grava só `ultimo_erro` e `consultado_em` na tabela de compras e não toca os itens. Resposta vazia: `encontrada = false`, sem apagar item anterior | Job |
| K-4 | `api-dashboard-oportunidades` `action=get`, nas três formas de busca (`id`, `codigo_externo` e órgão + processo; em `items[]`, campo por entrada) | a licitação | Campos novos e opcionais: `fonte_itens` com cinco valores: `compras_gov` (encontrada), `pncp` (portal não é o Compras.gov.br), `nao_consultada`, `nao_encontrada` e `indisponivel` (último erro ou falha de leitura). Também `itens_consultado_em` e `grupos`: `[{numero_grupo, itens_pncp: [numero_item_pncp], itens_sem_numero_pncp, valor_estimado_total, itens_sem_estimado, criterio_julgamento, tipo_beneficio}]`, ou `null` quando nenhum item tem grupo. Total do grupo = soma de `round(quantidade × unitário, 2)` (meio para cima, em centavos), `null` se algum item não tem estimado ou é sigiloso. Certame misto: itens sem grupo saem num grupo `numero_grupo: null`. O front casa os itens do `acompanhamento` (PNCP) por `numero_item_pncp` | falha de leitura vira `indisponivel`, nunca `grupos: []` | qualquer usuário autenticado, como o `get` de hoje (`requireUserAuth`) |
| K-5 | `api-pipeline` `action=pipeline_adicionar` (novo campo opcional `escopos: [{licitacao_id, grupos?: int[], itens?: int[]}]`) e `action=pipeline_escopo_salvar` `{licitacao_id, grupos?, itens?}` | Validação contra K-1 (ou contra os itens do PNCP quando não há K-1). Lote atômico: um escopo inválido recusa a chamada inteira. Se a licitação já estiver no pipeline, `pipeline_adicionar` não muda o escopo; para mudar, `pipeline_escopo_salvar` | escopo em K-2 e evento em `pipeline_historico` com `escopo` | 400: grupo ou item inexistente, ou `grupos` em certame sem grupo. 404: `pipeline_escopo_salvar` em licitação fora do pipeline do tenant de quem chama (o escopo de outro tenant fica intacto). 403: conta sem vínculo, como hoje | membro do tenant |
| K-6 | `api-agentes` `analise_executar` | escopo de K-2 do tenant (sem linha = todos os itens) | aderência, preço e `catmat.divergente` só sobre os itens do escopo; os achados de edital continuam do documento inteiro; achado de item traz `numero_item_pncp` e `numero_grupo` | — | admin e operação do tenant |
| K-7 | Agente de Edital, regras novas (`REGRA_VERSAO` sobe) | trechos indexados, itens de K-1 (ou do PNCP) e `catmat_itens`. O código do item vem de K-1 (`cod_item_catalogo`), depois de `licitacao_itens.catalogo_codigo_item`. Sem nenhum dos dois, a regra lê o código na tabela do TR (natureza `inferencia`, com o trecho). O vocabulário de tipo de aparelho vai versionado no repositório, em `supabase/functions/_shared/agentes/vocabulario-aparelhos.ts`, derivado do `dicionario-aparelhos-v0.1` | Achados novos: `participacao.exclusiva_me_epp` (fato quando vem do `tipo_beneficio_nome` de K-1; inferência quando vem do texto), `exigencia.registro_conselho`, `exigencia.atestado_limite_tempo`, `exigencia.laudo_norma`, `exigencia.indices_contabeis`, `exigencia.garantia_pecas`, `catmat.divergente` (um por item) e `julgamento.criterio_divergente` (critério do edital × `criterio_julgamento_nome` de K-1, com o trecho; o edital prevalece). O `prazo.impugnacao` passa a usar a data da sessão lida no edital e continua `natureza: "analise"`, com o trecho como fonte. Ajuste: `exigencia.laudo_certificacao` deixa de casar com cláusula ambiental | sem data da sessão no texto: nenhum `prazo.impugnacao` | — |
| K-8 | Agente Jurídico, mapa novo em `MAPA_SINAL_DISPOSITIVO` | sinais de K-7 | `exigencia.atestado_limite_tempo` → art. 67, peça `impugnacao`; `exigencia.registro_conselho` → art. 67, `pedido_esclarecimento`; `exigencia.laudo_norma` → art. 42, `nenhuma`; `exigencia.indices_contabeis` → art. 69, `nenhuma`; `participacao.exclusiva_me_epp` → art. 4º, `nenhuma`; `catmat.divergente` → art. 164, `pedido_esclarecimento`. `exigencia.garantia_pecas` fica sem artigo (achado só informativo do edital). Como hoje, um achado jurídico por código, com as fontes de todos os itens divergentes | dispositivo ausente em `norma_dispositivos` sai em `dispositivos_ausentes`, como hoje | — |
| K-9 | Dashboard: detalhe e "Enviar para pipeline" | K-4 e K-5 | itens agrupados por grupo, com subtotal (ou "total parcial" ou "sigiloso"), critério, benefício e a fonte ("Compras.gov.br" ou "PNCP, alternativa"). Estados explícitos para não consultada, não encontrada e indisponível. O envio pede a unidade do julgamento do edital (decisão 1): grupo, item ou a licitação inteira. Sem item: estado vazio, nunca item de demonstração | erro de K-4 mostra estado de erro | membro do tenant |

## Critérios de aceite

Os textos públicos da 2430 usados nos testes ficam em `tests/supabase/fixtures/edital_2430_trechos.json` (trechos e páginas do PDF). A resposta da API 2.1 fica em `services/coletor-externo/tests/fixtures/compras_2_1_compra_2430.json`.

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-3 | **Dado** a fixture da 2.1 da 2430 (resposta real, com `numeroGrupo` e um item repetido com estimado 0), **quando** o coletor roda, **então** grava 8 itens: 1 a 4 no grupo 1 e 5 a 8 no grupo 2. A linha repetida é deduplicada pela regra da `escolher_linhas`. Rodar de novo não duplica. Resposta vazia grava `encontrada = false` e mantém os itens. HTTP 503 grava só `ultimo_erro`. Item que some vira `ausente_na_fonte` | pytest `services/coletor-externo/tests/test_compras_itens_oportunidade.py` |
| CA-2 | K-4 | **Dado** a 2430 com K-1 preenchida, **quando** o Dashboard chama `get` (por `id` e por `codigo_externo`), **então** `fonte_itens = compras_gov` e `grupos` tem 2 entradas com `itens_pncp` e o total de cada grupo pela regra de arredondamento. Com um item sem estimado, o total do grupo é `null` e `itens_sem_estimado = 1` | Deno `tests/supabase/functions/api_dashboard_oportunidades_grupos_test.ts` |
| CA-3 | K-4 | **Dado** cada um dos cinco estados (portal de outro sistema, não consultada, não encontrada, último erro, falha de leitura), **quando** chama `get`, **então** `fonte_itens` vale, nessa ordem, `pncp`, `nao_consultada`, `nao_encontrada`, `indisponivel` e `indisponivel`, sempre com `grupos = null`. Nenhum grupo é inventado | Deno, mesmo arquivo |
| CA-4 | K-2, K-5 | **Dado** a 2430, **quando** um membro do tenant A envia ao pipeline com `grupos: [1]`, **então** K-2 tem o grupo 1 e o evento do histórico traz o escopo, na mesma transação. `grupos: [3]` responde 400 e não grava nada no lote. O tenant B, com `pipeline_escopo_salvar` na 2430 (que está só no pipeline de A), recebe 404, e o escopo de A fica igual. `anon` e `authenticated` não leem K-1 nem K-2 | Deno `tests/supabase/functions/api_pipeline_test.ts` + SQL `supabase/tests/pipeline_oportunidade_escopo_check.sql` |
| CA-5 | K-6 | **Dado** a 2430 com escopo só no grupo 1, **quando** "Analisar" roda, **então** aderência, preço e `catmat.divergente` avaliam só os itens 1 a 4, e os achados de edital continuam do documento inteiro. Sem escopo (pipeline de hoje), avaliam os 8 itens | Deno `tests/supabase/functions/api_agentes_test.ts` (0036 CA-5) |
| CA-6 | K-7, K-8 | **Dado** os trechos da 2430, **quando** o agente de Edital roda, **então** gera os seis achados novos, cada um com trecho e página: `participacao.exclusiva_me_epp` (p. 2), `exigencia.registro_conselho` (p. 41), `exigencia.atestado_limite_tempo` (p. 42), `exigencia.laudo_norma` (p. 42), `exigencia.indices_contabeis` (p. 40) e `exigencia.garantia_pecas` (p. 32). **Quando** o jurídico roda, **então** cada um que está no mapa de K-8 sai com o artigo e a peça | Deno `tests/supabase/functions/agentes_edital_test.ts` + `tests/supabase/functions/agentes_juridico_test.ts` |
| CA-7 | K-7 | **Regressão:** **dado** a cláusula 4.1.5 da 2430 (Inmetro, sustentabilidade), **quando** o agente roda, **então** `exigencia.laudo_certificacao` não cita esse trecho. **Dado** a data da sessão na p. 1, **então** sai `prazo.impugnacao` (`natureza: "analise"`) com a data limite e o trecho. **Dado** um edital sem data da sessão, **então** não sai `prazo.impugnacao` | Deno `tests/supabase/functions/agentes_edital_test.ts` |
| CA-8 | K-7, K-8 | **Dado** os itens da 2430 com os códigos 480144, 636444, 478756, 480143, 480139, 480248, 442720 e 473444 e as descrições de `catmat_itens`, **quando** a regra `catmat.divergente` roda, **então** marca os itens 3, 4 e 7 e não marca os itens 2 e 6. Cada achado traz o texto do TR, a descrição do código e o termo que diverge. O jurídico gera um único achado com as fontes dos três itens | Deno `tests/supabase/functions/agentes_edital_test.ts` |
| CA-9 | K-9 | **Dado** a resposta de `get` da 2430 com grupos, **quando** o detalhe abre no modo `supabase`, **então** mostra os itens em 2 grupos com subtotal e a fonte, e o "Enviar para pipeline" oferece os grupos. Com `fonte_itens = indisponivel`, mostra o estado de erro. Com `items` vazio, mostra estado vazio e nenhum texto dos itens de demonstração | vitest `src/test/detalhe-grupos.test.tsx` + `src/test/detalhe-sem-mock.test.tsx` (Dashboard) |
| CA-10 | K-5, K-7, K-9 | **Dado** um edital que diz "julgamento por item" e K-1 com `criterio_julgamento_nome` de grupo, **quando** o agente roda, **então** sai `julgamento.criterio_divergente` com o trecho e a página, e o "Enviar para pipeline" oferece itens. Com edital e K-1 dizendo grupo (a 2430), oferece grupos e não sai o achado | Deno `tests/supabase/functions/agentes_edital_test.ts` + vitest `src/test/detalhe-grupos.test.tsx` (Dashboard) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2 | `/spec` | skill `nova-migration` | SQL `_check` | `revisor-migration` + `revisor-seguranca` | skill `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-3 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | `verificar-producao`; deploy do Job pelo Marcelo |
| K-4, K-5, K-6 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` (tenant, `service_role`) | `verificar-producao` |
| K-7, K-8 | `/spec` | `/implement` (TDD) | Deno com o texto real | `revisor-codigo` | `verificar-producao` (rodar "Analisar" na 2430) |
| K-9 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + agente `ux-ui-licitagym` | skill `run-dashboard` antes; `deploy-dashboard` depois |
| Fechamento | — | — | — | — | skill `ciclo-janelas` |

## Fora de escopo

- Outros portais (BEC-SP, Portal de Compras Públicas, Paradigma). Viram spec própria quando houver API pública.
- Porte da empresa pelo CNPJ (segunda metade do CA-5 da 0032). Fica na 0032.
- Proposta por item (marca, modelo e preço): módulo 4 do `ESCOPO.md`.
- Minuta de impugnação ou de recurso: fase 4 da 0032.
- Trocar a fonte de `licitacao_itens` do PNCP. Os itens do PNCP continuam como estão; K-1 fica ao lado, com proveniência.

## Impacto em dados

- **Migration:** sim, três tabelas novas e uma coluna nova em `pipeline_historico` (K-1 e K-2), aditivas e idempotentes.
- **Tabelas tocadas:**
  - `compras_gov_compras_oportunidade` e `licitacao_itens_compras_gov`: escritas pelo coletor, lidas por `api-dashboard-oportunidades`, `api-pipeline` e `api-agentes`.
  - `pipeline_oportunidade_escopo` e a coluna nova `pipeline_historico.escopo`: escritas por função SQL chamada pela `api-pipeline`, lidas por `api-agentes`.
- **ACL/RLS:** RLS ligada nas três, sem policy, `revoke all` de `anon` e `authenticated`, grant para `service_role`.
  Leitura com filtro de tenant em `_shared/tenant.ts`.
- **Backfill:** sim, carga dos `leads` e `monitorar` com link do Compras.gov.br (330 em 22/10/2026). No PR vão a
  contagem antes e depois e a lista de falhas.
- **Edge Functions republicadas no merge:** todas (regra do repositório). As tocadas são `api-dashboard-oportunidades`,
  `api-pipeline` e `api-agentes`.
- **Contrato com o Dashboard:** muda em `get` (campos novos, compatíveis) e em `pipeline_adicionar` (parâmetros
  opcionais). O backend vai ao ar antes do front.
- **Dado oficial × derivado:**
  - Oficiais: grupo, critério, benefício, estimado e código, tal como o Compras.gov.br publica.
  - Derivados: o total do grupo, a divergência TR × CATMAT e o `prazo.impugnacao`, todos marcados como `inferencia`
    ou cálculo, com a fonte.

## Decisões do Marcelo

- 22/10/2026: o certame tem que aparecer por grupo quando tiver grupo, e no pipeline a empresa escolhe o grupo em que
  vai participar. Quando o portal é o Compras.gov.br, o dado vem de lá.
- 22/10/2026: a spec junta os grupos e as lacunas do agente de Edital achadas na leitura da 2430.

- 22/10/2026, respostas às perguntas da spec:
  1. A unidade da escolha no pipeline segue o que o edital diz sobre o julgamento: por grupo, escolhe grupo; por item,
     escolhe item; global, a licitação inteira. O critério vem do `criterio_julgamento_nome` de K-1 e é conferido no
     texto do edital (K-7). Se os dois divergem, prevalece o edital e sai o achado `julgamento.criterio_divergente`.
     Sem nenhum dos dois, a tela não presume: oferece grupo quando há grupo, senão item, com "todos" como padrão.
  2. O escopo pode mudar depois da entrada no pipeline, com evento no histórico (`pipeline_escopo_salvar`).
  3. Os achados de edital continuam sobre o documento inteiro, sem filtro por grupo.
  4. O formato da tela (K-9) é aprovado por print antes da implementação do front.
  5. A fixture do CA-1 é gravada pelo Marcelo com o comando do runbook abaixo.

## Fixture do CA-1 (resposta real da 2.1)

Rodar na raiz do repositório, numa máquina que alcance `dadosabertos.compras.gov.br`:

```bash
mkdir -p services/coletor-externo/tests/fixtures
curl -sS --fail --max-time 60 -G \
  "https://dadosabertos.compras.gov.br/modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id" \
  --data-urlencode "tipo=numeroControlePNCPCompra" \
  --data-urlencode "codigo=46377800000127-1-004311/2026" \
  -o services/coletor-externo/tests/fixtures/compras_2_1_compra_2430.json
```

No Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force services\coletor-externo\tests\fixtures | Out-Null
curl.exe -sS --fail --max-time 60 -o services\coletor-externo\tests\fixtures\compras_2_1_compra_2430.json "https://dadosabertos.compras.gov.br/modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id?tipo=numeroControlePNCPCompra&codigo=46377800000127-1-004311%2F2026"
```

Se voltar vazio, a alternativa é `tipo=idCompra` com `codigo=18017805000292026` (o `compra=` do link da 2430).
