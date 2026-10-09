# 0011: Mostrar no radar do PCA a unidade compradora (UASG) e filtrar por esfera, poder e tipo de órgão

- **Status:** rascunho
- **Issue:** nenhuma. Pedido do Marcelo em 09/10, sobre o `/pca` filtrado pelo Comando do Exército:
  "cada órgão debaixo do guarda-chuva do COMANDO DO EXÉRCITO tem CNPJ e UASG próprios; na nossa tabela temos campos
  que podem enriquecer os filtros como Esfera | Poder | Tipo de Órgão".
- **Área:** migrations (`v_bi_pca_radar`), edge-functions (`api-pncp-pca`, `visao=radar`) e dashboard-contrato (`/pca`)
- **Depende do ok do Marcelo:** sim. Tem migration (view) e muda o contrato do radar.

## Problema

- **Todas as linhas mostram o CNPJ do órgão superior.** No radar, cada linha traz o CNPJ do plano (`pca_planos.orgao_cnpj`).
  O PCA federal é publicado pelo órgão superior, com um plano por unidade. Em
  `/pca?pdm=2640&orgao=00394452000103`, "COM. 09 BRIGADA INFANTARIA MOTORIZADA", "4 REGIMENTO DE CARROS DE COMBATE",
  "2º CENTRO DE GEOINFORMAÇÃO" e outras aparecem todas com 00.394.452/0001-03 (Comando do Exército). Cada unidade tem
  UASG e CNPJ próprios.
- **O banco já tem a unidade.** `public.uasgs`, vinda do Compras.gov, tem por `codigo_uasg` o CNPJ da unidade
  (`cnpj_cpf_uasg`), UF, município, esfera, poder e tipo de órgão. Medido em produção em 09/10, só leitura:
  - **Casamento:** 482 dos 551 planos ativos de 2026 casam `pca_planos.unidade_codigo = uasgs.codigo_uasg`.
  - **Sem casamento:** os 69 restantes são unidades com código próprio, que não é UASG do SIASG. Exemplo: as
    secretarias do Estado do RJ, CNPJ 42498600000171, códigos 404500, 570100…
  - **CNPJ da unidade:** 213 planos casados têm CNPJ próprio, e em 174 ele é diferente do CNPJ do plano. Exemplo:
    1 BATALHÃO DE ENGENHARIA DE CONSTRUÇÃO, UASG 160339, CNPJ 00.394.452/0031-10, Caicó/RN.
  - **DV do CNPJ:** os 5.492 CNPJs próprios de UASG passam no DV depois de completar com zeros à esquerda até 14
    dígitos. A fonte grava sem esses zeros (ex.: `394452003110`).
  - **UF, esfera, poder e tipo:** preenchidos nos 482. O município está em 480.
- **Distribuição dos planos de 2026, por esfera, poder e grupo de tipo:**
  - F/E segurança e defesa: 177;
  - F/E educação: 73;
  - F/E executivo federal: 67;
  - M/E executivo municipal: 39;
  - E/E segurança e defesa: 34;
  - sem UASG: 69;
  - os demais grupos têm menos de 30 planos cada.
- **O link "Abrir PCA no PNCP" continua por CNPJ do plano e ano.** O PNCP só tem a página consolidada
  `/app/pca/{cnpj}/{ano}`, que lista todas as unidades. Não há URL por unidade.

## Critérios de aceite

### Banco (`v_bi_pca_radar`)

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um plano cujo `unidade_codigo` existe em `uasgs`, **então** a linha traz `unidade_nome` (`nome_uasg`), `unidade_cnpj` (`cnpj_cpf_uasg` só com dígitos e completado até 14), `unidade_uf`, `unidade_municipio`, `esfera`, `poder`, `tipo_orgao` e `grupo_tipo`. O `orgao_cnpj` continua sendo o do plano. | SQL `supabase/tests/pca_radar_unidade_uasg_check.sql` |
| CA-2 | **Dado** um plano sem UASG correspondente, **então** as colunas novas vêm `null` e a linha continua no radar. Nada é inferido do CNPJ do plano. | idem |
| CA-3 | **Dado** `cnpj_cpf_uasg` nulo, só com zeros ou com DV inválido, **então** `unidade_cnpj` vem `null`. | idem |
| CA-4 | A view continua com uma linha por item, sem a multiplicação do #286, porque `uasgs.codigo_uasg` é único. O grant continua só para `service_role`. | idem + `pca_radar_orgaos_duplicado_check.sql` |

### API: `api-pncp-pca?visao=radar`

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-5 | O item traz os campos do CA-1, com `null` quando ausente. Os campos atuais não mudam. | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` |
| CA-6 | Filtros novos, aplicados no banco: `esfera` (F, E, D, M ou N), `poder` (E, L, J ou N) e `grupo_tipo` (valor de `orgao_tipos`). Valor fora da lista dá 400 com mensagem. | idem |
| CA-7 | O filtro `orgao` passa a casar também `unidade_cnpj` e `unidade_nome`, além do CNPJ e do nome do plano. Buscar o CNPJ do Exército continua trazendo todas as unidades. | idem |

### Front: `/pca`

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-8 | Na coluna Órgão, o nome da unidade e o CNPJ dela ficam em destaque quando existem, com "UASG nnnnnn · Município/UF" logo abaixo. Na linha seguinte vem o órgão do plano, por exemplo "PCA de: COMANDO DO EXÉRCITO · 00.394.452/0001-03". Sem unidade, a coluna fica como hoje. | vitest `src/test/PcaRadarView.test.tsx` |
| CA-9 | O link "Abrir PCA no PNCP" continua usando o CNPJ do plano e o texto deixa claro que abre o PCA consolidado do órgão. | idem |
| CA-10 | Selects de Esfera, Poder e Tipo de órgão na barra de filtros, com estado na URL. A opção "sem classificação" não existe, porque o filtro só restringe. | idem |
| CA-11 | Esfera, poder e tipo aparecem rotulados como classificação do LicitaGym (ver "Dado oficial x derivado"), e não como dado do PNCP. | idem |

## Fora de escopo

- **Inferir unidade para os 69 planos sem UASG,** por nome ou outro meio.
- **Filtro por UF e município.** A spec 0006 decidiu "sem UF". Ver a pergunta 1.
- **Classificar ou corrigir `tipo_orgao` e `grupo_tipo`.** As regras ficam em `orgao_tipo_regras` e não mudam aqui.
- **As outras views com join em `orgaos`** (`v_bi_orgaos_match`, `v_bi_fornecedor_historico`).

## Impacto em dados

- **Migration:** sim, `<timestamp>_pca_radar_unidade_uasg.sql`. Recria `v_bi_pca_radar` com `left join public.uasgs u on
  u.codigo_uasg = <unidade/uasg>` e colunas novas no fim. É aditiva e idempotente, sem backfill.
  - Esta spec e a 0010 mexem na mesma view. A que for implementada depois parte da definição da anterior, e a ordem
    das migrations segue a ordem dos merges.
- **Tabelas lidas:** `public.uasgs`, só leitura e só por `service_role` via a view. O join é pela chave única
  `uasgs_codigo_uasg_key`.
- **ACL/RLS:** nenhuma mudança.
- **Edge Functions republicadas no merge:** todas, como sempre. Muda só a `api-pncp-pca`, nos filtros e campos novos.
- **Contrato com o Dashboard:** aditivo. Os campos e filtros novos vêm primeiro no backend, depois no front.
- **Dado oficial x derivado:**
  - **Oficiais, do Compras.gov:** `codigo_uasg`, `nome_uasg`, `cnpj_cpf_uasg` (só completado com zeros) e UF/município
    do IBGE.
  - **`esfera_canon` e `poder_canon` são derivados:**
    - calculados por `fn_esfera_canon`, a partir da natureza jurídica, da esfera do Compras e da do PNCP (com
      prioridade nessa ordem), e por `fn_poder_canon`;
    - migration `20260930130100`;
    - o Compras.gov dá "poder" com 58,8% de concordância e foi descartado.
  - **`tipo_orgao` e `grupo_tipo` são classificação do LicitaGym:** em 44.731 UASGs foram herdados do órgão, em 994
    vêm de regra da UASG e em 4 de override manual.
  - O front mostra esses quatro como classificação, e não como dado oficial.

## Perguntas em aberto

1. **UF e município:** a spec 0006 tirou o filtro de UF. Agora que a UF da unidade está disponível em 482 de 551 planos,
   quer o filtro por UF? A proposta é mostrar Município/UF na coluna Órgão (CA-8) em qualquer caso.
2. **Filtro de tipo:** pelo `grupo_tipo` (16 grupos, como segurança e defesa, educação ou executivo municipal)
   ou pelo `tipo_orgao` detalhado (54 tipos, como forcas_armadas_exercito)? A proposta é `grupo_tipo` no select, com o `tipo_orgao`
   aparecendo só como texto na linha.
3. **Busca por órgão:** o CA-7 faz o CNPJ de uma unidade (ex.: 00.394.452/0031-10) achar só os itens dela. Está bom, ou
   a busca pelo CNPJ da unidade deveria trazer o PCA inteiro do órgão superior?
