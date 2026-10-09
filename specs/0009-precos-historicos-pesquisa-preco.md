# 0009: Preços históricos e a aba "Inteligência de Preços" a partir da Pesquisa de Preço do Compras.gov

- **Status:** em implementação (backend: CA-1 a CA-6 e CA-9; front: CA-7 e CA-8 no Dashboard)
- **Issue:** nenhuma. Pedido do Marcelo em 09/10: os preços históricos vêm de
  `/modulo-pesquisa-preco/1_consultarMaterial` (via catálogo do tenant), com o detalhe de
  `/modulo-pesquisa-preco/2_consultarMaterialDetalhe`. Eles alimentam a tela "Preços Históricos" e a aba "Inteligência
  de Preços" de `/oportunidades/:id`.
- **Área:** edge-functions, coletor, dashboard-contrato
- **Depende do ok do Marcelo:** sim. Muda uma regra de produto (ver Problema) e cria um agendamento novo.

## Problema

**Na tela.** O Dashboard diz, fora do demo, que "a inteligência de preços ainda não tem fonte de dados real: ela vai
usar uma API autenticada de preços de referência, que ainda não existe". O texto fixo está em
`PriceResearchView.tsx:36` e `PriceAgentView.tsx:34`. A aba do detalhe (`OpportunityDetailRealView.tsx:83-86`) mostra
"Em breve" e manda para `/precos/pesquisa`, que no modo supabase também é uma tela vazia.

**O dado já existe.** Medição em produção (só leitura, 09/10):
- `public.precos_praticados_itens` tem **25.465 preços** de **493 itens de catálogo** (33 PDMs), de 12/2021 a
  10/2026, sendo 6.214 dos últimos 12 meses.
- Todas as linhas têm fornecedor e marca. 25.464 têm objeto da compra e 21.383 têm descrição detalhada.
- Quem grava é `services/coletor-externo/coletor/compras_precos.py`, que chama o `1_consultarMaterial` por PDM a
  partir de `catalogo_catmat_pdms_efetivos()`, isto é, o **catálogo da empresa**.
- Já existe a view `public.v_bi_precos_praticados`, com contagem, mínimo, p25, mediana, p75, máximo e outlier por
  PDM e item. Ela é só `service_role`, e **nenhuma Edge Function a expõe**.

**O que falta:**
- **Agendamento:** a coleta não roda sozinha. A última atualização é de 05/10, rodada à mão. O `main.py` do Cloud Run
  Job não chama `compras_precos`.
- **`2_consultarMaterialDetalhe`:** não é chamado. A coluna `detalhe_sincronizado_em` está zerada.
- **Cruzamento com a oportunidade:**
  - **pelo código do item:** só 10 das 1.656 licitações gravadas têm `catalogo_codigo_item`, e nenhuma bate com a
    tabela de preços. O detalhe busca os itens ao vivo no PNCP (action `acompanhamento`, com `catalogoCodigoItem`), o
    que pode render mais casamentos, mas isso não foi medido;
  - **pelo PDM da aderência** (`licitacao_match.codigo_pdm`): **1.103 das 1.269** licitações com PDM têm preço do
    mesmo PDM.

**Regra de produto que muda.** O `CLAUDE.md` diz: "Preço, marca e fornecedor vêm só de compra homologada e aparecem
só no BI." Mostrar preço, marca e fornecedor na aba da oportunidade e em `/precos` muda essa regra. Ver Perguntas.

## Abordagem

### 1. Backend: Edge Function `api-precos`

`requireUserAuth`, e só então o cliente service_role. Duas actions, ambas só leitura:

- **`resumo`:**
  - **entrada:** `pdm` e/ou `item` (código CATMAT), `desde` (padrão: 24 meses), `uf` opcional;
  - **saída:** as estatísticas de `v_bi_precos_praticados` (ou o mesmo cálculo com o filtro de período) e a unidade de
    fornecimento predominante;
  - a mediana e os quartis são calculados no banco, determinísticos;
  - cada estatística vem com o `n` de cotações;
  - com `n < 3`, a mediana e os quartis vão como `null`, com o motivo, e não aparecem como número.
- **`amostras`:**
  - as linhas de `precos_praticados_itens` do recorte: data do resultado, órgão/UASG, UF, quantidade, preço unitário,
    unidade, marca, fornecedor (nome e CNPJ) e objeto;
  - paginadas e ordenadas por `data_resultado desc`;
  - com o link oficial, se houver padrão documentado de URL de compra. Se não houver, só o identificador
    (`id_compra` e item).

Erros seguem o padrão: parâmetro inválido dá 400, erro de banco dá 500 genérico, nunca lista vazia.

### 2. Backend: coleta agendada

O Cloud Run Job (`coletor.main`) passa a chamar `compras_precos` em modo catálogo, uma vez por semana, com o mesmo
padrão de retry, delay e Retry-After que já existe. A saúde operacional ganha a verificação "última coleta de preço
há mais de 8 dias".

### 3. Detalhe (`2_consultarMaterialDetalhe`)

O `1_consultarMaterial` já traz `objetoCompra` e `descricaoDetalhadaItem`. O `2_` serviria só para completar os
**4.082 preços sem descrição detalhada**, gravando `detalhe_sincronizado_em`. A proposta é deixá-lo como passo
opcional da mesma coleta (ver Perguntas).

### 4. Dashboard

- **`/precos` (Preços Históricos):**
  - busca por PDM ou item **do catálogo da empresa**, com os KPIs de mediana, p25–p75, mín–máx e `n`;
  - tabela de amostras e filtros de período e UF;
  - outlier marcado, nunca escondido em silêncio.
- **Aba "Inteligência de Preços" em `/oportunidades/:id`:**
  - para cada PDM da aderência da oportunidade, mostra o resumo e as últimas amostras;
  - quando o item ao vivo do PNCP tem `catalogoCodigoItem` com preço, mostra o resumo do **mesmo item** primeiro;
  - compara com o valor estimado da oportunidade só quando a unidade de fornecimento for a mesma; se for diferente,
    diz isso e não compara.
- Sai o texto "ainda não tem fonte de dados real". O modo demo continua com os fixtures.

## Critérios de aceite (rascunho, detalhados depois das respostas)

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | Sem JWT, 401 e nenhuma consulta com service_role. | Deno `tests/supabase/functions/api_precos_test.ts` (`CA-1: ...`) |
| CA-2 | `resumo` com `pdm` e `meses` (12 ou 24; outro valor dá 400) devolve n, média, mín, p25, mediana, p75 e máx do período, e a unidade de fornecimento predominante. Com `n < 3`, média e quartis vêm `null`, com o motivo. | idem (`CA-2: ...`), mais `supabase/tests/precos_praticados_resumo_check.sql` |
| CA-3 | `amostras` pagina, ordena por `data_resultado desc` e devolve marca e fornecedor como vieram da API (ausente vira `null`). | idem (`CA-3: ...`) |
| CA-4 | Parâmetro inválido dá 400; erro de banco dá 500 genérico, nunca `[]`. | idem (`CA-4: ...`) |
| CA-5 | A coleta agendada roda `compras_precos` em modo catálogo; o teste unitário não chama a API real. | pytest `services/coletor-externo/tests/test_precos_agendado.py` (`test_ca5_*`) |
| CA-6 | A saúde acusa coleta de preço com mais de 8 dias. | `supabase/tests/saude_coleta_precos_check.sql` |
| CA-7 | `/precos` mostra os KPIs e as amostras do recorte; valor ausente aparece como "—"; n pequeno não mostra mediana. | vitest |
| CA-8 | A aba "Inteligência de Preços" mostra, para cada item da oportunidade com PDM, o valor unitário estimado contra a média, a mediana e o p25–p75 do PDM no período escolhido (12 ou 24 meses), com a diferença em R$ e em %. Com unidade diferente ou `n < 3`, não mostra diferença e diz o motivo. | vitest |
| CA-9 | A coleta completa a descrição detalhada pelo `2_consultarMaterialDetalhe` só nas linhas sem descrição, e marca `detalhe_sincronizado_em`. | pytest `services/coletor-externo/tests/test_precos_agendado.py` (`test_ca9_*`) |

## Fora de escopo

- **IRP** (rota "em breve"): a ingestão `sync-pncp-irp` está bloqueada até a CLA-34 (`IRP_SYNC_ENABLED`). Precisa de
  spec própria.
- **Agente de preços** (`/agentes/precos`) e qualquer preço "de referência" calculado por modelo.
- **Exportação** (Dashboard #50).
- **Tenants por empresa:** hoje o catálogo é global (`catalogo_empresa_catmat`). Quando os tenants forem ligados, a
  consulta passa a filtrar pelo catálogo do tenant.

## Impacto em dados

- **Migration:** provável, só se for preciso uma função de resumo com período (a view atual não filtra data). Seria
  aditiva, com EXECUTE só para service_role.
- **Tabelas:** leitura de `precos_praticados_itens`, `v_bi_precos_praticados` e `licitacao_match`. A coleta continua
  gravando em `precos_praticados_itens`, com a mesma chave.
- **ACL/RLS:** nenhuma mudança nas tabelas. Edge com `requireUserAuth` antes do service_role.
- **Edge Functions:** nova `api-precos`.
- **Contrato com o Dashboard:** novo. O PR do backend vai ao ar antes do front.
- **Dado oficial x derivado:** os preços são homologações oficiais (Compras.gov). Mediana e quartis são derivados,
  com `n`, período e regra de arredondamento escritos.

## Decisões do Marcelo (09/10)

1. **Regra do CLAUDE.md:** a aba e `/precos` mostram tudo (estatísticas, marca, fornecedor com nome e CNPJ, órgão e
   data), sempre com fonte e data. O mesmo PR atualiza a regra no `CLAUDE.md` para "aparecem no BI, em `/precos` e na
   aba Inteligência de Preços, com fonte e data".
2. **Coleta:** Cloud Run Job. `coletor.main` passa a chamar `compras_precos` em modo catálogo. O agendamento no Cloud
   Scheduler é do Marcelo.
3. **`2_consultarMaterialDetalhe`:** só para completar os preços sem descrição detalhada (4.082 em 09/10), gravando
   `detalhe_sincronizado_em`.
4. **Período e comparação:**
   - o período é um **filtro de 12 ou 24 meses**, não um valor fixo;
   - a aba cruza, **item a item**, o **valor unitário estimado do item da oportunidade** (do edital/PNCP, o mesmo
     exibido no detalhamento) com a **média do PDM** no período escolhido;
   - mostra também a mediana e o p25–p75, porque a média sozinha é puxada por outlier, e o `n`;
   - a diferença sai em R$ e em %, com regra de arredondamento escrita (2 casas, meio para longe do zero);
   - **só compara quando a unidade de fornecimento do item bate com a predominante do PDM.** Se não bater, mostra as
     duas unidades e não calcula a diferença, para não inventar comparação.
5. **Catálogo:** com tenants desligados, vale o catálogo global da empresa (`catalogo_catmat_pdms_efetivos()`). Isso
   muda quando os tenants forem ligados.

## Perguntas em aberto

Nenhuma.
