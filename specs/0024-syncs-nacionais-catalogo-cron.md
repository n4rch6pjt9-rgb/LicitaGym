# 0024: Ligar os syncs nacionais do PNCP pelo catálogo CATMAT da empresa, com cron diário e disparo manual

- **Status:** rascunho
- **Issue:** #363 (decisões do Marcelo em 14/10/2026 nos comentários)
- **Área:** edge-functions + migrations (cron) + dashboard-contrato
- **Depende do ok do Marcelo:** sim (migration de cron, republicação de funções, mudança de classificação e de dado de produção)

## Problema

A tela de sincronizações mostra "Editais PNCP" com HTTP 423 (`Sync nacional "contratacoes-editais" fora do escopo
LicitaGym (classes 7830, 7220)`). Medido em 14/10/2026 (código em `origin/main` `b2710d4` e MCP somente leitura):

- **Escopo fixo no código.** `_shared/pncp/catmat-scope-resolver.ts:25-38` (`TRANSITIONAL_FITNESS_SCOPE`: 78/7830 CORE,
  72/7220 CURATED_EXTENSION; cabeçalho: "persistir em tabela fica para depois"). O gate
  `_shared/pncp/licitagym-scope-gate.ts` (`PNCP_NATIONAL_SYNC_ENABLED`, 423) é chamado por
  `sync-pncp-contratacoes-editais`, `-atas` e `-contratos`; `sync-pncp-irp` tem gate próprio (`IRP_SYNC_ENABLED`,
  "endpoint não verificado, CLA-34"); `sync-pncp-contratacoes-itens` não tem gate. A mesma constante alimenta
  `assertPcaClassificacoesInScope` (default do `sync-pncp-pca`, `licitagym-catmat.ts:31-43`) e
  `assertCatmatClasseInScope` (`sync-compras-catmat`).
- **O catálogo da empresa existe e já é fonte em outros pontos.** `private.catalogo_classes_efetivas()` (migration
  `20261011100300`), consumida por `_shared/catalogo-classes.ts` (`classesDoCatalogo`, `resolverClasses`: "nada fica
  fixo no código"; catálogo vazio = 409), `api-pncp-pca` (histórico), `link-pca-edital`, `api-catmat`, `api-precos`.
  Estado do catálogo em 14/10: 152 regras, 65 incluídas; grupo 78 incluído; classes 7810, 7820 e **7830 excluídas**
  no nível de classe; 16 PDMs incluídos e 51 itens incluídos. O conjunto efetivo de classes não foi medido (a função
  é só `service_role`); a regra "PDM efetivo incluído traz a classe" faz 7830 voltar pelos PDMs incluídos.
- **Duas fontes de verdade.** Classe cadastrada em `/catmat` não libera editais, atas, contratos nem o default do
  `sync-pncp-pca`. Contradiz `_shared/catalogo-classes.ts:3-4` e a decisão do Marcelo em 14/10 ("escopo = o que o
  catálogo da empresa diz").
- **Nunca entraram no cron.** Em `supabase/migrations/202609180008_cron.sql:108-140` os `cron.schedule` de
  editais/atas/contratos estão comentados; itens e IRP nunca tiveram job. `cron.job` em produção (14/10): 19 jobs,
  nenhum para esses cinco. `docs/pncp/cron-sync-jobs.md:18-22`: "não agendar".
- **A tela não lê o cron.** `api-syncs/catalogo.ts` tem `cron` e `aviso` como texto fixo; `api-syncs/index.ts` não
  consulta `cron.job` nem `private.cron_edge_chamadas`. "Nunca entrou no cron." e "Disparo manual indisponível" são
  do Dashboard (`src/components/settings/SyncView.tsx:115-119`).
- **Dados hoje.** `contratacoes_editais`: 1.197 linhas (publicadas de 21/08 a 18/09/2026, 10 modalidades, última
  gravação em 20/09); `contratacoes_atas` 0; `contratacoes_contratos` 0; `contratacoes_itens` 80 (coluna
  `codigo_material_servico` = código CATMAT do item). Só **8** desses 1.197 editais existem em `licitacoes_externas`
  (`numero_controle_pncp` = `codigo_externo`): a lista de oportunidades (1.651 PNCP) vem do coletor Python, por
  termos de texto, não dos syncs.
- **Hash incompatível** (spec 0023, `revisor-codigo` 14/10): `coletor/proveniencia.py` e `_shared/pncp/hash.ts`
  (`stableStringify` + `VOLATILE_KEYS`) dão hashes diferentes para o mesmo payload (`150000.0` vs `150000`).

Decisões já tomadas (Marcelo, 14/10/2026, #363): escopo = catálogo da empresa (sai a regra fixa 7830/7220, também das
instructions); cron **diário** e **disparo manual** para editais, atas, contratos e itens; IRP entra; depois disso os
syncs nacionais passam a alimentar `licitacoes_externas` com a proveniência da spec 0023.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o catálogo da empresa com classes efetivas, **quando** `sync-pncp-contratacoes-editais`, `-atas`, `-contratos`, `-itens` ou `sync-pncp-irp` recebe uma chamada autenticada, **então** não há 423 por `PNCP_NATIONAL_SYNC_ENABLED`/`IRP_SYNC_ENABLED`; o escopo vem de `classesDoCatalogo` e um catálogo vazio devolve 409 com a mensagem de `resolverClasses` (sem cair na constante). | Deno `tests/supabase/functions/scope_catalogo_test.ts` (gate com cliente falso: catálogo `['7830']` → segue; `[]` → 409; `PNCP_NATIONAL_SYNC_ENABLED` ausente → segue) |
| CA-2 | **Dado** `sync-pncp-pca` sem `codigos_classificacao` e `sync-compras-catmat` com par grupo/classe, **então** o default e a guarda usam `classesDoCatalogo`; `TRANSITIONAL_FITNESS_SCOPE`, `PNCP_PCA_CLASSIFICACOES` e `LICITAGYM_SCOPE_GATE` deixam de existir no código. | Deno `tests/supabase/functions/scope_catalogo_test.ts` + `grep` no CI (`scripts/ci/lint-alterados.sh` falha se a constante voltar: teste Deno que lê os arquivos e procura a string) |
| CA-3 | **Dado** um edital em `contratacoes_editais` com itens em `contratacoes_itens`, **quando** o sync de itens grava e **ao menos um item** tem `codigo_material_servico` cujo item, PDM ou classe está no catálogo efetivo da empresa, **então** a licitação é gravada em `licitacoes_externas` com `fonte='pncp'`, `codigo_externo=numero_controle_pncp`, `raw`, `payload_hash`, `ingestao_origem` (do corpo `origem`) e `ingestao_em`; edital sem item no catálogo não entra. | Deno `tests/supabase/functions/editais_para_oportunidades_test.ts` + SQL `supabase/tests/editais_oportunidades_check.sql` (fixture: 2 editais, 1 com item no catálogo) |
| CA-4 | **Dado** uma compra já gravada pelo coletor Python (mesmo `codigo_externo`), **quando** o sync regrava, **então** não apaga nem zera `prioridade`, `categoria_escopo`, `fase`, `termos_busca`, `interesse_borracha` (só envia as colunas que ele mesmo calcula); e a proveniência passa a ser a do sync (última passagem). CA de regressão: a lista não pode perder leads. | SQL `supabase/tests/editais_oportunidades_check.sql` (linha pré-existente com `prioridade='leads'` continua `leads`) |
| CA-5 | **Dado** o mesmo payload, **então** `coletor/proveniencia.py` e `_shared/pncp/hash.ts` produzem o mesmo `payload_hash` (uma só serialização: chaves ordenadas, números no formato JSON canônico, mesmas chaves voláteis descartadas nos dois lados). | pytest `services/coletor-externo/tests/test_hash_cruzado.py` + Deno `tests/supabase/functions/hash_cruzado_test.ts` lendo o mesmo fixture `tests/fixtures/hash_cruzado.json` com o hash esperado |
| CA-6 | **Dado** a migration de cron aplicada, **então** existem jobs diários `licitagym-sync-pncp-contratacoes-editais`, `-atas`, `-contratos`, `-itens` e `licitagym-sync-pncp-irp` chamando `private.cron_chamar_edge` com corpo `{"origem": "cron", ...}`, escalonados (horários na migration) e dentro do orçamento de CPU já usado pelo `sync-pncp-pca` (`async` + retomada); `api-syncs` `rodar` continua mandando `origem: "manual"`. | SQL `supabase/tests/cron_syncs_nacionais_check.sql` (onde há pg_cron) + Deno `api_syncs_test.ts` |
| CA-7 | **Dado** `action: "listar"` da `api-syncs`, **então** `cron` de cada item vem de `cron.job` (via função `private` só `service_role`, ex.: `private.cron_jobs_resumo()` com jobname, schedule, active, última chamada em `private.cron_edge_chamadas`), não de texto fixo; sync sem job devolve `cron: null`. | Deno `tests/supabase/functions/api_syncs_test.ts` (cliente falso devolve 2 jobs; a resposta reflete) + SQL `supabase/tests/cron_syncs_nacionais_check.sql` (função existe, ACL) |
| CA-8 | **Dado** `anon` ou usuário sem `app_metadata.licitagym_role = 'admin'`, **quando** chama `api-syncs` `rodar` ou qualquer `sync-*` sem o cron secret, **então** 401; `private.cron_jobs_resumo()` sem `execute` para `anon`/`authenticated`. CA negativo. | Deno `api_syncs_test.ts` + SQL check |
| CA-9 | **Dado** o PR, **então** traz o dry-run com contagem antes/depois: editais em `contratacoes_editais` que entrariam em `licitacoes_externas` pela regra do catálogo (hoje não medido), e quantos já existem pelo coletor Python (8 em 14/10). | relatório no PR (saída de um modo `dry_run: true` do sync de itens, coberto por teste Deno) |

## Fora de escopo

- Cloud Run Job do coletor Python (#187) e coleta recorrente por texto (#357): continuam como estão; o coletor segue
  gravando por termos, com `--origem`.
- Taxonomia oficial × curadoria (#272); mudar as regras do catálogo (`catalogo_empresa_catmat`) em si.
- Rever o escopo CATMAT da empresa (hoje 7810/7820/7830 excluídas no nível de classe e PDMs/itens incluídos): é
  decisão de produto no `/catmat`, não desta spec (pergunta 5).
- Textos do Dashboard (`SyncView.tsx`): só passam a refletir o `cron` real que a API devolver; PR separado no
  Dashboard depois do backend.
- Ligar `PNCP_NATIONAL_SYNC_ENABLED` em produção como atalho: não (a flag some).

## Impacto em dados

- **Migration:** sim, duas: (a) `supabase/migrations/<ts>_cron_syncs_nacionais.sql` (jobs diários escalonados com
  `origem: "cron"`, guardada por `to_regprocedure('cron.schedule...')` como `20261008180000`; `private.cron_jobs_resumo()`
  com `revoke all` + `grant execute to service_role`); (b) nenhuma mudança de schema em `licitacoes_externas` (as
  colunas da 0023 bastam). Idempotentes (`unschedule` + `schedule`; `create or replace function`).
- **Tabelas/views/funções tocadas:** `licitacoes_externas` (passa a receber linhas dos syncs; lida por
  `api-dashboard-oportunidades`, `api-pipeline`, views de prioridade/canônica); `contratacoes_editais/_itens`
  (inalteradas); `cron.job`; `private.cron_jobs_resumo()` nova. Edge Functions: `sync-pncp-contratacoes-editais`,
  `-atas`, `-contratos`, `-itens`, `sync-pncp-irp`, `sync-pncp-pca`, `sync-compras-catmat`, `api-syncs`,
  `_shared/pncp/{licitagym-scope-gate,catmat-scope-resolver,licitagym-catmat,hash}.ts`, `_shared/catalogo-classes.ts`.
- **ACL/RLS:** nova função `private.cron_jobs_resumo()` só `service_role`; nada mais muda.
- **Backfill/reprocessamento:** sim, por execução dos syncs (não por migration): os 1.197 editais já em
  `contratacoes_editais` só entram em `licitacoes_externas` quando o sync de itens rodar com a regra do catálogo.
  Contagem antes/depois no PR (CA-9). Mudança de classificação (o que vira oportunidade) exige dry-run (CLAUDE.md).
- **Edge Functions republicadas no merge:** todas (integração), com mudança de código nas listadas acima.
- **Contrato com o Dashboard:** `api-syncs` `listar`: `cron` passa a ser objeto `{ jobname, schedule, active, ultima_chamada_em, ultimo_status }` ou `null` (hoje string ou `null`): **muda**; o Dashboard ajusta `SyncView.tsx` em PR separado depois do backend. `api-dashboard-oportunidades`: inalterada.
- **Dado oficial x derivado:** linhas em `licitacoes_externas` vindas dos syncs trazem o `raw` oficial do PNCP;
  `prioridade`/`fase` derivadas pelas mesmas regras do coletor (`prioridade_da_compra`) ou ficam nulas até o coletor
  passar (pergunta 2). Nada inventado: sem item com CATMAT no catálogo, não entra.
- **Branch Supabase:** não (só cron + função `private`); mas o volume de escrita em `licitacoes_externas` pede o
  dry-run antes de ligar os jobs (pergunta 4).
- **Instructions a atualizar no mesmo PR:** `.github/instructions/catmat.instructions.md:12`, `AGENTS.md:174`,
  `docs/pncp/cron-sync-jobs.md:18-22`, `CLAUDE.md` (regra "CATMAT núcleo 78/7830, extensão curada 72/7220").

## Respostas do Marcelo (14/10/2026, primeira rodada)

- **1 (regra de entrada): nada fica de fora.** Entra por código CATMAT do item, por texto do objeto e por **catálogo
  próprio do município** mapeado para o CATMAT (de-para). Medido em 14/10: `licitacao_itens` tem 92.295 itens e só
  239 com código CATMAT (0,26%); o resto é texto. O de-para municipal vira spec própria (brainstorming em andamento).
- **5 (7830 excluída): intencional**, segue o catálogo do tenant. O código deve ser idempotente e prever que cada
  tenant tem o próprio recorte de grupo, classe, PDM e item. Achado para a spec: `catalogo_empresa_catmat` hoje não
  tem `tenant_id` (catálogo único); virar por tenant é mudança de schema.
- **6 (IRP): entra em oportunidades normalmente.** A IRP é alimentada ao fim do prazo, com a ata disponibilizada, e só
  volta a oportunidades quando o edital é publicado. Avaliar cron da IRP em rota própria da barra lateral para
  conferir se o edital saiu; medir historicamente o prazo entre IRP fechada e edital publicado.
- **8 (horários e janela): aprovado.**
- **2, 3, 4 e 7:** reformuladas abaixo em linguagem de produto.

## Perguntas em aberto

1. **Regra de entrada em `licitacoes_externas`:** "ao menos um item com CATMAT (item, PDM ou classe) no catálogo
   efetivo" (proposta, CA-3) ou também por texto do objeto (como o coletor Python)? Edital sem item com código CATMAT
   (comum em municípios) fica fora pelos syncs?
2. **Prioridade e fase das linhas que vêm dos syncs:** calcular com as mesmas regras do coletor (`motivo_prioridade`,
   `fase_da_compra`, hoje em Python) exige portar a regra para TS; ou gravar sem `prioridade` (não vira lead até o
   coletor/recoleta passar)? A view só rebaixa; `prioridade` nula nunca vira lead.
3. **Conflito de escrita com o coletor Python** na mesma linha: o sync envia só suas colunas (CA-4) e o coletor
   continua dono de `prioridade`/`categoria_escopo`/`termos_busca`? Ordem do dia (cron dos syncs 06h, coletor à mão)?
4. **Ligar os jobs já no merge ou criar `active = false`** e ligar depois do dry-run conferido (como foi feito com o
   PCA em `20261011210000`)?
5. **Catálogo atual** tem 7830 excluída no nível de classe (e grupo 78 incluído, PDMs/itens incluídos): é
   intencional? Com a regra "PDM efetivo traz a classe", 7830 volta; sem PDMs incluídos, o gate recusaria editais de
   7830. Confirmar o escopo antes do dry-run.
6. **IRP:** o endpoint de listagem não foi verificado (gate CLA-34). Entra no cron já, ou só depois de um dry-run de
   contrato?
7. **Hash (CA-5):** alinhar o Python ao TS (descartar as mesmas `VOLATILE_KEYS`, números como JSON canônico) ou o TS
   ao Python? Proposta: TS vira a referência (já usado em 6 tabelas) e o Python passa a reproduzir `stableStringify`.
8. **Horários do cron** (proposta: editais 06:50, atas 07:05, contratos 07:20, itens 07:35, IRP 07:50 BRT, depois do
   `sync-pncp-pca-fila` das 06:13) e janela (`data_inicial` padrão de 2 dias é suficiente para o diário?).
