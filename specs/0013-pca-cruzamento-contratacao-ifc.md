# 0013: Cruzar o item do PCA com a contratação publicada pelo Identificador da Futura Contratação

- **Status:** rascunho
- **Issue:** nenhuma (sai da avaliação de 09/10/2026; continuação do "fora de escopo" da 0010)
- **Área:** pncp, coletor, migrations, edge-functions (`link-pca-edital` ou função nova), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Tem migration, cria dado derivado e muda o que o radar mostra.
- **Depende de:**
  - **0010:** grava `grupo_contratacao_codigo` e `grupo_contratacao_nome` em `pca_itens`;
  - **0012:** o sync do PCA completo, para que o universo de itens seja o da fonte.

## Problema

Hoje não dá para dizer, para um item do PCA, se ele virou licitação e se ela terminou. Medido em 09/10/2026, só
leitura no banco e GET público:

- **Vínculo atual:** `licitacoes_externas.pca_plano_id` e `contratacoes_editais.pca_plano_id` têm 0 vínculos. O
  `link-pca-edital` roda em dry-run e liga no nível do plano, não do item.
- **Casar por código de catálogo não funciona:**
  - só 239 dos 92.295 itens de compra da base têm `catalogoCodigoItem`, e nos materiais são 65;
  - no Compras.gov (`2_consultarItensContratacoes_PNCP_14133`), `codItemCatalogo`, `codigoClasse` e `codigoPdm` vieram
    nulos nas 266 linhas da amostra.
  - O nível "mesmo código" deu 0 itens.
- **Casar por UASG e janela de data erra:**
  - "mesma UASG + escopo + até 90 dias" ligou 231 itens, e "mesma UASG + 2026" ligou mais 209;
  - numa amostra de 20 compras, só 10 foram confirmadas pelo identificador;
  - uma compra do Galeão (`00394429000100-1-002061/2026`) não tinha relação com os itens 7830 do plano.
- **O Identificador da Futura Contratação (IFC) liga o item à compra:**
  - o item do PCA traz `grupoContratacaoCodigo` no formato `UASG-N/ANO`, que é o `numeroContratacao` de
    `GET /api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens/contratacao`;
  - a compra que nasce dele é publicada pela mesma UASG com `numeroCompra = N` e o mesmo ano.
  - Nenhum DTO de compra (PNCP ou Compras.gov) publica o IFC; a ligação é pelo número.
- **Evidência da regra:**
  - **na base:** casando `(UASG, N, ANO)` com as 1.651 compras, deram 30 grupos e 93 itens, sem nenhum ambíguo. Em 29 dos
    30, o nome do grupo e o objeto da compra dizem a mesma coisa; o outro é plausível. Exemplos:
    - `180152-131/2026` → "Aquisição de equipamentos para academia do Quartel…", R$ 536.906 dos dois lados;
    - `158587-25/2026` → R$ 111.133 dos dois lados.
  - **fora da base:**
    - `GET /modulo-contratacoes/1.1_consultarContratacoes_PNCP_14133_Id?tipo=idCompra&codigo={UASG}{MM}{N:05}{ANO}`, com
      `MM` = 05 para pregão e 06 para dispensa, achou 6 de 6 compras conhecidas, em 0,2 a 0,5 s cada;
    - numa amostra de 40 grupos fora da base com data desejada passada, achou 5. Os 5 estão coerentes, como
      "Peças de Tatame…" → "Aquisição de tatame…";
    - em 5 dos 35 não achados, a consulta do PNCP por unidade (`/v1/contratacoes/publicacao`, modalidades 6 e 8, 2026)
      também não achou o número. Ou seja, "não achado" é, em geral, "ainda não licitado".
- **Universo (varredura de 09/10, 6.009 itens 7830/2026 distintos):**
  - 4.540 com grupo no formato `UASG-N/ANO`, inclusive UASG de 5 dígitos como `90145-13/2026`;
  - 52 com grupo fora desse formato;
  - 1.417 sem grupo;
  - os grupos com UASG de 6 dígitos são 1.166 distintos: 687 com data desejada passada e 479 futura.

## Abordagem proposta

1. **Chave e normalização.**
   - Do `grupo_contratacao_codigo` (vem da 0010) sai `(uasg, numero, ano)`, com a UASG preenchida com zeros à esquerda
     até 6 dígitos;
   - fora de `^\d{5,6}-\d+/\d{4}$` o item fica `sem_identificador`. Não há heurística.
2. **Busca da compra, nesta ordem:**
   1. **na base:** `licitacoes_externas` com `raw->>'unidade_codigo' = uasg`, `ltrim(raw->>'numero','0') = numero` e
      `raw->>'ano' = ano`. Custo zero de API.
   2. **no Compras.gov:**
      - `1.1_consultarContratacoes_PNCP_14133_Id` com `idCompra = uasg || MM || lpad(numero,5,'0') || ano`, tentando
        `MM` em 05, 06 e 07, nessa ordem. O 07 não foi medido; a pergunta 2 trata das outras modalidades;
      - o primeiro resultado com `numeroControlePNCP` fecha a busca;
      - são até 3 requisições por grupo a 1 req/s.
   3. **não achou:**
      - se a data desejada já passou, `nao_licitado_atrasado`; senão, `nao_licitado_no_prazo`;
      - o grupo volta a ser buscado no próximo ciclo.
   - **Fora:** a consulta do PNCP por unidade (`/v1/contratacoes/publicacao`) fica só como conferência manual. Leva de 13
     a 25 s por chamada, exige modalidade e janela de no máximo 365 dias, e devolveu 429 na medição.
3. **Situação da compra:** pelos itens da compra no PNCP (`situacaoCompraItemNome`):
   - para compra da base, por `licitacao_itens`;
   - para compra achada fora, por `GET /api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens` (pergunta 3: gravar a compra
     em `licitacoes_externas` ou só o resumo).

   Regra por compra:
   - `concluida`: algum item `Homologado`;
   - `em_aberto`: nenhum homologado e algum `Em andamento`;
   - `sem_sucesso`: todos `Fracassado`, `Deserto` ou `Anulado/Revogado/Cancelado`.

   Os itens da compra não têm código de catálogo. Por isso a situação vale para o **grupo** (o IFC), não item a item,
   e a interface diz isso.
4. **Gravação.** Tabela nova `public.pca_grupo_contratacao`, com uma linha por `(pca_plano_id, grupo_contratacao_codigo)`.
   Colunas:
   - `uasg`, `numero`, `ano`;
   - `numero_controle_pncp_compra` (nulo se não achou) e `licitacao_externa_id` (nulo se a compra não está na base);
   - `metodo` (`ifc_base` | `ifc_compras_gov`);
   - `situacao` (`concluida` | `em_aberto` | `sem_sucesso` | `nao_licitado_atrasado` | `nao_licitado_no_prazo` |
     `sem_identificador`);
   - `itens_compra_homologados`, `itens_compra_em_andamento`, `itens_compra_sem_sucesso`;
   - `objeto_compra`;
   - `verificado_em`, `tentativas`, `erro`.

   O vínculo é oficial no sentido de que vem da numeração publicada, mas é **inferido**, e a coluna `metodo` diz isso.
   Nada é gravado em `pca_itens`, e o vínculo de plano (`pca_plano_id` nas compras) não muda.
5. **Sugestão derivada (opcional, separada).** O casamento por UASG, escopo e janela fica numa view
   `pca_grupo_sugestao`, rotulada "sugestão", e nunca preenche `situacao`. Ver a pergunta 4.
6. **Rotina:**
   - **diária**, depois do sync do PCA, só para os grupos novos, os não achados com data desejada até hoje + 30 dias e os
     `em_aberto` (para atualizar a situação);
   - **primeira carga:** os 1.166 grupos, cerca de 3.500 requisições no pior caso (3 modalidades), uns 60 min a
     1 req/s. É feita em fatias, com o mesmo padrão de fila e continuação da 0012;
   - erro de HTTP (429, 5xx, timeout) deixa o grupo com `erro` e não muda a `situacao` anterior. Erro não é "não
     licitado".
7. **API e radar.** `api-pncp-pca?visao=radar` passa a trazer, por item, `contratacao: { situacao, numero_controle_pncp,
   objeto, metodo, verificado_em }` do seu grupo. Itens sem grupo trazem `situacao = sem_identificador`. Campo novo,
   aditivo, sem mudar os atuais.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** `"180152-131/2026"`, **então** a chave é `('180152','131','2026')`. **Dado** `"90145-13/2026"`, **então** é `('090145','13','2026')`. **Dado** `null`, `""` ou `"ABC"`, **então** é `sem_identificador`. | Deno `tests/supabase/functions/_shared/pncp/pca_ifc_test.ts` |
| CA-2 | **Dado** uma compra na base com `unidade_codigo=180152`, `numero=131` e `ano=2026`, **quando** o grupo `180152-131/2026` é processado, **então** o vínculo é `metodo=ifc_base` com o `numero_controle_pncp` dessa compra, e não há requisição externa. | Deno `tests/supabase/functions/pca_ifc_vinculo_test.ts` |
| CA-3 | **Dado** um grupo fora da base e um cliente falso que responde 404/vazio para `MM=05` e responde a compra para `MM=06`, **então** o vínculo é `metodo=ifc_compras_gov`, o `idCompra` consultado é `{uasg}06{numero:05}{ano}` e não há terceira tentativa. | idem |
| CA-4 | **Dado** uma compra com itens `Homologado` e `Em andamento`, **então** a situação é `concluida`. Só `Em andamento` dá `em_aberto`. Só `Fracassado`, `Deserto` ou `Anulado/Revogado/Cancelado` dá `sem_sucesso`. | idem |
| CA-5 | **Dado** um grupo não achado, **então** a situação é `nao_licitado_atrasado` se a menor data desejada dos itens é anterior à data do processamento, e `nao_licitado_no_prazo` caso contrário. | idem |
| CA-6 | **Dado** que o Compras.gov devolve 429 ou 5xx, **então** o grupo fica com `erro` e `tentativas + 1`, e a `situacao` anterior é mantida. Nunca vira `nao_licitado_*`. | idem |
| CA-7 | **Dado** um orçamento de N grupos por invocação, **então** a invocação para em N, termina `incompleta` e a próxima continua sem repetir. | idem |
| CA-8 | `anon` e `authenticated` sem papel não escrevem em `pca_grupo_contratacao`. A leitura segue a mesma regra de `pca_itens`. Só `service_role` executa as funções de gravação. | SQL `supabase/tests/pca_grupo_contratacao_check.sql` |
| CA-9 | `api-pncp-pca?visao=radar` traz `contratacao` por item. Item sem grupo traz `situacao: "sem_identificador"`. Os campos atuais não mudam de nome nem de tipo. | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` |
| CA-10 | A view de sugestão nunca preenche `situacao` nem `numero_controle_pncp_compra` de `pca_grupo_contratacao`. | SQL `supabase/tests/pca_grupo_contratacao_check.sql` |
| CA-11 | **Regressão com dado real (pós-merge):** os grupos `180152-131/2026`, `158587-25/2026`, `158195-181/2026`, `102171-126/2026`, `102333-11/2026` e `785600-46/2026` ficam vinculados às compras `46377800000127-1-003879/2026`, `10764307000112-1-000217/2026`, `05055128000176-1-000153/2026`, `63025530000104-1-003857/2026`, `48031918000124-1-000622/2026` e `00394502000144-1-002874/2026`. O grupo `120645-183/2026` (Galeão, data desejada 10/11/2026) fica `nao_licitado_no_prazo` ou vinculado, nunca vinculado a `00394429000100-1-002061/2026`. | verificação pós-merge (skill `verificar-producao`), anotada no PR |

## Fora de escopo

- **Situação item a item dentro do grupo:** os itens da compra não trazem código de catálogo, e não há como parear o
  item do PCA com o item da compra sem heurística de texto.
- **Ampliar a coleta de compras para todas as UASG com PCA:** só as compras achadas pelo IFC entram (pergunta 3).
- **IFC de anos anteriores (2024/2025):** depende do sync do PCA desses anos (a 0012 aceita o ano, mas a carga é decisão
  à parte).
- **Ata, contrato e empenho** depois da homologação.
- **Front:** um PR separado no Dashboard, depois do backend no ar.

## Impacto em dados

- **Migration:** `<timestamp>_pca_grupo_contratacao.sql`, aditiva e idempotente. Tem a tabela, os índices por
  `(uasg, numero, ano)` e por `pca_plano_id`, as funções de gravação em `private` com `security definer` e `search_path`
  fixo, a view de sugestão e os grants.
- **Tabelas:** lê `pca_itens`, `pca_planos`, `licitacoes_externas` e `licitacao_itens`; escreve só
  `pca_grupo_contratacao` (e `licitacoes_externas`/`licitacao_itens`, se a resposta à pergunta 3 for gravar a compra).
- **ACL/RLS:** a tabela nova tem RLS. Leitura igual à de `pca_itens`; escrita só por `service_role`.
- **Backfill:** a primeira carga dos 1.166 grupos, em fatias, com dry-run antes. A contagem por `situacao` e por
  `metodo` vai para o PR.
- **Requisições:**
  - Compras.gov: até 3 por grupo na primeira carga (cerca de 3.500); depois, por dia, só os grupos pendentes;
  - PNCP: 1 por compra achada fora da base, para os itens.
  - Tudo a 1 req/s, com recuo em 429.
- **Edge Functions republicadas no merge:** todas. Muda a função de vínculo (nova ou `link-pca-edital`) e a
  `api-pncp-pca`.
- **Contrato com o Dashboard:** campo novo `contratacao` no radar, aditivo.
- **Dado oficial x derivado:**
  - **oficiais:** o código do grupo, o número, a UASG e o ano da compra, e a situação dos itens da compra;
  - **inferido:** o vínculo grupo → compra, pela regra de numeração. Isso é declarado em `metodo` e na interface;
  - **sugestão:** a view separada.
  - Nenhum valor é inventado.

## Perguntas em aberto

1. **Onde roda:** estender o `link-pca-edital` (hoje em dry-run, no nível do plano) ou criar uma função nova
   `link-pca-contratacao`? A proposta é uma função nova, para não misturar o vínculo de plano com o de grupo.
2. **Modalidades:** só foram medidos 05 (pregão) e 06 (dispensa) no `idCompra`. Incluir 07 e outras (concorrência,
   inexigibilidade) às cegas, ou medir antes numa amostra e só então incluir?
3. **Compra achada fora da base:** gravar em `licitacoes_externas` e `licitacao_itens` (amplia a coleta com compras
   fora do escopo de palavra-chave, como "material de expediente" que contém itens 7830), ou guardar só o resumo
   (situação e contagens) em `pca_grupo_contratacao`?
4. **Sugestão derivada:** expor a view de sugestão (UASG, escopo e janela) no radar, rotulada, ou deixá-la só para uso
   interno até medir a precisão?
5. **Limite de "atrasado":** basta a data desejada já ter passado, ou usar uma folga (por exemplo, 30 dias)?
