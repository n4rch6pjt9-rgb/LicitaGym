# 0014: BI do PCA: execução por PDM, tendência por UASG e deduplicação PNCP × PGC

- **Status:** rascunho
- **Issue:** #282 (deduplicação PNCP × PGC no `v_bi_pca_radar`); a parte de execução por PDM sai da avaliação de 09/10/2026
- **Área:** migrations (views de BI), pncp, coletor (resultados), dashboard-contrato (`docs/bi-cruzamento-apis.md`)
- **Depende do ok do Marcelo:** sim. Tem migration, cria dado derivado e muda os totais do BI.
- **Depende de:**
  - **0013:** vínculo grupo → compra, situação e `pca_uasg_execucao_diaria`;
  - **0010:** `grupo_contratacao_codigo` e `pdm` gravados em `pca_itens`;
  - **0012:** universo completo de itens.

## Problema

Uma compra já executada de um PDM é histórico de análise: quanto foi planejado, quanto foi licitado, por quanto foi
homologado, quem venceu, com que marca e com quanto atraso em relação ao planejado. Hoje o BI não tem esse histórico.
Também tem um erro conhecido no radar (#282). Medido em 09/10/2026, só leitura e GET público.

- **A ligação pelo identificador (0013) é por grupo, e o item da compra não traz o PDM.** Nos 1.210 grupos com
  identificador válido da varredura 7830/2026:

  | Tipo de grupo | Grupos | Itens do PCA |
  |---|---|---|
  | 1 PDM | 335 | 460 |
  | 1 PDM + itens sem PDM | 28 | 83 |
  | 2 ou mais PDM | 340 | 3.241 |
  | sem PDM | 507 | 742 |

- **Pareamento item do PCA ↔ item da compra, dentro do grupo** (30 grupos casados na base, 93 itens do PCA):

  | Regra | Itens |
  |---|---|
  | mesma quantidade e mesmo valor unitário estimado | 31 (20 com descrição também parecida) |
  | só descrição parecida (Jaccard ≥ 0,5) | 26 |
  | sem par | 36 |

  A amostra é pequena e serve para escolher a regra, não como taxa garantida.
- **Resultado:** só 3 dos 57 itens pareados têm resultado (fornecedor e preço homologado) em `licitacao_resultados` hoje.
- **Exemplo do que se quer medir:** grupo `153063-745/2026`, item 8930, PDM 11503 (rede de esporte): planejado R$ 349,34
  no PCA, homologado R$ 338,57.
- **#282, deduplicação PNCP × PGC no `v_bi_pca_radar`:**
  - o `NOT EXISTS` compara `unidade_codigo` e `numero_item_pncp` com `=`, então uma chave nula não casa e o item conta duas
    vezes;
  - hoje o caso não ocorre, porque `pca_pgc_itens` tem 0 linhas.
  - **Medido em 09/10 no PGC** (`1_consultarPgcDetalhe` e `2_consultarPgcDetalheCatalogo`):
    - o PGC devolve **linhas duplicadas idênticas**: no Galeão, 227 linhas para 141 itens; na classe 7830/2026, 1.714
      linhas para 983 chaves `(orgao, codigoUasg, numeroItemPncp)`;
    - `numeroItemPncp` veio preenchido nas 1.714 linhas;
    - nos 70 órgãos do PGC 7830, o PGC tem 905 dos 3.458 itens que o PNCP mostra.

## Abordagem proposta

1. **Pareamento de itens no grupo vinculado.** Tabela `public.pca_item_compra_item`, idempotente pelo par.
   - **Colunas:** `pca_item_id`, `licitacao_item_id`, `regra`, `confianca`, `similaridade` e `data_referencia`.
   - **Regras, em ordem:**
     1. `qtd_valor` (confiança alta): mesma quantidade e valor unitário estimado com diferença menor que R$ 0,01;
     2. `descricao` (confiança média): semelhança de termos ≥ 0,5, sem acento e sem as palavras de formulário do CATMAT
        ("aplicação", "características adicionais", "tipo", "material"…);
     3. `grupo_pdm_unico` (confiança média): o item não pareou, mas o grupo tem um único PDM. O item é atribuído ao
        grupo e ao PDM, sem `licitacao_item_id`.
   - **Pareamento 1:1:** um item da compra serve a um único item do PCA, e em disputa fica o de maior pontuação.
   - **Sem regra:** um item de grupo com 2 ou mais PDM que não pareou não recebe PDM. Entra só nos totais do grupo e da
     UASG.
2. **Resultados das compras concluídas.** Compra `concluida` (0013) sem linha em `licitacao_resultados` é enfileirada no
   carregador de resultados do coletor, o mesmo das demais compras. Não é coletor novo.
3. **View `public.v_bi_pca_execucao_pdm`.**
   - **Recorte:** uma linha por PDM × UASG × órgão × mês de publicação × regra.
   - **Planejado:** quantidade, valor e valor unitário médio do PCA.
   - **Licitado:** quantidade, valor estimado da compra e número de compras.
   - **Homologado:** quantidade, valor, valor unitário mediano e variação do homologado sobre o planejado (em %).
   - **Vencedores:** fornecedores e marcas (top 3 por valor), de `licitacao_resultados`.
   - **Prazo:** mediana de `dias_desejada_ate_publicacao` (0013).
   - **Qualidade:** `regra` e `confianca`, para o BI filtrar.
   - **Segurança:** `security_invoker = true`, sem grant para `anon`/`authenticated` (padrão das `v_bi_*`).
4. **View `public.v_bi_pca_tendencia_uasg`.** Lê `pca_uasg_execucao_diaria` (0013) e entrega a série mensal por órgão e
   UASG:
   - grupos e valor por situação;
   - % do planejado licitado;
   - % atrasado;
   - mediana de dias até a publicação.

   O mês usa o último retrato do mês, então é idempotente.
5. **#282: deduplicação PNCP × PGC.**
   - **Carga do PGC:** quando o PGC for carregado, a carga deduplica as linhas idênticas por `(orgao, codigoUasg,
     anoPcaProjetoCompra, numeroItemPncp)` antes de gravar. Isso é medido: as linhas duplicadas são idênticas em todos
     os campos.
   - **Regra do radar:** decisão pendente entre as opções da issue (pergunta 1). A proposta é a (c):
     - comparar com `is not distinct from` só quando as duas chaves estão preenchidas;
     - com chave nula, manter as duas linhas, marcar `possivel_duplicata = true` e tirá-las da soma, mostrando a contagem
       à parte.

     Assim não se afirma "mesmo item" sem chave, e não se infla o total.
   - **Migration:** nova e idempotente. A `20261002100000` não é editada.
6. **Contrato.** As duas views novas e a coluna `possivel_duplicata` entram em `docs/bi-cruzamento-apis.md`
   (seção 4), com colunas, tipos e a origem de cada uma (oficial, inferida ou calculada).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um item do PCA e um item da compra do mesmo grupo com a mesma quantidade e o mesmo valor unitário, **então** o par é `qtd_valor`. **Dado** só a descrição com semelhança ≥ 0,5, **então** é `descricao`. **Dado** dois itens do PCA disputando o mesmo item da compra, **então** fica com o de maior pontuação e o outro fica sem par. | Deno `tests/supabase/functions/pca_pareamento_item_test.ts` |
| CA-2 | **Dado** um grupo com um único PDM e um item sem par, **então** o item fica com `grupo_pdm_unico`. **Dado** um grupo com 2 PDM, **então** o item sem par não recebe PDM. | idem |
| CA-3 | **Idempotência:** rodar o pareamento duas vezes com as mesmas entradas deixa `pca_item_compra_item` igual. | idem + SQL `supabase/tests/bi_pca_execucao_check.sql` |
| CA-4 | **Dado** um PDM com 2 itens pareados (planejado 100 e 200, homologado 90 e 210), **então** `v_bi_pca_execucao_pdm` mostra planejado 300, homologado 300 e variação 0%, separados por `regra`. | SQL `supabase/tests/bi_pca_execucao_check.sql` |
| CA-5 | **Dado** retratos diários de uma UASG em dois dias do mesmo mês, **então** `v_bi_pca_tendencia_uasg` usa o último retrato do mês. | idem |
| CA-6 | `v_bi_pca_execucao_pdm` e `v_bi_pca_tendencia_uasg` não têm grant para `anon` nem `authenticated` e são `security_invoker`. | idem |
| CA-7 | **#282:** **dado** um item no PGC e no PNCP com UASG e número preenchidos e iguais, **então** conta uma vez. **Dado** a UASG nula em um dos lados, **então** as duas linhas aparecem com `possivel_duplicata = true` e ficam fora de `total` e `valor_total_escopo`. Um caso para cada chave nula. | SQL `supabase/tests/bi_pca_radar_dedup_check.sql` |
| CA-8 | **Dado** duas linhas do PGC idênticas, **quando** a carga do PGC grava, **então** fica uma linha. | pytest `services/coletor-externo/tests/test_pgc_dedup.py` (ou o teste da carga do PGC, onde ela estiver) |
| CA-9 | Contagem antes e depois do total do radar e da execução por PDM, em dry-run, anotada no PR. | verificação pré-merge, anotada no PR |

## Fora de escopo

- **Carga do PGC em si:** esta spec só fixa a deduplicação; quando carregar é decisão à parte.
- **Clusterização de PDM** (`cluster_pdm` das migrations de piso): as views novas expõem o PDM, e o agrupamento por
  cluster continua nas regras existentes.
- **Front do BI:** um PR separado no Dashboard.
- **Pesquisa de Preço do Compras.gov** como segunda fonte de preço homologado: já está no BI (`docs/bi-cruzamento-apis.md`).

## Impacto em dados

- **Migration:** `<timestamp>_bi_pca_execucao.sql`, aditiva e idempotente, com:
  - `pca_item_compra_item`;
  - as duas views;
  - a recriação de `v_bi_pca_radar` com `possivel_duplicata`;
  - os grants.
- **Tabelas:**
  - **lidas:** `pca_itens`, `pca_grupo_contratacao`, `pca_uasg_execucao_diaria`, `licitacao_itens`, `licitacao_resultados`
    e `pca_pgc_itens`;
  - **escrita:** `pca_item_compra_item`.
- **ACL/RLS:** a tabela nova é escrita só por `service_role`. As views ficam sem grant público.
- **Backfill:** o pareamento roda sobre os grupos já vinculados pela 0013. A contagem por regra vai para o PR.
- **Edge Functions republicadas no merge:** todas, como sempre. Muda a função que roda o pareamento (a mesma etapa da
  0013, no `link-pca-edital`).
- **Contrato com o Dashboard:**
  - entram duas views novas e a coluna nova em `v_bi_pca_radar`;
  - `total` e `valor_total_escopo` do radar podem cair quando o PGC for carregado (#282).
- **Dado oficial x derivado:**
  - **oficiais:** PDM, quantidades, valores e resultados;
  - **inferido:** o par de itens, com regra e confiança visíveis;
  - **calculadas:** variação e medianas.
  - Nenhum valor é inventado.

## Perguntas em aberto

1. **#282:** fica a opção (c), "marcar `possivel_duplicata` e tirar da soma", como proposto, ou a (a) ou a (b) da issue?
2. **Regra `descricao`:** liberar no BI só a regra `qtd_valor` primeiro, e a `descricao` depois de conferir à mão uma
   amostra de pares, ou liberar as duas rotuladas desde o início?
