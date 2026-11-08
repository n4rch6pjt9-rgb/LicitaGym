# 0043: Remover o catálogo de legislação (`api-pncp-legislacao`, tabelas `legislacao_*` e bucket `pncp-legislation`)

- **Status:** aprovada (Marcelo, 08/11/2026)
- **Alimenta:** spec-mãe 0032, fase 4, como limpeza da 0042 (que alimenta a fase 4). Tira do caminho um catálogo
  que ninguém lê e que confunde com a base usada pelo agente jurídico (`norma_dispositivos`) (decisão P-6).
- **Repositório:** LicitaGym (o Dashboard não muda; ver "Impacto em dados")
- **Issue:** #245 (origem: investigação do alerta `pncp_sync_dias_sem_sucesso`); decisão P-4 da spec 0042
- **Área:** edge-functions | migrations | storage (operação manual)
- **Depende do ok do Marcelo:** sim (migration destrutiva, função apagada em produção, bucket apagado, dado de produção)
- **Depende de:** spec 0042 no ar (K-1, K-3 e K-6 dela aplicadas em produção). Ver "Ordem segura".

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega; preview por PR; merge = produção | sim |
| 2 | `AGENTS.md` | zero alucinação, proveniência do dado oficial | sim |
| 3 | `.claude/rules/regras-negocio.md` | agente jurídico: achado com fonte, trecho e página | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 3 e regra de foco | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` (fase 4) e `specs/0042-legislacao-corpus-curado.md` (branch `spec/0042-legislacao-corpus-curado` até o merge) | o que esta spec limpa e o que fica (K-3 e K-6 da 0042) | não: ler |
| 6 | esta spec | contrato, CAs, ordem, fora de escopo | não: ler |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções das áreas tocadas | ao abrir a pasta |
| 8 | `supabase/functions/api-pncp-legislacao/index.ts` | a função removida (lista documentos, assina URL do bucket, dispara o sync) | não: ler |
| 8 | `supabase/migrations/202609180003_legislacao.sql`, `202609180011_rls_child_tables.sql`, `20260920142857_compras_api_secao_legislacao.sql`, `20260929010000_revoke_anon_compras_api_secoes.sql`, `20260929190000_sec_legislacao_fecha_leitura.sql`, `20261009130000_tabelas_acl_drift.sql` | onde as tabelas, as policies do bucket, a FK de `compras_api_secao_legislacao` e as ACLs nasceram | não: ler |
| 8 | `supabase/tests/tabelas_acl_check.sql` (linhas 49 e 71–75) e `supabase/sql/inventario_dados.sql` (linhas 34–38) | listam as tabelas removidas; precisam sair junto | não: ler |
| 8 | `tests/supabase/functions/_shared/api_pncp_auth_order_sec_edge_test.ts` | SEC-EDGE-004 é só da legislação; SEC-EDGE-002 cobre `api-pncp-pca` e `api-pncp-contratacoes` também | não: ler |
| 8 | `.github/workflows/deploy-supabase-functions.yml` (linha 74), `supabase/config.toml` (linha 107), `scripts/deploy-functions.ps1` (linha 22) | entradas de deploy da função | não: ler |
| 8 | `docs/pncp/architecture.md`, `docs/pncp/deploy-checklist.md`, `docs/pncp/security-mvp.md`, `docs/pncp/inventario-dados.md` | documentação que cita a função, o bucket ou as tabelas | não: ler |
| 8 | memória do projeto "Aposentar Edge Function" (resumo na seção K-2) | tirar do repo não apaga em produção; prova é POST sem token → 404 | — |
| 9 | (sem chamada a API oficial) | — | — |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa | quando invocados |

## Problema

Medido em produção em 08/11/2026 (≈23 h UTC), por consulta somente leitura pelo MCP do Supabase, `git grep` neste
repositório e `gh search code` no Dashboard.

- **O catálogo guarda lixo e ninguém o lê.**
  - `legislacao_fontes` 3, `legislacao_documentos` 32, `legislacao_versoes` 27, `legislacao_alertas` 27,
    `legislacao_relacoes` 0.
  - Dos 32 documentos, 19 são de 05/10 (sync: links de navegação, com 25 versões e 25 alertas) e 13 são de 20/09
    (seed `20260920142857`, normas reais, com 2 versões e 2 alertas).
  - Bucket `pncp-legislation` (privado): 27 objetos, 3.832.414 bytes; o último é de 05/10.
- **Quem lê, por `git grep` (08/11, fora de `specs/` e `.audit/`):**
  - `legislacao_*`: só `supabase/functions/api-pncp-legislacao/index.ts` (leitura) e
    `supabase/functions/sync-pncp-legislation/index.ts` (escrita; a 0042 a troca por 410).
  - Bucket: as mesmas duas funções e as policies `legislacao_storage_read` e `legislacao_storage_service_write`
    em `storage.objects`.
  - Nenhuma função SQL em `public`/`private` cita as tabelas ou o bucket; nenhuma view depende delas
    (consulta em `pg_proc` e `pg_depend`, 08/11).
- **Dependências que a remoção precisa tratar (achadas agora, não estavam na decisão P-4):**
  - `public.legislacao_relacoes` (0 linhas) tem duas FKs para `legislacao_documentos`.
  - `public.compras_api_secao_legislacao` (6 linhas, ligando 5 documentos do seed às seções da API Compras) tem FK
    `ON DELETE CASCADE` para `legislacao_documentos`. Ela e `public.compras_api_secoes` (14 linhas) não têm leitor
    no código (`git grep`, 08/11): só migrations, `tabelas_acl_check.sql` e o inventário.
  - `licitagym-sync-pncp-legislation` ainda está ativo em `cron.job` (`27 8 * * 1`); a K-1 da 0042 o desagenda.
- **O Dashboard não chama a `api-pncp-legislacao`.** `gh search code` (08/11) no `n4rch6pjt9-rgb/Dashboard---LicitaGym`:
  `api-pncp-legislacao` só aparece no `README.md` (item de roadmap); `legislacao_documentos`, `legislacao_versoes`,
  `legislacao_fontes`, `legislacao_alertas`, `pncp-legislation` e `compras_api_secao` não aparecem; a única chamada a
  `functions/v1/api-pncp-*` é a `api-pncp-pca`. As telas `/juridico/legislacao` (`LegalDashboard`,
  `LegislationTableView`, `LegislationDetailView`) recebem as normas de `fixtures?.MOCK_LEGISLATION_NORMS` em
  `src/App.tsx:88` (demo, com `DemoBadge`) e não chamam o backend (leitura dos arquivos pela API do GitHub, 08/11).
- **Não medido:** se alguém chamou a `api-pncp-legislacao` nos últimos dias (log de Edge Function só em incidente).

## Ordem segura

1. A 0042 vai ao ar: K-1 (cron desagendado), K-6 (`sync-pncp-legislation` responde 410 sem tocar nas tabelas) e
   K-3 (lixo e arquivos do lixo apagados). Depois dela, o bucket deve ter só os objetos dos documentos do seed
   (contar de novo; a 0042 não mediu quantos são).
2. Sem exportação (decisão P-1 de 08/11).
3. **PR A (K-1):** sai a `api-pncp-legislacao` do repositório. Depois do merge, o Marcelo apaga a função em produção
   e confere 404 (K-2). Assim nenhuma versão viva da função lê tabela já apagada.
4. **PR B (K-3):** migration que apaga as tabelas e as policies do bucket. Com preview verde e K-2 confirmado.
5. Bucket esvaziado e apagado pela API de Storage (K-4), depois do PR B.

Os passos 3 e 4 são **dois PRs** (decisão P-2): a migration só vai para merge depois do 404 da K-2.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Remoção da `api-pncp-legislacao` do repositório: apaga `supabase/functions/api-pncp-legislacao/`; tira a entrada de `supabase/config.toml`, de `.github/workflows/deploy-supabase-functions.yml` e de `scripts/deploy-functions.ps1`; em `tests/supabase/functions/_shared/api_pncp_auth_order_sec_edge_test.ts` apaga o teste SEC-EDGE-004 e tira `api-pncp-legislacao/index.ts` da lista do SEC-EDGE-002 (que segue cobrindo `api-pncp-pca` e `api-pncp-contratacoes`); atualiza os quatro `docs/pncp/*.md` da leitura obrigatória | — | nenhum arquivo em `supabase/functions/`, `scripts/`, `.github/` ou `tests/` cita `api-pncp-legislacao` | CI (`deno-check-funcoes.sh`, Deno) falha se sobrar import ou entrada | desenvolvedor (PR) |
| K-2 | Aposentadoria em produção (memória "Aposentar Edge Function"): o merge republica as funções presentes no repositório mas **não apaga** a que saiu. O Marcelo apaga no painel ou com `supabase functions delete api-pncp-legislacao --project-ref ifaiagegyicjzlpskafh` (o hook bloqueia o agente). Prova: `POST https://ifaiagegyicjzlpskafh.supabase.co/functions/v1/api-pncp-legislacao` sem token responde **404** `NOT_FOUND`; **401** = ainda viva. Conferir também `list_edge_functions` | `POST` sem token | `404` | `401` → função viva, repetir o delete | Marcelo apaga; agente verifica (somente leitura) |
| K-3 | Migration `<timestamp>_legislacao_remove_catalogo.sql` (timestamp depois das migrations da 0042), destrutiva e idempotente: (a) **guarda**: `raise exception` se ainda existir `cron.job` com `jobname = 'licitagym-sync-pncp-legislation'` (prova de que a 0042 foi aplicada antes); (b) `drop policy if exists legislacao_storage_read` e `legislacao_storage_service_write` em `storage.objects`; (c) um único `drop table if exists ... restrict` com `legislacao_alertas`, `legislacao_relacoes`, `legislacao_versoes`, `legislacao_documentos`, `legislacao_fontes`, `compras_api_secao_legislacao` e `compras_api_secoes` (decisões P-3 e P-4). **Sem `cascade`**: dependente não previsto faz a migration falhar em vez de sumir em silêncio. Junto: `tabelas_acl_check.sql` e `supabase/sql/inventario_dados.sql` sem as tabelas removidas | — | tabelas e policies ausentes; segunda execução não falha | guarda dispara se a 0042 não está aplicada; `drop` falha se aparecer dependente novo | migration (deploy) |
| K-4 | Bucket `pncp-legislation`: esvaziado e apagado pela API de Storage (o Supabase não deixa apagar `storage.objects`/`storage.buckets` por SQL), **pelo painel** do Supabase (decisão P-5). Nunca outro bucket | id do bucket fixo `pncp-legislation` | `storage.buckets` sem o id; `storage.objects` sem linha com esse `bucket_id` | bucket não vazio → API recusa o delete; esvaziar antes | Marcelo (painel); agente verifica (somente leitura) |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-3 | **Dado** o banco com todas as migrations (incluindo as da 0042), **quando** a migration K-3 roda duas vezes, **então** `to_regclass` é `null` para cada tabela removida, não há policy em `storage.objects` cujo `qual`/`with_check` cite `pncp-legislation`, e a segunda execução não falha. | SQL `supabase/tests/legislacao_remove_catalogo_check.sql` + skill `validar-migrations` (idempotência) |
| CA-2 | K-3 | **Dado** o `cron.job` `licitagym-sync-pncp-legislation` presente, **quando** a migration K-3 roda, **então** ela falha com a mensagem da guarda e nenhuma tabela é apagada (a transação volta). | SQL `supabase/tests/legislacao_remove_catalogo_check.sql` (bloco que recria o job, executa o corpo da guarda e espera a exceção) |
| CA-3 | K-3 | **Dado** a migration aplicada, **quando** o check roda, **então** `public.norma_dispositivos`, `public.legislacao` e `public.legislacao_embeddings` continuam existindo com as mesmas ACLs, e `tabelas_acl_check.sql` passa sem as tabelas removidas. Regressão: a remoção não pode levar a base do agente jurídico nem o RAG. | SQL `supabase/tests/legislacao_remove_catalogo_check.sql` + `supabase/tests/tabelas_acl_check.sql` |
| CA-4 | K-1 | **Dado** o repositório, **quando** o teste roda, **então** não existe `supabase/functions/api-pncp-legislacao/`, nenhum de `supabase/config.toml`, `.github/workflows/deploy-supabase-functions.yml` e `scripts/deploy-functions.ps1` cita `api-pncp-legislacao`, e nenhum arquivo em `supabase/functions/` cita `legislacao_fontes`, `legislacao_documentos`, `legislacao_versoes`, `legislacao_alertas`, `legislacao_relacoes` ou `pncp-legislation`. | Deno `tests/supabase/legislacao_catalogo_removido_test.ts` |
| CA-5 | K-1 | **Dado** o teste SEC-EDGE-002 sem a legislação, **quando** roda, **então** continua exigindo `requireCronAuth` antes de `beginIdempotency` em `api-pncp-pca` e `api-pncp-contratacoes` (regressão: a cobertura de auth das outras APIs não cai junto). | Deno `tests/supabase/functions/_shared/api_pncp_auth_order_sec_edge_test.ts` |
| CA-6 | K-2 | **Dado** a função apagada em produção, **quando** se faz `POST` sem token na URL dela, **então** a resposta é 404 `NOT_FOUND` (401 reprova). CA negativo de acesso: nem anon nem usuário logado alcançam mais o caminho que assinava URL do bucket. | verificação em produção (curl), com saída colada no PR; skill `verificar-producao` |
| CA-7 | K-4 | **Dado** o bucket esvaziado e apagado, **quando** se consulta `storage.buckets` e `storage.objects`, **então** não há bucket `pncp-legislation` nem objeto com esse `bucket_id`, e a contagem dos outros buckets é a mesma de antes. | consulta somente leitura pelo MCP, antes e depois, colada no PR; skill `verificar-producao` |

Não há CA de outro tenant: as tabelas são catálogo global, sem `tenant_id`, e nenhuma delas é lida por usuário.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | `/implement` (TDD) | Deno CA-4 e CA-5; `scripts/ci/deno-check-funcoes.sh` | `revisor-codigo` + `revisor-seguranca` (some um caminho de signed URL e de disparo por cron) | — |
| K-2 | `/spec` | Marcelo (painel ou CLI) | curl sem token (CA-6) | — | skill `verificar-producao` + `list_edge_functions` |
| K-3 | `/spec` | skill `nova-migration`, `/implement` | SQL `_check` (CA-1 a CA-3); skill `validar-migrations`; contagem antes/depois no PR | `revisor-migration` + `revisor-seguranca` (drop de policy de Storage e de tabelas com ACL) + `revisor-codigo` | skill `verificar-producao` + `get_advisors` (security) |
| K-4 | `/spec` | Marcelo (painel) | consulta antes/depois (CA-7) | — | skill `verificar-producao` |

## Fora de escopo

- `public.norma_dispositivos` (base do agente jurídico): intocada.
- `public.legislacao` e `public.legislacao_embeddings` (RAG offline): intocadas.
- `sync-pncp-legislation`: aposentada pela 0042 (410). Apagá-la de vez em produção é outra limpeza, depois desta.
- O cron, a saúde e o catálogo da `api-syncs`: mudam na 0042.
- Os arquivos em `.audit/` (registro histórico de auditoria): não mudam.
- As telas `/juridico/legislacao` do Dashboard: são demo (fixtures) e não leem este catálogo; ligá-las a dado real é
  outra spec (provavelmente sobre `norma_dispositivos` ou o `corpus.json` da 0042).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_legislacao_remove_catalogo.sql`. **Destrutiva**, idempotente
  (`drop ... if exists`), com guarda de ordem e sem `cascade`.
- **Tabelas/views/funções tocadas:**
  - apagadas: `legislacao_fontes`, `legislacao_documentos`, `legislacao_versoes`, `legislacao_alertas`,
    `legislacao_relacoes`, `compras_api_secao_legislacao` e `compras_api_secoes`;
  - leitor: `api-pncp-legislacao` (removida); escritor: `sync-pncp-legislation` (já 410 pela 0042);
  - nenhuma view nem função SQL depende delas (08/11).
- **ACL/RLS:** somem as ACLs e policies das tabelas apagadas e as duas policies do bucket em `storage.objects`.
  Nenhum grant novo.
- **Storage:** bucket `pncp-legislation` apagado (27 objetos, 3.832.414 bytes em 08/11; recontar depois da 0042).
- **Backfill/reprocessamento:** não. Contagem antes/depois no PR B (tabelas e bucket). Sem backup (P-1).
- **Edge Functions republicadas no merge:** todas (regra do deploy); `api-pncp-legislacao` sai do repositório e é
  apagada à mão (K-2).
- **Contrato com o Dashboard:** inalterado (o Dashboard não chama a função e as telas jurídicas usam fixtures).
- **Dado oficial x derivado:** as 13 normas do seed vêm de URLs oficiais (Planalto, gov.br) e continuam
  reproduzíveis pela migration `20260920142857`; o texto vigiado das normas passa a ser o `corpus.json` da 0042. Nada é
  recalculado nem inventado.

## Decisões do Marcelo

- 08/11: `api-pncp-legislacao`, tabelas `legislacao_*` e bucket saem numa spec de remoção própria (P-4 da 0042).
- 08/11: **sem backup** antes do drop (P-1). O lixo não tem valor e as 13 normas do seed são reproduzíveis pela
  migration `20260920142857`.
- 08/11: `compras_api_secao_legislacao` **e** `compras_api_secoes` são apagadas junto (P-3).
- 08/11: `legislacao_relacoes` entra na remoção (P-4).
- 08/11: **dois PRs**: função primeiro, migration depois do 404 em produção (P-2).
- 08/11: bucket esvaziado e apagado **pelo painel** (P-5).
- 08/11: a spec é **limpeza da 0042**, insumo da fase 4 da 0032 (P-6).
- 08/11: spec **aprovada**.
- 08/11 (verificado, não decisão): as telas `/juridico/legislacao` do Dashboard usam fixtures; nenhuma tabela daqui
  é lida pelo front (P-7).

## Perguntas em aberto

- (nenhuma)
