# 0057: Pôr o PGC no ar e mostrar seus dados no radar da rota PCA

- **Status:** em implementação (aprovada em 11/11/2026)
- **Alimenta:** etapa 1 (coleta) de `docs/produto/TRILHAS-E-INFORME.md`; módulo 1 de `docs/produto/ESCOPO.md` (Radar de
  oportunidades: demanda planejada). O `ESCOPO.md` está em revisão desde 11/11/2026 com a regra de foco suspensa.
  Complementa a spec 0056 (PCA em camadas, lado PNCP); não depende dela.
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** coletor, migrations (view do radar, índice), edge-functions (`api-pncp-pca`), dashboard-contrato,
  dashboard-tela
- **Depende do ok do Marcelo:** sim. Tem migration, muda o contrato da rota PCA e liga coleta nova em produção (Cloud
  Run Job e Cloud Scheduler são do Marcelo).

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template, e:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0056-pca-em-camadas.md` (branch `claude/spec-0056-pca-camadas`, PR #517) | lado PNCP do PCA; não duplicar eventos nem crons |
| 5 | `docs/produto/TRILHAS-E-INFORME.md` | etapa 1 (coleta) que esta spec alimenta |
| 7 | `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções das áreas tocadas |
| 8 | `services/coletor-externo/README.md` (seção do Job e `--coleta`) | como os Jobs rodam e são agendados |
| 8 | `services/coletor-externo/coletor/compras_pgc.py`, `coletor/main.py`, `coletor/paginacao.py` | coletor existente (nunca agendado) e entrada do Job |
| 8 | `supabase/migrations/20261002100000_bi_cruzamento_apis.sql` (tabela `pca_pgc_itens`), `20261009200000_pca_radar_pdm_oficial_confirmado.sql` (view atual) | schema e view que mudam |
| 8 | `supabase/functions/api-pncp-pca/radar.ts`, `tests/supabase/functions/api_pncp_pca_radar_test.ts` | contrato atual do radar |
| 8 | Dashboard: `src/components/pca/PcaView.tsx`, `src/components/pca/filtrosRadar.ts`, `src/data/pcaApi.ts`, `src/test/PcaRadarView.test.tsx`, `src/test/pca-radar-api.test.ts` | tela e cliente da rota |
| 9 | `docs/compras-gov/schemas-consultas.md` (item PGC), `docs/compras-gov/manual-api-compras-v2.0-2026-02.md` §7.2 | parâmetros e campos de retorno; o manual erra o `tipo` |

## Problema

Medido em 11/11/2026 (API ao vivo e banco de produção, só leitura):

- **O PGC nunca entrou em produção.** `public.pca_pgc_itens` está vazia; não há linha de PGC em
  `private.coleta_externa_run`; o coletor `coletor/compras_pgc.py` existe, mas não é chamado pelo `coletor.main`, não
  tem Job nem agendamento e não aparece no README. O ramo PGC de `v_bi_pca_radar` devolve 0 linhas, e a tela "PCA
  (Planejamento)" com fonte PGC mostra "0" sem aviso (print do Marcelo, 11/11).
- **A API funciona.** `GET /modulo-pgc/2_consultarPgcDetalheCatalogo` com `tipo=Material` responde 200. O manual v2.0
  diz `tipo=M`, que responde 400 ("Valores aceitos: Servico, Material"); o coletor já usa `Material`.

  | Ano | Classe | Linhas na API | Itens distintos no escopo (34 PDMs) | UASGs | Valor distinto no escopo |
  |---|---|---|---|---|---|
  | 2026 | 7830 + 7220 | 2.467 + 716 | 842 | 148 (64 órgãos) | R$ 240.228.389,22 |
  | 2027 | 7830 + 7220 | 415 + 119 | 160 | 46 (26 órgãos) | R$ 14.648.854,08 |

  Valor = soma de `valorTotalItem` declarado no plano, sem repetição; não é compra feita.
- **O PGC tem o que o PNCP não tem.** Dos itens distintos de 2026 no escopo, cruzados com `pca_itens` por órgão + UASG
  + número do item: 845 chaves, 626 já vêm do PCA do PNCP e **219 só existem no PGC** (UASGs inteiras ausentes, ex.:
  760000 com 24 itens, 160204 com 11). **2027: o banco não tem nenhum plano**; o PGC já tem 160 itens no escopo.
- **Linhas repetidas.** Em 2026, 834 chaves do upsert (`orgao_cnpj, codigo_uasg, ano, numero_item_pncp,
  codigo_item_catalogo`) aparecem mais de uma vez (até 9×); 425 delas na mesma página. Em 503 o conteúdo difere
  (`statusContratacaoExecucao` em 283, datas de atualização do projeto, artefato, DFD e item). Upsert em lote com chave
  repetida falha no Postgres ("ON CONFLICT DO UPDATE command cannot affect row a second time"); o coletor não
  deduplica antes de gravar (não testado ao vivo: o coletor nunca rodou).
- **Campos perdidos.** A tabela guarda todos os campos de retorno, mas o radar expõe 18 colunas. Ficam fora: nome do PDM
  e da classe (100% preenchidos), unidade de fornecimento (100%), título do projeto (100%), descrição do projeto (45%),
  objeto do DFD (100%), início, fim e duração do processo de compra (100%, 100%, 92%), artefato (100%), última
  atualização do item (100%). A view junta `dataPrevistaFormalizacaoDemanda` e `dataInicioProcessoCompra` numa só
  `data_prevista`, que significam coisas diferentes.
- **Status sem dicionário.** O manual diz que `statusContratacaoExecucao` é booleano; vêm 11 códigos (1: 645, 11: 178,
  4: 140, 2: 36, 21: 25, 17: 17, 13: 7, 10: 7, 5: 4, 23: 1; nulo: 674 linhas do escopo 2026).
- **Lentidão.** `v_bi_pca_radar` junta `orgaos` por `cnpj`, que não tem índice simples (só `regexp_replace(cnpj, ...)`
  e `cnpj_cpf_orgao_norm`): seq scan de cerca de 12.200 linhas por órgão. `count(*)` da view estoura o tempo limite;
  `api-pncp-pca` respondeu 200 nas 14 chamadas das últimas 24 h, média de 3.265 ms (logs, 11/11).
- **Seletor de ano.** A tela abre no ano corrente; 2027 não é oferecido (não medido se o filtro aceita 2027 pela URL).

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Coletor `compras_pgc` no Job: `--coleta pgc` em `coletor.main` | `--anos` (padrão: ano corrente e seguinte), `--classes` (padrão `7830,7220`) | Para cada ano e classe, lê todas as páginas (`tipo=Material`); **deduplica por chave do upsert antes de gravar**, ficando com a linha de `dataHoraAtualizacaoItem` mais recente (empate: `dataHoraAtualizacaoArtefato`, depois a última lida); grava em `pca_pgc_itens`; devolve e registra no log o resumo da execução (lidos, gravados, repetidos descartados, sem chave, erros). Não usa `private.coleta_externa_run`: a FK de `fonte` aponta para `fontes_externas`, que é a lista de portais de licitação. Página fora do formato ou erro HTTP esgotado = erro da classe, não "fim" | sai com código 1 se qualquer classe falhar; 429/503 com `Retry-After` e backoff | Cloud Run Job (agendamento do Marcelo) |
| K-2 | Migration: índice em `orgaos(cnpj)` e nova `v_bi_pca_radar` | — | Índice btree em `public.orgaos (cnpj)`. View com as colunas atuais **mais** `nome_pdm`, `nome_classe`, `unidade_fornecimento`, `titulo_projeto`, `descricao_projeto`, `objeto_dfd`, `data_formalizacao_demanda`, `data_inicio_processo`, `data_fim_processo`, `duracao_processo_dias`, `artefato`, `atualizado_na_fonte_em`, `status_execucao_codigo` e `mes_inicio_processo` (para o `data_base` do K-3). `data_prevista` mantém o comportamento atual (compatibilidade). Do lado PNCP, cada coluna nova vem do campo equivalente de `pca_itens` quando existir e é nula quando a fonte não tiver; nunca derivada. Ramo PGC deduplicado pela chave do K-1 | — | leitura só `service_role` (como hoje); `security_invoker` mantido |
| K-3 | `api-pncp-pca` radar: campos novos e filtro de data | parâmetros atuais + `data_base` (`formalizacao` \| `inicio_processo`; padrão `formalizacao`) para `mes` / `mes_de` | Itens com as colunas novas do K-2; `status_execucao_codigo` vai cru, **sem rótulo**, até haver dicionário (P-2) | 400 em `data_base` inválido; demais como hoje | usuário autenticado (`requireUserAuth`), escopo do catálogo da empresa como hoje |
| K-4 | Saúde: `pgc_dias_sem_coleta` em `private.saude_operacional_resumo()` | — | dias desde a última gravação do PGC (`max(last_synced_at)` de `pca_pgc_itens`, mesmo critério de `precos_dias_sem_coleta`); atenção 1,5 dia, crítico 8 dias, sem dado = atenção (tabela vazia até a 1ª coleta; só crítico abre a issue `alerta-operacional`); `saude.yml` passa a esperar a verificação | — | `api-saude` (como hoje) |
| K-5 | Dashboard: tela "PCA (Planejamento)" | resposta do K-3 | Seletor de ano com ano corrente e seguinte; **na linha**: título do projeto, PDM por nome, quantidade **com unidade** e janela do processo (início–fim), além das colunas atuais; **no detalhe expandido**: objeto do DFD, descrição do projeto, artefato, classe e última atualização na fonte; status de execução não aparece; seletor "Data de referência" (formalização × início do processo); fonte PGC vazia com o aviso "sem coleta do PGC" quando a saúde do K-4 não estiver ok, em vez de "0" | estados de carregando, vazio e erro explícitos | usuário autenticado |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** uma página da API com a mesma chave em três linhas (`dataHoraAtualizacaoItem` 09/05, 12/06 e 12/06 com artefato mais novo) e outra chave única, **quando** o coletor grava, **então** envia 2 linhas ao upsert, a escolhida é a de artefato mais novo, e a execução registra 2 gravados e 2 repetidos descartados (regressão do lote que falharia) | pytest `services/coletor-externo/tests/test_compras_pgc.py` (`test_ca1_*`, 4 testes) ✅ |
| CA-2 | K-1 | **Dado** `--coleta pgc` sem `--anos` em 11/11/2026, **quando** o Job roda com a API simulada, **então** consulta 2026 e 2027 nas classes 7830 e 7220 com `tipo=Material` (nunca `M`), e uma resposta 400 de uma classe faz o Job sair com código 1 e registrar o erro da classe | pytest `test_compras_pgc.py` (`test_ca2_*`, 3 testes) ✅ |
| CA-3 | K-2 | **Dado** os papéis `anon` e `authenticated`, **quando** leem `v_bi_pca_radar` por PostgREST, **então** recebem erro de permissão; `service_role` lê; o índice `orgaos (cnpj)` existe; a migration roda duas vezes sem erro | SQL `supabase/tests/pca_radar_pgc_campos_check.sql` (A, B) + `validar-migrations` ✅ |
| CA-4 | K-2 | **Dado** um item do PGC gravado duas vezes com DFDs diferentes e um item do PNCP que também está no PGC, **quando** se lê a view, **então** o primeiro aparece uma vez com `titulo_projeto`, `objeto_dfd`, `unidade_fornecimento` e `data_inicio_processo` iguais aos gravados, e o segundo aparece uma vez, com fonte PGC (regra atual: o PGC prevalece) | SQL `pca_radar_pgc_campos_check.sql` (C a F) ✅ |
| CA-5 | K-3 | **Dado** uma chamada sem sessão válida, **quando** pede o radar com os parâmetros novos (`data_base`), **então** recebe 401 antes de qualquer cliente `service_role` (o radar não filtra por empresa: escopo global de `catalogo_catmat_pdms_efetivos()`, PCA é dado público) | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` (`0057 CA-5`) ✅ |
| CA-6 | K-3 | **Dado** um item com formalização em 2026-04 e início do processo em 2026-11, **quando** o radar é chamado com `mes_de=2026-11` e `data_base=inicio_processo`, **então** o item vem; com `data_base=formalizacao` (ou sem o parâmetro), não vem; `data_base=xyz` responde 400 | Deno `api_pncp_pca_radar_test.ts` (`0057 CA-6`, 2 testes; `0057 K-3`) ✅ |
| CA-7 | K-4 | **Dado** a última gravação do PGC (`last_synced_at`) há 9 dias, **quando** se lê a saúde, **então** `pgc_dias_sem_coleta = 9` e o nível é crítico | SQL `supabase/tests/saude_pgc_check.sql` ✅ |
| CA-8 | K-5 | **Dado** o radar devolvendo um item PGC com quantidade 20 e unidade `M2`, **quando** a tela renderiza, **então** a linha mostra "20 M2", o título do projeto, o nome do PDM e a janela do processo, o objeto do DFD aparece só
no detalhe expandido e nenhum status de execução aparece; o seletor de ano oferece 2026 e 2027; e com a saúde do PGC crítica e fonte PGC, mostra o aviso de coleta ausente em vez de "0" | vitest `src/test/PcaRadarView.test.tsx` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | Marcelo cria o Job/agenda; skill `verificar-producao` (execução em `coleta_externa_run`, linhas em `pca_pgc_itens`) |
| K-2 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (view lida por `service_role`) | `verificar-producao` + `get_advisors` (security e performance) |
| K-3 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` (auth, `service_role`, tenant) | `verificar-producao` |
| K-4 | `/spec` | skill `nova-migration` | `validar-migrations` | `revisor-migration` | `verificar-producao` |
| K-5 | `/spec` | agente `frontend-dashboard` | vitest; skill `run-dashboard` (claro, escuro, celular) | `revisor-codigo` + `revisor-seguranca` (pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `deploy-dashboard` |

## Fora de escopo

- Itens de serviço do PGC (`tipo=Servico`): o escopo é material.
- Eventos de alteração do PGC (`pca_alteracoes`): a 0056 trata eventos do lado PNCP; PGC fica para depois de medir a
  coleta diária.
- Rótulo do `statusContratacaoExecucao` (P-2).
- Ligar item do PGC a edital publicado (`link-pca-edital` já faz pelo lado PNCP).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_pca_radar_pgc_campos.sql` (aditiva: índice, `create or replace
  view` com colunas novas no fim, função de saúde). Idempotente.
- **Tabelas/views/funções tocadas:** `public.orgaos` (índice); `public.v_bi_pca_radar` (lida pela `api-pncp-pca`);
  `public.pca_pgc_itens` (escrita pelo coletor, `service_role`); `private.coleta_externa_run` (escrita pelo coletor);
  `private.saude_operacional_resumo()` (lida pela `api-saude`).
- **ACL/RLS:** nenhum grant novo; a view continua sem grant para `anon`/`authenticated`.
- **Backfill/reprocessamento:** a primeira execução grava 2026 e 2027 inteiros (estimativa pela API em 11/11:
  2026 = 1.495 chaves distintas, 2027 = 398, todas as classes 7830/7220, não só o escopo). Dry-run do coletor no PR com
  essas contagens.
- **Edge Functions republicadas no merge:** todas (o merge na `main` republica todas); muda `api-pncp-pca`.
- **Contrato com o Dashboard:** muda (campos novos e `data_base`; aditivo, campos atuais mantidos). Backend antes.
- **Dado oficial x derivado:** todos os campos novos vêm da API do PGC ou do PCA do PNCP, como vieram. A deduplicação
  escolhe uma linha da fonte (não mistura campos de linhas diferentes). Nada é calculado além de `duracao_processo_dias`,
  que já vem da fonte.

## Decisões do Marcelo

- 11/11/2026: "ela precisa acompanhar os principais dados de retorno da própria api" (rota PCA deve mostrar os campos de
  retorno do PGC).
- 11/11/2026, P-1: coleta **diária** (mesmo ritmo da 0056 no PNCP).
- 11/11/2026, P-3: uma linha por item, a de **atualização mais recente** (regra do K-1).
- 11/11/2026, P-4: o filtro "a partir de" usa por padrão a **data de formalização da demanda**; `data_base` permite
  trocar para o início do processo.
- 11/11/2026, P-2: buscar o dicionário dos códigos de status antes de mostrar rótulo. Busca feita em 11/11: o manual
  v2.0 (§7.2) diz "Booleano"; o OpenAPI oficial (`/v3/api-docs`) declara só `integer`; as páginas do gov.br sobre o PGC
  e a "Execução do PCA" não listam códigos. **Dicionário não encontrado em fonte pública.**
- 11/11/2026, P-2 (fechamento): `statusContratacaoExecucao` é **código opaco**. Guardar o valor bruto (texto, sem
  converter para booleano), não mostrar rótulo na tela e abrir chamado no suporte do Compras.gov.br
  (portaldeservicos.gestao.gov.br) citando o campo e os valores observados. Valores vistos em 11/11/2026: `1, 2, 4, 5,
  7, 10, 11, 13, 14, 17, 21, 23` e nulo (união de `2_consultarPgcDetalheCatalogo` 2026–2027 classes 7830/7220 com
  amostra de `1_consultarPgcDetalhe` de 5 órgãos 2024–2025; amostra, não lista fechada). `codigoEstadoArtefato` veio 9
  em todas as linhas e não explica a variação. Hipótese não confirmada: os códigos seriam a situação da contratação na
  execução do PCA ("Preparação", "Análise jurídica", "Ajustes finais", "Encerrada"...). Quando o dicionário chegar, o
  rótulo entra por tabela versionada com a fonte, em spec própria.

- 11/11/2026, P-5: ficam **na linha** da tabela os quatro: título do projeto, quantidade com unidade, janela do processo
  (início–fim) e PDM por nome. Objeto do DFD, descrição do projeto, artefato, classe e última atualização vão para o
  detalhe expandido. Status de execução não aparece (P-2).

- 11/11/2026: spec aprovada ("Aprovo, abre PR").
- 11/11/2026, na implementação: K-1/K-4/CA-7 seguem o precedente dos preços (saúde por `last_synced_at`, sem
  `coleta_externa_run`, cuja FK de fonte é a lista de portais); índice chamado `orgaos_cnpj_btree_idx` porque
  `orgaos_cnpj_idx` foi o índice único removido em 20260930130000.
- 11/11/2026, na implementação: CA-4 corrigido (o PGC prevalece, como a view atual já faz) e CA-5 sem a parte "outra
  empresa" (o radar não filtra por tenant; filtro por empresa vira spec própria).

## Perguntas em aberto

- Nenhuma.
