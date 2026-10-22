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
| 9 | `docs/compras-gov/schemas-consultas.md` e `docs/pncp/openapi/compras-dadosabertos-v3-api-docs-2026-10-09.json` (`VwFtPNCPCompraItemDTO`) | campos `numeroGrupo`, `criterioJulgamentoNome`, `tipoBeneficioNome` |
| 9 | `docs/pncp/schemas-consultas-pncp.md` e `docs/pncp/openapi/pncp-consulta-v3-api-docs-2026-10-09.json` | confirmar que o item do PNCP não tem grupo |

Leitura de referência (o caso real): Claude Doc "Pregão 29/2026 PM-SP (15º BAEP)", aba "Leitura do agente de Edital",
https://claude.ai/artifact/SDP2jXTmBxKkPjdbWLpmHa, e o PDF do edital da 2430 (62 páginas, 263 trechos indexados).

## Problema

1. **O certame não aparece por grupo.** A 2430 tem 2 grupos (itens 1 a 4 e 5 a 8, edital p. 6 e 7). A tela de
   oportunidade e o detalhe mostram os 8 itens soltos. Causa conferida no OpenAPI oficial (09/10/2026): o item do PNCP
   não tem campo de grupo. Só o item do Compras.gov.br Dados Abertos (`VwFtPNCPCompraItemDTO`, endpoint
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
| K-1 | Migration: tabela `public.licitacao_itens_compras_gov` (item como o Compras.gov.br publica) | `licitacao_id`, `id_compra`, `id_compra_item`, `numero_item`, `numero_grupo` (null quando o certame não tem grupo), `criterio_julgamento_nome`, `tipo_beneficio_nome`, `situacao_compra_item_nome`, `cod_item_catalogo`, `descricao_resumida`, `quantidade`, `valor_unitario_estimado` (null quando 0 ou ausente), `data_atualizacao_pncp`, `raw`, `payload_hash`, `coletado_em` | chave `(licitacao_id, numero_item)` | — | escrita só `service_role`; leitura só por Edge Function (RLS ligada, sem policy, `revoke all`) |
| K-2 | Migration: tabela `public.pipeline_oportunidade_escopo` | `tenant_id`, `licitacao_id`, `numero_grupo` ou `numero_item` (um dos dois), `criado_por`, `criado_em` | escopo da empresa no certame | — | só `service_role` via `api-pipeline` (RLS ligada, sem policy) |
| K-3 | Coletor `compras_itens_oportunidade` (Cloud Run Job) | licitações `leads` e `monitorar` com `link_sistema_origem` do Compras.gov.br (id da compra = parâmetro `compra=`) | upsert em K-1 com o `GET 2.1_consultarItensContratacoes_PNCP_14133_Id?tipo=idCompra&codigo=<id>` | HTTP ≠ 200, JSON fora do contrato e erro de gravação contam como falha e não gravam nada. Resposta vazia grava "não encontrada" e não apaga dado anterior | Job |
| K-4 | `api-dashboard-oportunidades` `action=get` | `id` | campos novos `fonte_itens` (`compras_gov` \| `pncp` \| `indisponivel`), `itens_consultado_em` e `grupos`: `[{numero_grupo, itens: [numero_item], valor_estimado_total, criterio_julgamento, tipo_beneficio}]` ou `null` quando a fonte não publica grupo | falha de leitura de K-1 vira `fonte_itens = indisponivel`, nunca grupo vazio | membro do tenant |
| K-5 | `api-pipeline` `action=pipeline_adicionar` (e `pipeline_escopo_salvar` para trocar depois) | `licitacao_ids` e, por licitação, `grupos: int[]` ou `itens: int[]` opcionais | escopo gravado em K-2 e um evento em `pipeline_historico` | 400 para grupo ou item que não existe em K-1 ou PNCP; 400 com `grupos` em certame sem grupo; 403 para outro tenant | membro do tenant |
| K-6 | `api-agentes` `analise_executar` com escopo | escopo de K-2 | aderência e preço só sobre os itens do escopo; achados de edital continuam do documento inteiro; achado de item traz `numero_item` e `numero_grupo` | — | admin e operação do tenant |
| K-7 | Agente de Edital: regras novas (`REGRA_VERSAO` sobe) | trechos indexados, itens de K-1 e `catmat_itens` | `participacao.exclusiva_me_epp`, `exigencia.registro_conselho`, `exigencia.atestado_limite_tempo`, `exigencia.laudo_norma`, `exigencia.indices_contabeis`, `exigencia.garantia_pecas`, `catmat.divergente` (por item) e `prazo.impugnacao` a partir da data da sessão lida no edital (natureza `inferencia`, com o trecho). Ajuste: `exigencia.laudo_certificacao` deixa de casar com cláusula ambiental | — | — |
| K-8 | Agente Jurídico: mapa novo | sinais de K-7 | `exigencia.atestado_limite_tempo` → art. 67 (§ 2º), `impugnacao`; `exigencia.registro_conselho` → art. 67, `pedido_esclarecimento`; `exigencia.laudo_norma` → art. 42, `nenhuma`; `participacao.exclusiva_me_epp` → art. 4º, `nenhuma`; `catmat.divergente` → art. 164, `pedido_esclarecimento` | dispositivo ausente em `norma_dispositivos` sai em `dispositivos_ausentes`, como hoje | — |
| K-9 | Dashboard: detalhe e "Enviar para pipeline" | K-4 e K-5 | itens agrupados por grupo, com subtotal, critério, benefício e a fonte ("Compras.gov.br" ou "PNCP, alternativa"); o envio pede o grupo (ou os itens, quando o julgamento é por item); sem item, estado vazio, nunca item de demonstração | erro de K-4 mostra estado de erro | membro do tenant |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-3 | **Dado** a resposta do endpoint 2.1 da compra 18017805000292026 (fixture gravada da API real, com `numeroGrupo`), **quando** o coletor roda, **então** grava 8 linhas em K-1, itens 1 a 4 no grupo 1 e 5 a 8 no grupo 2. Resposta vazia grava "não encontrada" e mantém as linhas anteriores. HTTP 503 conta falha e não grava nada | pytest `services/coletor-externo/tests/test_compras_itens_oportunidade.py` |
| CA-2 | K-4 | **Dado** a 2430 com K-1 preenchida, **quando** o Dashboard chama `get`, **então** `fonte_itens = compras_gov` e `grupos` tem 2 entradas com os itens e o total de cada grupo somado de K-1 | Deno `tests/supabase/functions/api_dashboard_oportunidades_grupos_test.ts` |
| CA-3 | K-4 | **Dado** uma licitação sem linha em K-1 (portal não é o Compras.gov.br), **quando** chama `get`, **então** `fonte_itens = pncp` e `grupos = null`. Com erro de leitura de K-1, `fonte_itens = indisponivel`. Nenhum grupo é inventado | Deno, mesmo arquivo |
| CA-4 | K-2, K-5 | **Dado** a 2430, **quando** um membro envia ao pipeline com `grupos: [1]`, **então** K-2 tem o grupo 1 e o histórico registra o escopo. Com `grupos: [3]` responde 400. Usuário de outro tenant recebe 403 | Deno `tests/supabase/functions/api_pipeline_test.ts` + SQL `supabase/tests/pipeline_oportunidade_escopo_check.sql` (ACL e RLS) |
| CA-5 | K-6 | **Dado** a 2430 com escopo só no grupo 1, **quando** "Analisar" roda, **então** aderência e preço avaliam só os itens 1 a 4, e os achados de edital continuam vindo do documento inteiro | Deno `tests/supabase/functions/api_agentes_test.ts` (0036 CA-5) |
| CA-6 | K-7, K-8 | **Dado** o texto real da 2430, **quando** o agente de Edital roda, **então** gera `participacao.exclusiva_me_epp` (p. 2), `exigencia.registro_conselho` (p. 41), `exigencia.atestado_limite_tempo` (p. 42) e `exigencia.laudo_norma` (p. 42), cada um com trecho e página. O jurídico liga o atestado ao art. 67 com peça `impugnacao` | Deno `tests/supabase/functions/agentes_edital_test.ts` + `agentes_juridico_test.ts` |
| CA-7 | K-7 | **Regressão:** **dado** a cláusula 4.1.5 da 2430 (Inmetro, sustentabilidade), **quando** o agente roda, **então** `exigencia.laudo_certificacao` não cita esse trecho. **Dado** a data da sessão na p. 1, **então** sai `prazo.impugnacao` com a data limite e o trecho | Deno `agentes_edital_test.ts` |
| CA-8 | K-7 | **Dado** os itens da 2430 e os códigos do TR, **quando** a regra `catmat.divergente` roda, **então** marca os itens 3, 4 e 7 e não marca os itens 2 e 6. Cada achado traz o texto do TR, a descrição do código e o termo que diverge | Deno `agentes_edital_test.ts` |
| CA-9 | K-9 | **Dado** a resposta de `get` da 2430 com grupos, **quando** o detalhe abre no modo `supabase`, **então** mostra os itens em 2 grupos com subtotal e a fonte. O "Enviar para pipeline" oferece os grupos. Com `items` vazio, mostra estado vazio e nenhum texto dos itens de demonstração | vitest `src/test/detalhe-grupos.test.tsx` + `detalhe-sem-mock.test.tsx` |

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

- **Migration:** sim, duas tabelas novas (K-1 e K-2), aditivas e idempotentes.
- **Tabelas tocadas:**
  - `licitacao_itens_compras_gov`: escrita pelo coletor, lida por `api-dashboard-oportunidades`, `api-pipeline` e `api-agentes`.
  - `pipeline_oportunidade_escopo`: escrita e lida por `api-pipeline`, lida por `api-agentes`.
- **ACL/RLS:** RLS ligada nas duas, sem policy, `revoke all` de `anon` e `authenticated`, grant para `service_role`.
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

## Perguntas em aberto

1. Certame julgado por item, sem grupo: a escolha no pipeline é por item? Recomendo que sim, com "todos" como padrão.
2. Trocar o escopo depois de entrar no pipeline: pode, com evento no histórico? Recomendo que sim.
3. Achado de edital (documento inteiro) também deve ser filtrado por grupo quando o trecho cita o item? Recomendo que
   não nesta spec: só aderência, preço e `catmat.divergente` seguem o escopo.
4. Formato da tela (K-9): você aprova por print antes da implementação, como na 0035?
5. Rede: o Job no Cloud Run já chama `dadosabertos.compras.gov.br` para preço. Este ambiente não alcança o host, então a
   fixture do CA-1 precisa ser gravada por você ou pelo Job.
