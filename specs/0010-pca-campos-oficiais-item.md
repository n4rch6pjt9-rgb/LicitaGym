# 0010: Guardar e mostrar os campos oficiais do item do PCA que hoje descartamos

- **Status:** rascunho
- **Issue:** nenhuma. Pedido do Marcelo em 09/10 ("escreve a spec do PCA"), depois da análise do HAR do plano
  da PF-AM no PNCP e da tela `/pca` com linhas sem descrição.
- **Área:** pncp (normalizador do PCA), migrations (`pca_itens`, `v_bi_pca_radar`), edge-functions (`api-pncp-pca`,
  `visao=radar`) e dashboard-contrato (`/pca` no Dashboard---LicitaGym)
- **Depende do ok do Marcelo:** sim. Tem migration e reprojeção dos itens já gravados em produção.

## Problema

- **Itens sem identificação no radar.** O radar `/pca` (spec 0006) mostra muitos itens sem nenhum texto. Em
  produção, 2026: 943 de 3.686 itens ativos têm `descricao` nula. Exemplo: item 435 do plano
  `00394494000136-0-000032/2026` (Academia Nacional de Polícia, UASG 200340), com PDM 18452 e
  R$ 125.000,00, sem descrição. Medido em 09/10 pelo MCP, só leitura.
- **A API oficial manda o texto, e nós descartamos.** O payload bruto que já guardamos (`private.source_record`,
  endpoint `/api/consulta/v1/pca/?anoPca=2026&...`, 233 páginas, coletadas até 09/10 10:34 UTC) traz em cada item
  21 campos. O `normalizePcaItem` (`supabase/functions/_shared/pncp/normalize.ts`) não grava 6 deles. Medição sobre
  3.880 itens únicos de 592 planos:

  | Campo oficial | Itens com valor | Hoje |
  |---|---|---|
  | `grupoContratacaoCodigo` / `grupoContratacaoNome` | 3.191 / 3.191 | descartado |
  | `pdmDescricao` | 2.784 | descartado (o doc diz "payload bruto", mas `pca_itens` não tem coluna bruta) |
  | `classificacaoSuperiorNome` | 3.880 | descartado (só o código vai para `classe_material_servico`) |
  | `unidadeRequisitante` | 525 | descartado |
  | `valorOrcamentoExercicio` | 3.880 (difere de `valorTotal` em 3.375) | descartado |

- **O que esses campos resolvem.** Dos 1.005 itens sem `descricaoItem`:
  - 329 têm `pdmDescricao`;
  - outros 611 têm só `grupoContratacaoNome`, por exemplo "Aquisição de bens de consumo destinados a suprir o
    NUMAT/SELOG no interesse da SR/AM";
  - 65 não têm nenhum dos três textos. Para esses resta `classificacaoSuperiorNome`, a classe CATMAT.
- **Quantidade e unidade vindas do órgão.**
  - 930 itens vêm com `quantidadeEstimada` 0 e 932 com `unidadeFornecimento` "-";
  - o dado é da fonte e fica como veio;
  - hoje o front mostra "0" e "-" como se fossem informação.

## Critérios de aceite

### Normalizador e sync (Deno)

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um item do PNCP com os 6 campos, **quando** passa por `normalizePcaItem`, **então** a linha tem `grupo_contratacao_codigo`, `grupo_contratacao_nome`, `pdm_descricao`, `classificacao_superior_nome`, `unidade_requisitante` e `valor_orcamento_exercicio` com o valor oficial. O texto é aparado, e o valor é numérico. `descricao` continua vindo só de `descricaoItem`. | Deno `tests/supabase/functions/_shared/pncp/normalize_pca_item_test.ts` |
| CA-2 | **Dado** um item sem esses campos, ou com string vazia, **então** cada um vira `null`. Nenhum texto é copiado de outro campo, e `descricao` nunca é preenchida com grupo ou PDM. | idem |
| CA-3 | **Dado** `quantidadeEstimada` 0 e `unidadeFornecimento` "-", **então** a linha grava 0 e "-" como vieram. O normalizador não corrige dado da fonte. | idem |
| CA-4 | **Dado** um item já gravado com o hash da versão atual do normalizador, **quando** a reprojeção roda, **então** ela reconhece o hash antigo como "versão anterior". Ela atualiza só as 6 colunas novas e não grava `pca_alteracoes`, porque não é mudança do órgão. | Deno `tests/supabase/functions/_shared/pncp/pca_reprojecao_classificacao_test.ts` |
| CA-5 | **Dado** o sync semanal depois da reprojeção, **quando** o órgão não mudou o item, **então** o resultado é `inalterado`, sem linha nova em `pca_alteracoes`. | idem (mock de `upsertByHash`) |

### Banco

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-6 | A migration acrescenta as 6 colunas em `pca_itens`, todas anuláveis e sem default inventado. Reaplicar não falha nem muda nada. | SQL `supabase/tests/pca_itens_campos_oficiais_check.sql` + `validar-migrations.sh` (2ª aplicação) |
| CA-7 | `v_bi_pca_radar` expõe as 6 colunas como campos próprios, preenchidas na linha do PNCP e `null` na do PGC. A view mantém uma linha por item (regressão do #286) e o grant só para `service_role`. | idem + `pca_radar_orgaos_duplicado_check.sql` continua verde |

### API: `api-pncp-pca?visao=radar`

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-8 | O item do radar traz `grupo_contratacao_codigo`, `grupo_contratacao_nome`, `pdm_descricao`, `classificacao_superior_nome`, `unidade_requisitante` e `valor_orcamento_exercicio`, com `null` quando ausente. Os campos atuais não mudam de nome nem de tipo. | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` |
| CA-9 | `valor_total_escopo` continua somando `valor_total`. `valor_orcamento_exercicio` não entra em nenhuma soma até decisão do Marcelo (pergunta 1). | idem |

### Front: `/pca` (Dashboard---LicitaGym, PR separado depois do backend no ar)

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-10 | **Dado** um item com `descricao`, **então** ela é o título. Sem `descricao`, o título vem do primeiro texto disponível, sempre com rótulo da origem: "PDM: …" (`pdm_descricao`), depois "Grupo de contratação: …" (`grupo_contratacao_nome`), depois "Classe: …" (`classificacao_superior_nome`). Sem nenhum, aparece "Descrição não informada pelo órgão". | vitest `src/test/PcaRadarView.test.tsx` |
| CA-11 | Quando há `descricao`, o grupo de contratação aparece como linha secundária. O código do grupo é mostrado para conferência no PNCP. | idem |
| CA-12 | `quantidade` 0 aparece como "não informada pelo órgão", e não como "0". `unidade_medida` "-" ou vazia aparece como ausente. | idem |
| CA-13 | `unidade_requisitante`, quando presente, aparece junto do órgão como "Requisitante: …". | idem |

## Fora de escopo

- **Busca textual nos campos novos** (filtro por grupo ou texto livre no radar): fica para uma spec própria, se
  pedida.
- **Usar `grupoContratacaoCodigo` para agrupar itens ou casar com a contratação publicada** (PCA → edital). Pode
  valer issue depois que o campo estiver no banco.
- **Mudar `pdm_codigo_origem` a partir de `pdmDescricao`, ou inferir PDM pelo texto.**
- **Campos `dataInclusao`, `dataAtualizacao` e `nomeClassificacaoCatalogo`** do item. Não foram pedidos, e o último
  repete `classificacaoCatalogoId`.
- **PGC (`pca_pgc_itens`):** a tabela está vazia em produção e tem outro payload.
- **As outras views com o mesmo join em `orgaos`** (`v_bi_orgaos_match`, `v_bi_fornecedor_historico`): issue à parte,
  já oferecida.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_pca_itens_campos_oficiais.sql`. É aditiva e idempotente:
  - `alter table ... add column if not exists`;
  - `create or replace view v_bi_pca_radar` com as colunas novas no fim, mantendo o lateral do #286;
  - `revoke all` + `grant select` a `service_role`.

  Não tem DDL destrutivo nem backfill dentro da migration.
- **Tabelas, views e funções tocadas:**
  - `public.pca_itens`: grava `sync-pncp-pca`; leem `api-pncp-pca`, as views de BI e `link-pca-edital`;
  - `public.v_bi_pca_radar`: lê `api-pncp-pca` (`visao=radar`);
  - `_shared/pncp/normalize.ts`: novo `normalizePcaItemLegacyV3`, igual ao atual, para reconhecer o hash;
  - `_shared/pncp/pca-reprojecao.ts`.
- **ACL/RLS:** nenhuma mudança. As colunas herdam a ACL da tabela.
- **Reprojeção dos itens já gravados:** sim, porque mudar o normalizador muda o `payload_hash` de todos os itens.
  - **Sem reprojeção**, o próximo sync marcaria cerca de 3,9 mil itens de 2026 (e os de outros anos) como `alterado`.
    Gravaria o mesmo número de linhas falsas em `pca_alteracoes`, o histórico de mudança do órgão.
  - **O caminho é o que já existe:** `scripts/ops/reprojetar-pca-classificacao.ts` (`runPcaReprojecaoClassificacao`)
    lê `private.source_record` e regrava com o normalizador atual. Tem `--dry-run`, snapshot e restauração, e não
    grava `pca_alteracoes`.
  - **Ordem:**
    1. merge (migration e função no ar);
    2. o Marcelo roda o script em dry-run, e a contagem vai para o PR;
    3. o Marcelo roda de verdade **antes do próximo sync PCA** (cron diário às 06:13 UTC).

    Se o sync rodar antes, o resultado é o ruído em `pca_alteracoes` descrito acima, sem perda de dado.
  - **Alternativa, se o Marcelo preferir não rodar o script:** o sync aceita a versão anterior do hash como
    "inalterado" e só completa as colunas novas (CA-5 vira o teste disso). Assim não há passo manual, mas o
    `upsertByHash` ganha um caso especial.
- **Edge Functions republicadas no merge:** todas, porque a integração republica tudo. As que mudam de fato são
  `sync-pncp-pca` (normalizador) e `api-pncp-pca` (campos no radar).
- **Contrato com o Dashboard:** muda de forma aditiva, com 6 campos novos no item do radar. O backend vai ao ar
  antes do PR do front.
- **Dado oficial x derivado:**
  - os 6 campos são oficiais, copiados do PNCP sem transformação além de aparar texto;
  - só o rótulo do título no front é derivado, e sempre mostra de qual campo veio;
  - 0 e "-" da fonte ficam no banco como vieram, e só a exibição diz "não informada pelo órgão".

## Perguntas em aberto

1. **`valorOrcamentoExercicio`:** difere de `valorTotal` em 3.375 de 3.880 itens. Pela leitura do nome, seria a
   parte do valor prevista para o orçamento de 2026, mas isso **não está confirmado** em documentação oficial que eu
   tenha lido. A proposta é guardar e mostrar a coluna no detalhe, sem somar no KPI. Quer também um KPI
   "Orçamento do exercício"?
2. **Reprojeção:** pode ser o script manual (padrão desta spec, sem caso especial no código) ou a tolerância
   automática no sync (sem passo manual)?
3. **Item sem quantidade:** quando a quantidade vier 0, o valor unitário também vem 0 e só o total é informado (como
   no item 435). Mostrar só o total, com "quantidade não informada pelo órgão", está bom?
