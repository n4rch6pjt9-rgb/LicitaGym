# 0013: Cruzar o item do PCA com a contratação publicada pelo Identificador da Futura Contratação

- **Status:** rascunho (decisões do Marcelo de 09/10 incorporadas)
- **Issue:** nenhuma (sai da avaliação de 09/10/2026; continuação do "fora de escopo" da 0010)
- **Área:** pncp, coletor, migrations, edge-functions (`link-pca-edital`, `api-pncp-pca`), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Tem migration, cria dado derivado e muda o que o radar mostra.
- **Depende de:**
  - **0010:** grava `grupo_contratacao_codigo` e `grupo_contratacao_nome` em `pca_itens`;
  - **0012:** o sync do PCA completo, para que o universo de itens seja o da fonte;
  - **0011:** relacionada, porque o radar por UASG é onde o resumo por unidade aparece.

## Problema

Hoje não dá para dizer, para um item do PCA, se ele virou licitação e se ela terminou. Também não dá para dizer, por
UASG, quanto do planejado já foi licitado. Medido em 09/10/2026, só leitura no banco e GET público:

- **Vínculo atual:** `licitacoes_externas.pca_plano_id` e `contratacoes_editais.pca_plano_id` têm 0 vínculos. O
  `link-pca-edital` roda em dry-run e liga no nível do plano, não do item.
- **Casar por código de catálogo não funciona:**
  - só 239 dos 92.295 itens de compra da base têm `catalogoCodigoItem`, e nos materiais são 65;
  - no Compras.gov (`2_consultarItensContratacoes_PNCP_14133`), `codItemCatalogo`, `codigoClasse` e `codigoPdm` vieram
    nulos nas 266 linhas da amostra.
- **Casar por UASG e janela de data erra:**
  - numa amostra de 20 compras ligadas por "mesma UASG + escopo + data", só 10 foram confirmadas pelo identificador;
  - uma compra do Galeão (`00394429000100-1-002061/2026`) não tinha relação com os itens 7830 do plano.
- **O Identificador da Futura Contratação (IFC) liga o item à compra:**
  - o item do PCA traz `grupoContratacaoCodigo` no formato `UASG-N/ANO`, que é o `numeroContratacao` de
    `GET /api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens/contratacao`;
  - a compra que nasce dele é publicada pela mesma UASG com `numeroCompra = N` e o mesmo ano;
  - nenhum DTO de compra (PNCP ou Compras.gov) publica o IFC; a ligação é pelo número.
- **Evidência da regra:**
  - **na base:** casando `(UASG, N, ANO)` com as 1.651 compras, deram 30 grupos e 93 itens, sem nenhum ambíguo. Em 29 dos
    30, o nome do grupo e o objeto da compra dizem a mesma coisa. Exemplos:
    - `180152-131/2026` → "Aquisição de equipamentos para academia do Quartel…", R$ 536.906 dos dois lados;
    - `158587-25/2026` → R$ 111.133 dos dois lados.
  - **fora da base:** `1.1_consultarContratacoes_PNCP_14133_Id?tipo=idCompra` achou 6 de 6 compras conhecidas, em 0,2 a
    0,5 s cada. Numa amostra de 40 grupos com data desejada passada, achou 5, todos coerentes. Em 5 dos 35 não achados,
    a consulta do PNCP por unidade também não achou o número.
- **Por que a nossa base não tem a maioria das compras:**
  - a coleta do PNCP (`services/coletor-externo/coletor/pncp.py`) busca por termo no texto do edital
    (`/api/search?q="termo"&tipos_documento=edital`), como "puxador", "apito" ou "equipamentos de musculação";
  - uma compra com objeto genérico, que contém itens 7830, não é vista. Casos da amostra:
    - "Aquisição de material permanente para a Seção…";
    - "Aquisição de materiais de expediente, limpeza…";
    - "Aquisição de brinquedos e jogos pedagógicos".
  - O IFC é o caminho determinístico para achar essas compras a partir do plano.
- **Universo (varredura de 09/10, 6.009 itens 7830/2026 distintos):**
  - 4.540 com grupo no formato `UASG-N/ANO`, inclusive UASG de 5 dígitos como `90145-13/2026`;
  - 52 com grupo fora desse formato;
  - 1.417 sem grupo;
  - os grupos com UASG de 6 dígitos são 1.166 distintos: 687 com data desejada passada e 479 futura.

## Abordagem proposta

1. **Chave e normalização.**
   - Do `grupo_contratacao_codigo` sai `(uasg, numero, ano)`, com a UASG preenchida com zeros à esquerda até 6 dígitos;
   - fora de `^\d{5,6}-\d+/\d{4}$` o item fica `sem_identificador`. Não há heurística.
2. **Busca da compra, nesta ordem:**
   1. **na base:** `licitacoes_externas` com `raw->>'unidade_codigo' = uasg`, `ltrim(raw->>'numero','0') = numero` e
      `raw->>'ano' = ano`. Custo zero de API.
   2. **no Compras.gov:** `1.1_consultarContratacoes_PNCP_14133_Id?tipo=idCompra&codigo={uasg}{MM}{numero:05}{ano}`.
      - **Modalidades:** medido em 09/10 com `1_consultarContratacoes_PNCP_14133`, compras de 01/09 a 08/10/2026. Os
        códigos de `codigoModalidade` 1, 2, 4 e de 8 a 20 voltam vazios. Ficam quatro, tentados pelo volume:

        | `MM` | Modalidade (Compras.gov) | Modalidade PNCP | Compras |
        |---|---|---|---|
        | `06` | Dispensa | 8 | 10.429 |
        | `05` | Pregão (eletrônico e presencial) | 6 e 7 | 8.594 |
        | `07` | Inexigibilidade | 9 | 5.793 |
        | `03` | Concorrência (eletrônica e presencial) | 4 e 5 | 837 |

      - **Custo:** até 4 requisições por grupo a 1 req/s. O primeiro resultado com `numeroControlePNCP` fecha a busca.
      - **Fora:** a busca no sentido contrário (número de controle → `idCompra`) achou só 1 de 6 compras conhecidas, e não
        é usada. O pregão internacional (PNCP 18) não foi medido e não entra.
   3. **não achou:** o grupo fica `nao_licitado_*` (passo 4) e volta a ser buscado no próximo ciclo.
   - A consulta do PNCP por unidade (`/v1/contratacoes/publicacao`) fica só como conferência manual. Leva de 13 a 25 s
     por chamada, exige modalidade e janela de no máximo 365 dias, e devolveu 429 na medição.
3. **Compra achada pelo IFC entra na base.** Ela é gravada em `licitacoes_externas` e `licitacao_itens` pelo mesmo
   carregador de compra do coletor PNCP, com `origem_descoberta = 'pca_ifc'`. A coluna é nova em
   `licitacoes_externas`: hoje ela só tem `fonte` e `link_sistema_origem`, e `licitacao_itens.fonte_carga` está nula nas
   92.295 linhas. As compras atuais ficam com `null`, que quer dizer "por termo de busca". Assim ela passa pelo mesmo escopo, pelos
   resultados e pelos documentos das outras, e a coleta deixa de depender só de termo para o que o PCA já anunciou.
   Decisão do Marcelo (09/10): as compras já executadas entram na base porque viram histórico de análise do BI
   (passo 10).
4. **Situação do grupo.** Pelos itens da compra no PNCP (`situacaoCompraItemNome`):
   - `concluida`: algum item `Homologado`;
   - `em_aberto`: nenhum homologado e algum `Em andamento`;
   - `sem_sucesso`: todos `Fracassado`, `Deserto` ou `Anulado/Revogado/Cancelado`;
   - sem compra:
     - `nao_licitado_atrasado` quando a menor data desejada dos itens do grupo é anterior à data de referência
       (decisão: passou, está em atraso, sem folga);
     - `nao_licitado_no_prazo` caso contrário;
   - `sem_identificador`: o item não tem grupo válido.

   Os itens da compra não têm código de catálogo, então a situação vale para o **grupo** (o IFC), não item a item. A
   interface diz isso.
5. **Gravação idempotente e métrica de tendência** (decisão: os campos são idempotentes e servem para análise de
   tendência).
   - **`public.pca_grupo_contratacao`:** o estado atual, uma linha por `(pca_plano_id, grupo_contratacao_codigo)`.
     Colunas:
     - `uasg`, `numero`, `ano`;
     - `data_desejada_min`, `valor_planejado` (soma dos itens do grupo);
     - `numero_controle_pncp_compra`, `licitacao_externa_id`;
     - `metodo` (`ifc_base` | `ifc_compras_gov`), `modalidade_mm`;
     - `data_publicacao_compra`, `situacao`;
     - `itens_compra_homologados`, `itens_compra_em_andamento`, `itens_compra_sem_sucesso`, `valor_homologado`;
     - `dias_desejada_ate_publicacao` (`data_publicacao_compra - data_desejada_min`; negativo = antecipado);
     - `data_referencia`, `verificado_em`, `tentativas`, `erro`.

     Reprocessar com as mesmas entradas e a mesma `data_referencia` produz a mesma linha. O upsert é por chave, sem
     duplicar.
   - **`public.pca_grupo_contratacao_evento`:** só cresce, com uma linha por mudança de `situacao`. Colunas:
     `situacao_anterior`, `situacao_nova`, `data_referencia` e `numero_controle_pncp_compra`. Se a situação não mudou, não
     grava. É idempotente por `(grupo, situacao_nova, data_referencia)`.
   - **`public.pca_uasg_execucao_diaria`:** um retrato diário por `(data_referencia, orgao_cnpj, uasg, ano_pca)`. Colunas:
     - grupos e itens por situação;
     - `valor_planejado`, `valor_licitado` e `valor_homologado`;
     - mediana de `dias_desejada_ate_publicacao`.

     Upsert por chave: rodar duas vezes no mesmo dia dá o mesmo retrato. É a base da tendência (atraso e execução por
     mês, por órgão e por UASG).
6. **`link-pca-edital` estendido** (decisão: estender a função existente, informando o que já foi licitado por UASG).
   - **Nova etapa `ifc`, depois da atual de plano:**
     - processa os grupos em fatias (fila e continuação no padrão da 0012);
     - grava os passos 4 e 5;
     - responde, por UASG processada: grupos, quantos licitados (`concluida` + `em_aberto` + `sem_sucesso`), quantos
       atrasados, quantos no prazo, valor planejado × licitado e a lista dos `numero_controle_pncp` achados.
   - O `dry_run` continua valendo para a etapa nova: calcula e responde, sem gravar.
   - O vínculo de plano atual (`pca_plano_id` nas compras) não muda.
7. **Sugestão derivada no radar** (decisão: mostrar).
   - O casamento por "mesma UASG + escopo + janela de 90 dias" fica na view `pca_grupo_sugestao` e aparece no radar só
     quando o grupo está `nao_licitado_*` e há sugestão;
   - é rotulado "Sugestão (mesma unidade e período; não confirmado pelo identificador)";
   - nunca preenche `situacao` nem `numero_controle_pncp_compra`.
8. **Rotina:**
   - **diária**, depois do sync do PCA: grupos novos; grupos `nao_licitado_*` com data desejada até hoje + 30 dias;
     grupos `em_aberto`. Depois, o retrato diário por UASG;
   - **primeira carga:** os 1.166 grupos, até 4.664 requisições no pior caso, umas 1 h 20 a 1 req/s, em fatias, com
     dry-run antes;
   - **erro de HTTP** (429, 5xx, timeout) deixa o grupo com `erro` e mantém a `situacao` anterior. Erro não é "não
     licitado". Em 429 há recuo exponencial.
9. **API e radar.**
   - `api-pncp-pca?visao=radar`: campo novo por item, `contratacao: { situacao, numero_controle_pncp, objeto, metodo,
     data_publicacao, dias_desejada_ate_publicacao, sugestao }`. É aditivo.
   - `api-pncp-pca?visao=uasg` (ou a ação da 0011): resumo por UASG do retrato mais recente, com série histórica opcional
     (`desde=AAAA-MM-DD`).

10. **Histórico do BI por PDM** (decisão do Marcelo: compra já executada de um PDM vira histórico de análise do BI).
    - **Pareamento item do PCA ↔ item da compra, dentro do grupo vinculado.** Medido nos 30 grupos casados na base (93
      itens do PCA, em 09/10):

      | Regra | Confiança | Itens pareados |
      |---|---|---|
      | `qtd_valor`: mesma quantidade e mesmo valor unitário estimado (diferença menor que R$ 0,01) | alta | 31 (20 com descrição também parecida) |
      | `descricao`: semelhança de termos da descrição ≥ 0,5 (Jaccard, sem acento e sem palavras de formulário CATMAT) | média | 26 |
      | nenhuma | — | 36: ficam atribuídos só ao grupo |

      O pareamento é 1:1 dentro do grupo. Um item da compra não serve a dois itens do PCA.
    - **Atribuição ao PDM:**
      - item pareado: o PDM vem do item do PCA (`pdmCodigo`, oficial);
      - grupo com um único PDM (335 dos 1.210 grupos, 460 itens): o grupo inteiro é atribuído a esse PDM, com confiança
        `grupo_pdm_unico`;
      - grupo com 2 ou mais PDM e item sem par: não há atribuição por PDM. Entra só nos totais do grupo e da UASG.
    - **Gravação:** tabela `public.pca_item_compra_item`, com `pca_item_id`, `licitacao_item_id`, `regra`
      (`qtd_valor` | `descricao` | `grupo_pdm_unico`), `confianca`, `similaridade` e `data_referencia`. É idempotente
      pelo par.
    - **Resultado da compra:** só 3 dos 57 itens pareados têm resultado em `licitacao_resultados` hoje. A etapa enfileira
      as compras `concluida` sem resultado no carregador de resultados do coletor, que é o mesmo das demais.
    - **View `v_bi_pca_execucao_pdm`:**
      - recorte: por PDM, UASG, órgão e mês da publicação;
      - quantidade e valor planejados, quantidade e valor licitados, valor unitário homologado;
      - variação homologado × planejado;
      - fornecedor e marca vencedores, que vêm de `licitacao_resultados`;
      - `dias_desejada_ate_publicacao`;
      - colunas `regra` e `confianca`, para que o BI filtre por qualidade do vínculo.

      O padrão é o mesmo das outras `v_bi_*`: `security_invoker` e sem grant para `anon`/`authenticated`. Entra no
      contrato de `docs/bi-cruzamento-apis.md`.
    - **Exemplo medido:** grupo `153063-745/2026`, item 8930, PDM 11503 (rede de esporte): planejado R$ 349,34 no PCA,
      homologado R$ 338,57.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** `"180152-131/2026"`, **então** a chave é `('180152','131','2026')`. **Dado** `"90145-13/2026"`, **então** é `('090145','13','2026')`. **Dado** `null`, `""` ou `"ABC"`, **então** é `sem_identificador`. | Deno `tests/supabase/functions/_shared/pncp/pca_ifc_test.ts` |
| CA-2 | **Dado** uma compra na base com `unidade_codigo=180152`, `numero=131` e `ano=2026`, **quando** o grupo `180152-131/2026` é processado, **então** o vínculo é `metodo=ifc_base` e não há requisição externa. | Deno `tests/supabase/functions/link_pca_edital_ifc_test.ts` |
| CA-3 | **Dado** um grupo fora da base e um cliente falso que responde vazio para `MM=06` e responde a compra para `MM=05`, **então** o vínculo é `metodo=ifc_compras_gov` com `modalidade_mm=05`, os `idCompra` consultados são `{uasg}06…` e `{uasg}05…` nessa ordem, e não há terceira tentativa. | idem |
| CA-4 | **Dado** uma compra achada pelo IFC fora da base, **quando** a etapa não é dry-run, **então** ela é gravada em `licitacoes_externas` com `origem_descoberta='pca_ifc'` e seus itens em `licitacao_itens`. Uma segunda execução não duplica (mesma chave `numero_controle_pncp`). | idem |
| CA-5 | **Dado** uma compra com itens `Homologado` e `Em andamento`, **então** a situação é `concluida`. Só `Em andamento` dá `em_aberto`. Só `Fracassado`, `Deserto` ou `Anulado/Revogado/Cancelado` dá `sem_sucesso`. | idem |
| CA-6 | **Dado** um grupo sem compra com data desejada mínima de 08/10 e `data_referencia` de 09/10, **então** a situação é `nao_licitado_atrasado`. Com data desejada de 09/10, é `nao_licitado_no_prazo`. | idem |
| CA-7 | **Idempotência:** **dado** as mesmas entradas e a mesma `data_referencia`, **quando** a etapa roda duas vezes, **então** `pca_grupo_contratacao`, `pca_grupo_contratacao_evento` e `pca_uasg_execucao_diaria` ficam iguais (mesmo número de linhas e mesmos valores). | idem + SQL `supabase/tests/pca_grupo_contratacao_check.sql` |
| CA-8 | **Dado** um grupo que passa de `nao_licitado_atrasado` para `em_aberto`, **então** grava um evento com as duas situações. Sem mudança, não grava evento. | idem |
| CA-9 | **Dado** que o Compras.gov devolve 429 ou 5xx, **então** o grupo fica com `erro` e `tentativas + 1`, e mantém a `situacao` anterior. Nunca vira `nao_licitado_*`. | Deno `link_pca_edital_ifc_test.ts` |
| CA-10 | **Dado** `dry_run=true`, **então** a resposta traz o resumo por UASG (grupos, licitados, atrasados, no prazo, valor planejado × licitado, compras achadas) e nenhuma tabela é escrita. | idem |
| CA-11 | `anon` e `authenticated` sem papel não escrevem nas três tabelas. A leitura segue a mesma regra de `pca_itens`. Só `service_role` executa as funções de gravação. | SQL `supabase/tests/pca_grupo_contratacao_check.sql` |
| CA-12 | `api-pncp-pca?visao=radar` traz `contratacao` por item, com `sugestao` só quando a situação é `nao_licitado_*`. A sugestão nunca aparece como `situacao`. Os campos atuais não mudam. | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` |
| CA-13 | **Dado** um item do PCA e um item da compra do mesmo grupo com a mesma quantidade e o mesmo valor unitário, **então** o par é `qtd_valor`. **Dado** só a descrição com semelhança ≥ 0,5, **então** é `descricao`. **Dado** dois itens do PCA disputando o mesmo item da compra, **então** fica com o de maior pontuação e o outro fica sem par. | Deno `tests/supabase/functions/pca_pareamento_item_test.ts` |
| CA-14 | **Dado** um grupo com um único PDM e itens sem par, **então** os itens ficam atribuídos ao PDM com `grupo_pdm_unico`. **Dado** um grupo com 2 PDM, **então** o item sem par não recebe PDM. | idem |
| CA-15 | `v_bi_pca_execucao_pdm` não tem grant para `anon` nem `authenticated`, e cada linha traz `regra` e `confianca`. | SQL `supabase/tests/pca_grupo_contratacao_check.sql` |
| CA-16 | **Regressão com dado real (pós-merge):** os grupos `180152-131/2026`, `158587-25/2026`, `158195-181/2026`, `102171-126/2026`, `102333-11/2026` e `785600-46/2026` ficam vinculados às compras `46377800000127-1-003879/2026`, `10764307000112-1-000217/2026`, `05055128000176-1-000153/2026`, `63025530000104-1-003857/2026`, `48031918000124-1-000622/2026` e `00394502000144-1-002874/2026`. O grupo `120645-183/2026` (Galeão) nunca fica vinculado a `00394429000100-1-002061/2026`. | verificação pós-merge (skill `verificar-producao`), anotada no PR |

## Fora de escopo

- **Situação item a item dentro do grupo:** os itens da compra não trazem código de catálogo.
- **IFC de anos anteriores (2024/2025):** depende do sync do PCA desses anos.
- **Ata, contrato e empenho** depois da homologação.
- **Pregão internacional** (PNCP 18): não medido.
- **Front:** um PR separado no Dashboard, depois do backend no ar.

## Impacto em dados

- **Migration:** `<timestamp>_pca_grupo_contratacao.sql`, aditiva e idempotente. Tem:
  - as quatro tabelas (`pca_grupo_contratacao`, `pca_grupo_contratacao_evento`, `pca_uasg_execucao_diaria` e
    `pca_item_compra_item`) e a view `v_bi_pca_execucao_pdm`;
  - a coluna `licitacoes_externas.origem_descoberta text` (nula = termo de busca);
  - os índices por `(uasg, numero, ano)`, `pca_plano_id` e `(data_referencia, uasg)`;
  - as funções de gravação em `private` com `security definer` e `search_path` fixo;
  - a view de sugestão;
  - os grants.
- **Tabelas:**
  - **lidas:** `pca_itens`, `pca_planos`, `licitacoes_externas` e `licitacao_itens`;
  - **escritas:** as três novas, mais `licitacoes_externas` e `licitacao_itens` para as compras achadas pelo IFC
    (`origem_descoberta='pca_ifc'`).
- **ACL/RLS:** as tabelas novas têm RLS. Leitura igual à de `pca_itens`; escrita só por `service_role`.
- **Backfill:** a primeira carga dos 1.166 grupos, em dry-run primeiro. A contagem por `situacao`, por `metodo` e por
  `modalidade_mm`, e o número de compras novas na base, vão para o PR.
- **Requisições:**
  - Compras.gov: até 4 por grupo na primeira carga (até 4.664); depois, por dia, só os pendentes;
  - PNCP: as do carregador de compra para cada compra nova;
  - tudo a 1 req/s, com recuo em 429.
- **Edge Functions republicadas no merge:** todas. Mudam `link-pca-edital` e `api-pncp-pca`.
- **Contrato com o Dashboard:** campos novos e aditivos (`contratacao` no radar e o resumo por UASG).
- **Dado oficial x derivado:**
  - **oficiais:** o código do grupo, o número, a UASG, o ano e a modalidade da compra, e a situação dos itens;
  - **inferido:** o vínculo grupo → compra, pela regra de numeração, declarado em `metodo`;
  - **sugestão:** a view separada, rotulada.
  - Nenhum valor é inventado.

## Perguntas em aberto

1. **Resumo por UASG:** fica na `api-pncp-pca` (`visao=uasg`) desta spec, ou entra na 0011 (radar por unidade), que já
   trata a visão por UASG?
2. **Limiar da regra `descricao`:** 0,5 de semelhança foi o usado na medição (26 pares). Antes de liberar no BI, conferir
   uma amostra de pares `descricao` à mão, ou só liberar a regra `qtd_valor` primeiro?
