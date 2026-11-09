# 0044: Tratar a legislação como corpus curado e aposentar o sync semanal

- **Status:** em implementação (aprovada pelo Marcelo em 08/11/2026)
- **Alimenta:** spec-mãe 0032, fase 4 (peça jurídica: "o artigo citado"). O insumo é a garantia de que o texto dos
  artigos da Lei 14.133 que o agente jurídico cita (`norma_dispositivos`) continua igual ao oficial. Desligar o sync
  morto e corrigir o alerta vêm junto, como limpeza (decisão P-1).
- **Repositório:** LicitaGym (o Dashboard não muda; ver "Impacto em dados")
- **Issue:** #245 (alerta `pncp_sync_dias_sem_sucesso`)
- **Área:** migrations | edge-functions | coletor (verificador no Cloud Run)
- **Depende do ok do Marcelo:** sim (migration, cron de produção, dado de produção e decisão de produto)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação, dado oficial, proveniência | sim |
| 3 | `.claude/rules/regras-negocio.md` | agente jurídico: cada achado com fonte, trecho e página | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 3 e regra de foco | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` | fase 4 (peça jurídica com artigo citado) | não: ler |
| 6 | esta spec | contrato, CAs, fora de escopo | não: ler |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/tests.md` | convenções das áreas tocadas | ao abrir a pasta |
| 8 | `supabase/functions/sync-pncp-legislation/index.ts` | o que é aposentado (raspagem de índice e `.limit(1).maybeSingle()` sem ordem) | não: ler |
| 8 | `supabase/functions/api-pncp-legislacao/index.ts` | único leitor do catálogo `legislacao_*` | não: ler |
| 8 | `supabase/functions/api-syncs/catalogo.ts` (entrada `sync-pncp-legislation`) | a tela de syncs lista e dispara a legislação | não: ler |
| 8 | `supabase/functions/_shared/agentes/juridico.ts` e `supabase/functions/api-agentes/repo.ts` (leitura de `norma_dispositivos`) | o que o agente jurídico usa de fato | não: ler |
| 8 | `supabase/migrations/20261011100500_norma_dispositivos_planalto.sql` e `supabase/tests/norma_dispositivos_planalto_check.sql` | a conferência literal com o Planalto (40 conferem, 22 não), que o verificador da K-5 repete | não: ler |
| 8 | `supabase/migrations/20261108150000_saude_itens_taxonomia_sem_varredura.sql` (linhas 81–89) | versão vigente de `pncp_sync_dias_sem_sucesso`, que inclui `legislacao` | não: ler |
| 8 | `supabase/migrations/20260930180000_cron_sync_jobs.sql` (linha 157) e `tests/supabase/cron_sync_jobs_test.ts` | onde o cron da legislação é criado e testado | não: ler |
| 8 | `supabase/migrations/20260920142857_compras_api_secao_legislacao.sql` | seed das 3 fontes e dos documentos úteis (URLs do Planalto) | não: ler |
| 8 | `services/coletor-externo/README.md` e `services/coletor-externo/coletor/paradigma.py` | padrão de Cloud Run Job, variáveis `SUPABASE_*` e cliente do Supabase dos coletores | não: ler |
| 9 | (sem API do PNCP ou do Compras.gov: a fonte é o texto do Planalto) | — | — |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa | quando invocados |

## Problema

Medido em produção em 08/11/2026, por consulta somente leitura pelo MCP do Supabase e pela issue #245.

- **O alerta crítico vem de um sync que não serve a ninguém.** `pncp_sync_dias_sem_sucesso` marca 34,6 dias (issue
  #245, 08/11 22:26 UTC), e o pior recurso é `legislacao`.
  - Em `private.pncp_sync_run`, a última execução `concluida`/`concluida_com_erros` é de 05/10.
  - Em 12/10, 19/10 e 26/10 falhou com `Connection reset by peer` em `https://www.planalto.gov.br/ccivil_03/`.
  - Em 02/11, `private.cron_edge_chamadas` registra 401, no mesmo dia em que todas as 7 funções chamadas pelo cron
    levaram 401.
- **O sync grava lixo.** Ele lê **uma** das 3 fontes ativas de `legislacao_fontes` por execução: `.limit(1)` sem
  `order`. Depois guarda todo `<a>` cujo `href` contém "legislacao" ou termina em ".pdf", e grava cada link como
  `original.pdf`.
  - Hoje: 32 linhas em `legislacao_documentos`, 27 em `legislacao_versoes` e 27 em `legislacao_alertas`.
  - As linhas de 05/10 são links de navegação marcados `vigente`: "GOV.BR", "Guia do Fornecedor", "Combate à
    Discriminação Racial", "Resoluções revogadas", "Legislação / Acesso à Informação".
  - Os documentos com norma (Lei 14.133, 8.666, LC 123, LAI, LGPD, IN 65/73/81 e Decretos 10.947, 11.462 e 12.807/2025)
    são de 20/09 e vieram do seed `20260920142857`, não do sync.
- **Ninguém consome o catálogo.** Só a `api-pncp-legislacao` lê `legislacao_documentos`. No Dashboard, a busca de
  código (`gh search code`, 08/11) acha a API citada só no `README.md`.
- **O que o agente jurídico usa é outra base, curada e estática.** `api-agentes` lê `public.norma_dispositivos`:
  - `LEI_14133_2021`: 65 artigos (11 a 168), dos quais 43 têm `conferido_oficial = true` (08/11).
  - Quem confere é uma migration contra o texto do Planalto (06/10), não um sync.
  - Os demais artigos não conferem com o texto oficial e não são citados como conferidos.
  - Nada avisa se o texto oficial de um artigo citado mudar.
- **O RAG jurídico também é separado.** `public.legislacao` (26 linhas) e `legislacao_embeddings` (257) são carregados
  offline por `docs/agente-juridico-ml/scripts/ingest_pncp.py`, não pelo sync.
- **Não medido:**
  - se o `planalto.gov.br` também recusa conexão vinda dos runners do GitHub Actions;
  - com que frequência o texto da 14.133 muda no Planalto.

A legislação de licitação muda raramente. Sync semanal de páginas-índice não é o desenho certo. O que importa é saber
**quando o texto oficial de uma norma ou artigo citado mudou**.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration `<timestamp>_legislacao_aposenta_sync.sql`: desagenda o cron `licitagym-sync-pncp-legislation` (idempotente) e recria a função de saúde sem `legislacao` na lista de `pncp_sync_dias_sem_sucesso` (fica `pca`, `orgaos`, `compras_catmat`) | — | `cron.job` sem o job; `pncp_sync_dias_sem_sucesso.detalhe` sem a chave `legislacao` | migration falha se a função de saúde vigente tiver mudado depois de `20261108150000` (recriar a partir da última versão) | migration (deploy) |
| K-2 | `api-syncs` catálogo: a entrada `sync-pncp-legislation` **sai** da lista (decisão de 08/11) | `GET` do catálogo | entrada ausente | disparo manual dela → o erro de slug desconhecido do contrato atual da `api-syncs` | admin |
| K-3 | Limpeza do catálogo `legislacao_*`: os documentos que não são norma são **apagados** (decisão de 08/11), junto com suas versões e alertas, por migration com lista explícita de `id` e contagem antes e depois. Os arquivos no bucket `pncp-legislation` desses documentos são apagados pela API de Storage num script de operação (`scripts/ops/legislacao_apagar_arquivos.py`, com `--dry-run`), não por `delete` em `storage.objects`. Os documentos de seed com norma ficam intactos | lista explícita de `id` (não por padrão de título) | documentos de norma intactos; lixo, versões, alertas e arquivos fora | migration falha se algum `id` da lista for de documento de seed (20/09) | migration (deploy) + script (Marcelo roda) |
| K-4 | Corpus curado versionado `services/coletor-externo/coletor/data/legislacao_corpus.json` (ajuste da implementação: o Dockerfile do coletor só copia `coletor/`, e o arquivo precisa estar na imagem do Cloud Run): por norma, `norma` (ex.: `LEI_14133_2021`), título, URL oficial, `vigencia_inicio`, `revogada_em` (ou `null`), `sha256_texto_normalizado` e `conferido_em` da última conferência | — | arquivo no repositório, revisado em PR | — | quem edita: PR (Marcelo aprova) |
| K-5 | Verificador **trimestral** no **Cloud Run Job** (GCP, onde os coletores já rodam): módulo `services/coletor-externo/coletor/verificar_legislacao.py` (`python -m coletor.verificar_legislacao`). Para cada norma da K-4, baixa o texto oficial, normaliza (mesma regra da `20261011100500`: decodificar Windows-1252 e colapsar espaços) e compara o hash. Para os artigos de `norma_dispositivos` com `conferido_oficial = true`, confere se o trecho ainda é substring literal. Agendamento pelo Cloud Scheduler (dia 1 de jan/abr/jul/out), configurado pelo Marcelo como os outros jobs | corpus da K-4 (dentro da imagem); `norma_dispositivos` (somente `select`, com as variáveis `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` que os coletores já usam) | por norma: `igual`, `mudou` ou `nao_verificado` (erro de rede ou HTTP); por artigo: `confere` ou `divergente`. Havendo `mudou` ou `divergente`, o job sai com código ≠ 0 e grava o relatório no log do Cloud Run; não abre issue (decisão P-8) | rede, timeout ou 4xx/5xx → `nao_verificado`, nunca `igual` nem `mudou` | Cloud Scheduler; nunca escreve no banco |
| K-6 | `sync-pncp-legislation` aposentada: com auth de cron válida, responde `410` `{ "error": "aposentada pela spec 0044" }` sem abrir execução nem chamar rede | `POST` | `410` | sem auth → `401` (ordem de checagem atual mantida) | cron (já desagendado) |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** o banco com todas as migrations, **quando** a migration K-1 roda duas vezes, **então** não existe `cron.job` com `jobname = 'licitagym-sync-pncp-legislation'` e a segunda execução não falha. | SQL `supabase/tests/legislacao_aposenta_sync_check.sql` + `tests/supabase/cron_sync_jobs_test.ts` (lista sem a legislação) |
| CA-2 | K-1 | **Dado** uma execução `pca` `concluida` há 1 dia e nenhuma de `legislacao`, **quando** a saúde roda, **então** o `detalhe` de `pncp_sync_dias_sem_sucesso` não tem a chave `legislacao`, e o `valor` é o pior entre `pca`, `orgaos` e `compras_catmat`. É a regressão do falso crítico da #245. | SQL `supabase/tests/legislacao_aposenta_sync_check.sql` (com `saude_operacional_check.sql` passando) |
| CA-3 | K-6 | **Dado** a função aposentada, **quando** recebe `POST` com auth de cron válida, **então** responde `410` e nenhum `fetch` nem insert em `pncp_sync_run` acontece. **Quando** recebe sem auth, **então** responde `401` (CA negativo de acesso). | Deno `tests/supabase/functions/sync_pncp_legislation_aposentada_test.ts` |
| CA-4 | K-2 | **Dado** o catálogo da `api-syncs`, **quando** é lido, **então** não há entrada com `slug = 'sync-pncp-legislation'`, e o disparo desse slug devolve o erro de slug desconhecido. | Deno `tests/supabase/functions/api_syncs_test.ts` (caso novo) |
| CA-5 | K-3 | **Dado** o catálogo com os documentos de seed de 20/09 e os links de navegação de 05/10, **quando** a limpeza roda, **então** os documentos de norma do seed continuam `vigente` com suas versões, nenhum `id` da lista existe mais em `legislacao_documentos`, `legislacao_versoes` ou `legislacao_alertas`, e rodar de novo não muda nada. | SQL `supabase/tests/legislacao_limpeza_catalogo_check.sql` |
| CA-6 | K-5 | **Dado** uma norma no corpus com hash X e o texto oficial (fixture HTML em Windows-1252) que normaliza para outro hash, **quando** o verificador roda, **então** a saída marca `mudou` com a norma e a URL e o código de saída é ≠ 0. Com o mesmo texto, marca `igual` e sai com 0. | pytest `services/coletor-externo/tests/test_verificar_legislacao.py` (sem rede: `fetch` injetado) |
| CA-7 | K-5 | **Dado** um artigo `conferido_oficial` cujo trecho não é mais substring do texto oficial, **quando** o verificador roda, **então** o artigo sai como `divergente` com `norma` e `artigo`, e o cliente do Supabase só recebe `select` (nenhum insert, update, delete nem RPC). | pytest `services/coletor-externo/tests/test_verificar_legislacao.py` (cliente falso que registra as chamadas) |
| CA-8 | K-5 | **Dado** `Connection reset by peer`, timeout ou HTTP 403/5xx numa URL, **quando** o verificador roda, **então** aquela norma sai como `nao_verificado` (nunca `igual` nem `mudou`) e o código de saída indica falha parcial. É a regressão do modo de falha visto em 12/10–26/10. | pytest `services/coletor-externo/tests/test_verificar_legislacao.py` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration`, `/implement` | SQL `_check` + Deno `cron_sync_jobs_test.ts`; skill `validar-migrations` | `revisor-migration` + `revisor-codigo` | skill `verificar-producao` (cron e saúde) + `get_advisors` |
| K-2 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` (disparo admin) | skill `verificar-producao` |
| K-3 | `/spec` | skill `nova-migration` | SQL `_check`; skill `validar-migrations`; contagem antes/depois (dry-run) no PR | `revisor-migration` | skill `verificar-producao` |
| K-4 | `/spec` | `/implement` (conferência inicial dos hashes contra o texto oficial, com data) | pytest (formato do arquivo) | `revisor-codigo` | — |
| K-5 | `/spec` | `/implement` | pytest (sem rede) | `revisor-codigo` + `revisor-seguranca` (uso da `service_role` só para leitura) | primeira execução manual do Cloud Run Job (Marcelo) + skill `verificar-producao` |
| K-6 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` (ordem auth → 410) | skill `verificar-producao` (POST sem token → 401) |

## Fora de escopo

- O RAG do agente jurídico (`public.legislacao`, `legislacao_embeddings`, `docs/agente-juridico-ml/`). Continua sendo
  carregado offline.
- Conferir os 22 artigos de `norma_dispositivos` que ainda não conferem com o texto oficial. A K-5 só **vigia** os
  conferidos; corrigir os outros é uma spec própria, que também alimenta a fase 4.
- Raspar ou acompanhar o DOU ou outra fonte de norma nova. A norma nova entra por PR no `corpus.json`.
- Remover a `api-pncp-legislacao` e as tabelas `legislacao_*` (ver P-4).
- Levar o catálogo `legislacao_*` para o RAG: o RAG não é usado pelo produto hoje (nenhuma Edge Function nem coletor
  chama `match_legislacao_embeddings` ou lê `public.legislacao`, conferido em 08/11). Se o RAG entrar no produto, a
  ingestão dele lê o corpus da K-4.
- Workflow no GitHub Actions para o verificador (decisão de 08/11: vai direto para o Cloud Run).
- As linhas `resource_type = 'teste'`/`'teste_editais'` em `private.pncp_sync_run` (02/11). É outro assunto e vira
  issue própria.

## Impacto em dados

- **Migration:** sim, duas.
  - K-1 (`<timestamp>_legislacao_aposenta_sync.sql`): `cron.unschedule` idempotente mais `create or replace` da função
    de saúde. Aditiva no comportamento; nenhum dado apagado.
  - K-3 (`<timestamp>_legislacao_limpeza_catalogo.sql`): marca ou apaga documentos-lixo por lista de `id` (P-2).
    Idempotente.
- **Tabelas, views e funções tocadas:**
  - `cron.job` (job removido);
  - a função de saúde de `20261108150000` (lida pela `api-saude` e pelo `saude.yml`);
  - `legislacao_documentos`, `legislacao_versoes` e `legislacao_alertas` (lidas só pela `api-pncp-legislacao`);
  - `norma_dispositivos`, só leitura pelo verificador.
- **ACL/RLS:** nenhuma mudança. O verificador precisa de credencial de leitura de `norma_dispositivos` fora do
  Supabase (P-5); não há grant novo para `anon` nem para `authenticated`.
- **Backfill/reprocessamento:** a K-3 leva contagem antes e depois no PR (hoje: 32 documentos, 27 versões, 27 alertas).
- **Edge Functions republicadas no merge:** todas (regra do deploy); mudam `sync-pncp-legislation` (410) e `api-syncs`
  (catálogo).
- **Contrato com o Dashboard:** a tela de syncs deixa de oferecer o disparo da legislação. Muda só o dado, não o formato.
  O Dashboard não chama a `api-pncp-legislacao`.
- **Dado oficial x derivado:**
  - Oficial: o texto da norma no Planalto (URL no `corpus.json`).
  - Derivado: o hash do texto normalizado e o status `igual`/`mudou`/`nao_verificado`.
  - Nenhuma norma, artigo ou data é preenchido sem conferência; norma não verificada aparece como `nao_verificado`.

## Como o agente jurídico usa os artigos (contexto da P-1)

O jurídico não lê arquivo: lê a tabela `norma_dispositivos`.

1. O agente de edital gera **sinais** (ex.: `exigencia.marca_modelo`).
2. A `api-agentes` carrega os artigos da `LEI_14133_2021` (`repo.ts:433`).
3. O `juridico.ts` mapeia sinal → artigos → peça (`MAPA_SINAL_DISPOSITIVO`; ex.: marca/modelo → art. 41, impugnação).
4. O achado traz o texto do artigo gravado na tabela. Artigo com `conferido_oficial = false` sai com o aviso "(texto
   não conferido com a fonte oficial)"; artigo ausente vai para `dispositivos_ausentes`.

Esse texto é o que a minuta da fase 4 vai citar. Se o Planalto mudar o artigo, hoje nada avisa.

## Implementação (08/11/2026)

| CA | Teste | Resultado local |
|---|---|---|
| CA-1 | `supabase/tests/legislacao_aposenta_sync_check.sql` + `tests/supabase/cron_sync_jobs_test.ts` ("CA-1 (spec 0044)") | passa (`validar-migrations`: Tudo OK; Deno ok) |
| CA-2 | `supabase/tests/legislacao_aposenta_sync_check.sql` | passa |
| CA-3 | `tests/supabase/functions/sync_pncp_legislation_aposentada_test.ts` | passa |
| CA-4 | `tests/supabase/functions/api_syncs_test.ts` ("CA-4 (spec 0044)") | passa |
| CA-5 | `supabase/tests/legislacao_limpeza_catalogo_check.sql` (+ `tests/test_legislacao_apagar_arquivos.py` para o script de Storage) | passa |
| CA-6 | `services/coletor-externo/tests/test_verificar_legislacao.py` (`test_ca6_*`) | passa |
| CA-7 | idem (`test_ca7_*`) | passa |
| CA-8 | idem (`test_ca8_*`, mais os testes de `baixar_http`: retry, 429 com Retry-After, 403 sem retry) | passa |

- Os hashes de referência do corpus estão `null`: o `planalto.gov.br` não respondeu da máquina de desenvolvimento
  (timeout, 08/11), o mesmo sintoma visto do Supabase. O verificador marca essas normas `sem_referencia`, imprime o
  `sha256_atual` e sai com 2; a primeira execução no Cloud Run fornece os hashes para um PR que os grava. Se o Planalto
  também recusar o Cloud Run, as normas do Planalto ficam `nao_verificado` (decisão P-6: não testar antes).
- A lista dos 21 documentos-lixo foi conferida em produção em 08/11 (consulta somente leitura): 2 páginas-índice do
  sync de 20/09 e 19 do sync de 05/10; as 11 normas do seed (tipo_norma preenchido) ficam.

## Decisões do Marcelo

- 08/11: documentos-lixo do catálogo são **apagados** (P-2).
- 08/11: a legislação **some** do catálogo de syncs (P-3).
- 08/11: sem teste no GitHub Actions; o verificador vai direto para o Cloud Run Job (P-6).
- 08/11: o verificador roda **trimestralmente** (P-7).
- 08/11: a spec é **insumo da fase 4 da 0032** (P-1); linha registrada no `ESCOPO.md`.
- 08/11: `api-pncp-legislacao` e tabelas `legislacao_*` vão para uma **spec de remoção** própria (P-4).
- 08/11: o verificador usa a `SUPABASE_SERVICE_ROLE_KEY` dos coletores, só com `select` (P-5, garantido pelo CA-7).
- 08/11: aviso **só no log** do Cloud Run, com o job saindo com código ≠ 0; sem issue automática (P-8).

## Perguntas em aberto

- (nenhuma)
