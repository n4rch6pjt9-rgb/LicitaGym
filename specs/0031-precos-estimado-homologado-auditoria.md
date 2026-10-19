# 0031: Mostrar estimado × homologado e o link da compra em /precos

- **Status:** rascunho
- **Issue:** nenhuma (feedback do Marcelo de 19/10 sobre a página /precos)
- **Área:** coletor | migrations | edge-functions | dashboard-contrato
- **Depende do ok do Marcelo:** sim (migration nova, decisão de produto sobre "fora do perfil", dado de produção)

## Problema

A página /precos (spec 0009) mostra o preço homologado de cada compra, mas não mostra:

- quanto o órgão estimou;
- de onde veio o número.

Sem essas duas informações, não dá para auditar um preço estranho.

**Caso de referência** (consultado em 19/10):

- **Compra:** `id_compra` 93099205000052026, item 11, CATMAT 373980 (esteira ergométrica), PDM 7115.
- **Órgão:** ECE-Consórcio Pub. M. Res. Sól. S. I. de S. Benedito, UASG 930992.
- **Objeto:** "Registro de Preços para futura e eventual aquisição de máquinas, implementos e tratores para equipar as Centrais Municipais de Resíduos".
- **Resultado:** 18 unidades a R$ 52.000, marca TCMAQ.
- **O que mostra a API 2.1 do Compras.gov para o mesmo item:**
  - estimado R$ 80.800;
  - orçamento sigiloso;
  - situação Homologado;
  - PNCP `44678797000156-1-000004/2026`.
- **Conclusão:** é uma esteira de triagem de resíduos catalogada com o código de esteira ergométrica. O link e o objeto resolvem o caso em segundos. Sem eles, o número entra na mediana.

Outros fatos medidos no banco em 19/10:

- **`precos_praticados_itens`:**
  - 25.465 linhas, 5.283 compras e 33 PDMs;
  - `data_resultado` de 2021-12-01 a 2026-10-01;
  - todas as linhas gravadas numa só carga: `last_synced_at` = 2026-10-03 02:09 UTC;
  - nenhuma linha com `detalhe_sincronizado_em`, ou seja, o `2_consultarMaterialDetalhe` nunca rodou com banco.
- **Rótulo "atualizado em 02/10":** é o `max(last_synced_at)`. Ele mostra que a coleta semanal não roda desde essa carga, e não um atraso da API. Ver "Operação" abaixo.
- **PDM 7115:** 40 de 206 preços ficam fora de 0,4× a 2,5× a mediana do próprio item.
- **Filtro automático pelas palavras do objeto:** marca linhas demais. Por isso, o filtro fica nas mãos do usuário e a marcação automática só olha o preço (CA-6).

Feedback de tela na mesma revisão:

- Órgão e UASG repetem a mesma informação em duas colunas.
- O rodapé tem textos que não ajudam a decidir.
- Falta o trio Estimado | Homologado | Diferença por linha.

## Operação (antes da implementação, sem código)

A coleta de preços não está agendada ou não está rodando:

- O código de `--coleta precos` entrou na `main` em 09/10 (#291), mas a única carga é de 03/10, provavelmente o piloto.
- `private.coleta_externa_run` está vazia: o coletor de preços não registra execução lá, como diz a migration `20261009181000`.
- O último update de SEST SENAT em `licitacoes_externas` é de 24/09, o que sugere que o Job `coletor-sestsenat` inteiro está parado.

A conferir pelo Marcelo no GCP, já que esta sessão não tem acesso:

1. `gcloud run jobs executions list --job coletor-sestsenat --region $REGION --limit 5`: há execução depois de 03/10? Com que código de saída?
2. `gcloud scheduler jobs list --location $REGION`: existe agendamento que chame o Job? Com quais `--args`? O README de 2026-10-09 sugere `--args="--coleta,precos"` num agendamento próprio.
3. A imagem do Job foi reconstruída depois de 09/10? Sem isso, o Job não conhece `--coleta`.
4. A issue `alerta-operacional` com `precos_dias_sem_coleta` crítico (16 dias em 19/10) deveria estar aberta. Se não estiver, o `saude.yml` também precisa de olhar.

## Proposta

1. **Coleta nova (`coletor/compras_itens_contratacao.py`):**
   - Para cada `id_compra` distinto de `precos_praticados_itens` ainda sem linha na tabela nova (ou com `data_hora_atualizacao_compra` mais nova), chama `GET /modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id?tipo=idCompra&codigo=<id_compra>`.
   - Grava os campos oficiais `valorUnitarioEstimado`, `valorUnitarioResultado`, `orcamentoSigiloso`, `situacaoCompraItemNome`, `numeroControlePNCPCompra`, `dataAtualizacaoPncp` e o `raw`.
   - Roda no mesmo Job, depois da coleta de preços (`--coleta precos`). Delay de no mínimo 1 s.
   - A primeira carga tem 5.283 chamadas, cerca de 1h30 com delay de 1 s (não medido). Depois, só as compras novas.
2. **Regra de duplicata:** a API devolve mais de uma linha para o mesmo item. No caso de referência, o item 11 vem duas vezes:
   - "Em andamento", com estimado 0;
   - "Homologado", com estimado 80.800.

   Fica a linha com `temResultado = true`. Havendo empate, fica a de `dataAtualizacaoPncp` mais nova. Estimado igual a 0 é tratado como ausente, nunca como zero.
3. **Migration aditiva** `supabase/migrations/<ts>_precos_itens_contratacao.sql`:
   - **Tabela `public.precos_itens_contratacao`:**
     - chave primária `(id_compra, numero_item_compra)`;
     - colunas `valor_unitario_estimado`, `valor_unitario_resultado`, `orcamento_sigiloso`, `situacao_item`, `numero_controle_pncp`, `data_atualizacao_pncp`, `raw jsonb`, `payload_hash`, `last_synced_at`.
   - **Segurança:** RLS ligada, sem policy, `revoke all`, leitura só pela Edge Function (o mesmo padrão de `precos_praticados_itens`).
   - Checagem em `supabase/tests/precos_itens_contratacao_check.sql`.
4. **`api-precos`, ação de amostra** (contrato aditivo, sem campos removidos). Campos novos por linha:
   - `valor_estimado`: oficial, ou `null` quando ausente ou 0;
   - `valor_homologado`: o `preco_unitario` atual;
   - `diferenca_valor` e `diferenca_percentual` = (homologado − estimado) / estimado, arredondado a 2 casas e só quando há estimado;
   - `orcamento_sigiloso`;
   - `link_compras_gov`, montado a partir de `id_compra`;
   - `link_pncp`, a partir de `numero_controle_pncp`, com o formato `https://pncp.gov.br/app/editais/<cnpj>/<ano>/<sequencial>`;
   - `fora_do_perfil` (CA-6).
5. **Filtro por objeto:**
   - parâmetro `objeto` (texto, sem acento e sem diferenciar maiúsculas) na amostra e no resumo;
   - parâmetro `excluir_objeto` para tirar compras como "tratores";
   - mesmo comportamento do filtro de oportunidades.
6. **"Fora do perfil":**
   - Uma linha cujo preço fica fora de [0,4×, 2,5×] a mediana do mesmo `codigo_item_catalogo` e da mesma unidade, no período filtrado e com ao menos 5 preços, sai das estatísticas do resumo por padrão.
   - A linha continua listada e marcada.
   - O parâmetro `incluir_fora_do_perfil=true` devolve o cálculo antigo.
   - O resumo informa quantas linhas ficaram de fora.
7. **Front** (repositório Dashboard, PR depois do backend no ar):
   - uma coluna "Órgão / UASG";
   - colunas Estimado | Homologado | Diferença;
   - ícone de link para o Compras.gov e para o PNCP;
   - selo "fora do perfil";
   - campo de objeto ao lado dos filtros atuais;
   - rodapé reduzido a fonte e data: "Fonte: Compras.gov (Pesquisa de Preço + Contratações 14.133). Última coleta: <data>".

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** a resposta gravada da API 2.1 para 93099205000052026 (fixture), **quando** o parser roda, **então** o item 11 sai com estimado 80800, resultado 52000, sigiloso true e PNCP `44678797000156-1-000004/2026`, e a linha "Em andamento" com estimado 0 é descartada. | pytest `services/coletor-externo/tests/test_compras_itens_contratacao.py` |
| CA-2 | **Dado** um item cujo estimado é 0 ou ausente, **quando** grava, **então** `valor_unitario_estimado` fica NULL. | pytest (mesmo arquivo) |
| CA-3 | **Dado** erro HTTP ou JSON ilegível em uma compra, **quando** a coleta roda, **então** a compra conta em `falhas`, nada é gravado para ela e o Job sai com código 1. | pytest (mesmo arquivo) |
| CA-4 | **Dado** uma linha com estimado 80800 e homologado 52000, **quando** a amostra é pedida, **então** vêm `valor_estimado` 80800, `valor_homologado` 52000, `diferenca_valor` −28800, `diferenca_percentual` −35,64 e os dois links. | Deno `tests/supabase/api-precos/amostra_estimado_test.ts` |
| CA-5 | **Dado** `objeto=tratores`, **quando** a amostra e o resumo são pedidos, **então** só entram compras com "tratores" no objeto; com `excluir_objeto=tratores`, elas saem. | Deno `tests/supabase/api-precos/filtro_objeto_test.ts` |
| CA-6 | **Dado** um item com 5 ou mais preços e um deles acima de 2,5× a mediana, **quando** o resumo é pedido, **então** esse preço fica fora de n, mediana e quartis, `fora_do_perfil_n` = 1, e a linha aparece na amostra com `fora_do_perfil` true; com `incluir_fora_do_perfil=true`, entra no cálculo. | SQL `supabase/tests/precos_fora_do_perfil_check.sql` + Deno |
| CA-7 | **Dado** um usuário `authenticated` sem empresa, ou `anon`, **quando** lê `precos_itens_contratacao` direto, **então** recebe erro de permissão. | SQL `supabase/tests/precos_itens_contratacao_check.sql` |
| CA-8 | **Dado** um item com menos de 5 preços, **quando** o resumo é pedido, **então** nada é marcado como fora do perfil. | SQL (mesmo check do CA-6) |

## Fora de escopo

- Recatalogar ou excluir de vez as compras mal catalogadas: a marcação só sinaliza e nada é apagado.
- Coleta de documentos, atas e marca pelo PNCP: a marca continua vindo da Pesquisa de Preço.
- Religar ou agendar o Job no GCP: é operação do Marcelo (seção "Operação").
- Registro da execução de preços em `private.coleta_externa_run`, cujo `modo` não aceita preços: issue própria se valer.

## Impacto em dados

- **Migration:** sim, aditiva e idempotente (tabela nova, função do resumo com parâmetros novos e com default, mantendo a assinatura antiga).
- **Tabelas, views e funções tocadas:**
  - `precos_itens_contratacao`: nova, escrita pelo coletor e lida pela `api-precos`;
  - `precos_praticados_resumo`: parâmetros `p_objeto`, `p_excluir_objeto` e `p_incluir_fora_do_perfil`.
- **ACL e RLS:** RLS ligada sem policy, `revoke all` de `anon` e `authenticated`, grant só a `service_role`.
- **Backfill:** a primeira carga do coletor (cerca de 5.283 compras). Não altera `precos_praticados_itens`.
- **Edge Functions republicadas no merge:** todas (é a regra do repositório). Muda a `api-precos`.
- **Contrato com o Dashboard:** aditivo (campos e parâmetros novos). O backend vai ao ar antes do front.
- **Dado oficial × derivado:**
  - oficiais: estimado, homologado, sigiloso, situação e nº PNCP;
  - derivados: a diferença (fórmula do item 4), os links (montados a partir dos identificadores oficiais) e o "fora do perfil" (regra do item 6, rotulada como marcação do LicitaGym).

## Perguntas em aberto

1. A faixa de 0,4× a 2,5× a mediana e o mínimo de 5 preços valem como regra de produto? Também cabe uma marcação por objeto, por exemplo uma lista curta de termos ("trator", "implemento", "resíduo") que só sugere a marcação, sem tirar a linha do cálculo?
2. Estimado sigiloso: mostrar o valor quando a API já o devolve depois da homologação, como no caso de referência, ou esconder?
3. Formato do link do Compras.gov: validar com o Marcelo qual página pública abre melhor para auditoria (acompanhamento da compra no Compras.gov ou só PNCP).
4. A compra tem duas linhas de item no Compras.gov (itens 10 e 11, as duas TCMAQ). O "fora do perfil" deve marcar a compra inteira quando um item dela é marcado?
