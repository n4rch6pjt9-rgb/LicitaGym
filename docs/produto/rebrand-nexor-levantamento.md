# Rebrand LicitaGym → Nexor Licitações: levantamento de ocorrências

- **Data:** 08/11/2026. Somente leitura: nenhuma linha de código, migration ou dado foi alterada.
- **Base medida:** backend `n4rch6pjt9-rgb/LicitaGym` em `origin/main` `d7f52f1`; Dashboard
  `n4rch6pjt9-rgb/Dashboard---LicitaGym` em `main` `7693915` (clone raso, só leitura).
- **Padrões:** `LG-T\d{2}`, `LG\.GEN\.` e `LicitaGym|licitagym|LICITAGYM` (`git grep -I`, só arquivos de texto
  versionados). "lin" = linhas com ao menos uma ocorrência.
- **Contexto:** em 07/11/2026 a `specs/nexor_spec.xlsx` passou para o prefixo NX (`LG-Txx` → `NX-Txx`, ids
  `NX.GEN.…`). O PR #467 já grava NX no banco (`tarefas_catalogo`, `tarefas_catalogo_apelidos` com `sistema='nx_t'`).
  A marca na tela é tratada pela spec 0040 (parada) no Dashboard.

## Resumo

| Padrão | Backend | Dashboard |
|---|---|---|
| `LG-T\d{2}` | 2 arq / 9 lin (só specs) | 0 |
| `LG.GEN.` | 1 arq / 1 lin (teste) | 0 |
| `LicitaGym` (qualquer caixa) | 373 arq / 970 lin | 74 arq / 157 lin |
| `NEXOR`/`Nexor` (referência) | 10 arq (specs 0040/0041, mapas, 2 migrations NX, 2 checks, `import-spec.ts`) | 20 arq / 77 lin (já aplicado em `index.html`, login, AppShell, agentes) |

**Prompts de agentes:** zero ocorrências. `supabase/functions/_shared/agentes/**` (achados, aderencia, citacao,
concorrencia, decisao, divergencias, edital, juridico, preco) e `services/coletor-externo/coletor/ia.py` não citam
"LicitaGym", "LG-T" nem "NEXOR". Nada a trocar nos prompts.

## Códigos de tarefa (`LG-T`, `LG.GEN.`)

| Onde | Ocorr. | Natureza | Risco de trocar | Proposta |
|---|---|---|---|---|
| `specs/nexor-de-para-tarefas.md` (6 lin) | LG-T09, LG-T21, LG-T25, LG-T34 | registro da aprovação de 07/11; o próprio arquivo diz que mantém a grafia `LG-T` da aprovação e que no banco é `NX-Txx` | baixo, mas reescreve o texto aprovado | **manter como histórico** (já explicado no arquivo) |
| `specs/0041-calendario-feriados-e-gates-do-tr.md` (3 lin: 77, 98, 102) | LG-T05, LG-T28, LG-T30 a 34 | spec em andamento cita a tarefa pelo código antigo | baixo (texto) | **trocar** para `NX-Txx` na próxima edição da 0041, com nota "antes LG-Txx" |
| `tests/supabase/scripts/import_spec_test.ts:163` | `digitoVerificador("LG.GEN.A02.IMP.005")` = 8 | teste do cálculo do DV; o DV muda com o prefixo (`NX.GEN.A02.IMP.005-4` na planilha) | baixo: só o caso de teste | **trocar** para um id NX com o DV da planilha, ou manter como caso de algoritmo puro; decidir junto do próximo PR que tocar `import-spec.ts` |
| migrations, seeds, banco | 0 | — | — | nada a fazer (PR #467 já grava NX) |

## `LicitaGym` no backend, por grupo

| # | Grupo | Ocorr. | Arquivos / exemplos | Risco de trocar | Proposta |
|---|---|---|---|---|---|
| 1 | **Migrations já aplicadas** | 100 arq / 266 lin | 77 comentários de cabeçalho `-- LicitaGym: …`; 25 nomes de job do pg_cron (`licitagym-sync-pncp-pca`, `licitagym-link-catmat-pca`, `licitagym-sessao-retencao`…); coluna `catalogo_itens.categoria_licitagym` (+ check e índice); função `public.licitagym_desenvolvedor()`; arquivo `20260929140000_documentos_no_licitagym.sql` | **proibido editar** migration mergeada; renomear arquivo quebra o histórico do Supabase | **manter como histórico**. Qualquer renome de objeto vivo (job, coluna, função) só por migration nova — ver grupos 2 e 3 |
| 2 | **Objetos vivos no banco** (subconjunto do grupo 1) | 25 jobs cron; 1 coluna; 1 função; 45 arq citam `licitagym_role` | `cron.job.jobname`; `categoria_licitagym` lida em `_shared/compras-gov/catalogo-upsert.ts`, `curadoria-*.ts`, `scripts/discover-piso-api.ts`; `taxonomias.grupo_licitagym`/`subcategoria_licitagym` (chaves JSON) | médio a alto: jobname aparece em `private.saude_operacional_resumo`, testes e runbooks; coluna e chaves JSON exigem migration com cópia de dados e mudança coordenada de código | **decidir com o Marcelo**. Proposta: manter (nome interno, invisível ao cliente) |
| 3 | **Claim de papel `app_metadata.licitagym_role`** | 45 arq (backend) + 4 no Dashboard | `_shared/http.ts:152`, `api-tenant/repo.ts`, `public.licitagym_desenvolvedor()`, Dashboard `src/auth/useIsAdmin.ts`, `perguntaEdital.tsx` | **alto**: está gravado nos usuários de produção (Auth); trocar exige migrar `raw_app_meta_data` e publicar backend e Dashboard juntos, senão admin perde acesso | **manter** (decidir com o Marcelo se um dia vale um claim novo com leitura dupla) |
| 4 | **Edge Functions (código e textos)** | 30 arq / 58 lin | mensagens de erro `fora do escopo LicitaGym` (`licitagym-scope-gate.ts`, `catmat-scope-resolver.ts`); arquivos `_shared/pncp/licitagym-catmat.ts` e `licitagym-scope-gate.ts` (+ constantes `LICITAGYM_CATMAT_*`, env `LICITAGYM_SCOPE_GATE`); `REPO_PADRAO = "n4rch6pjt9-rgb/LicitaGym"` (`api-syncs`); `PROJETO = "licitagym"` e `JOB_CRON` (`_shared/coletor/enfileirar-sestsenat.ts`); User-Agent `LicitaGym/1.0`, `licitagym-pncp-sync/1.0` | mensagens: baixo, mas podem aparecer no Dashboard e em `private.*_run.erro`; arquivos/constantes: médio (muitos imports, merge republica todas as funções); env e repo: alto (segredo/variável configurada em produção) | mensagens e comentários: **trocar** num PR próprio; arquivos e env: **decidir com o Marcelo**; `REPO_PADRAO`, `PROJETO`: **manter** enquanto repo e projeto GCP tiverem esse nome |
| 5 | **Coletores Python** (`services/coletor-externo/coletor`, sem testes) | 27 arq / 43 lin | User-Agent `LicitaGym-Coletor/1.0` e `/1.1`, `LicitaGymBot/0.1` (`catalogos.py`, `catalogo/rede.py`); bucket `gs://licitagym-documentos` (`arquivo_raw.py:56`); `~/.licitagym.env`; docstrings "escopo LicitaGym" | UA: baixo (identificação pública perante os portais; trocar é desejável, mas muda o rastro nos logs deles); bucket: **alto** (nome de infraestrutura, dados já gravados); `.licitagym.env`: médio (arquivo na VM/Cloud Shell) | docstrings: **trocar**; UA: **decidir com o Marcelo** (marca pública); bucket e `.licitagym.env`: **manter** |
| 6 | **Scripts** (`scripts/`) | 28 arq / 51 lin | UA `LicitaGym/Collector` (14), `LicitaGym/Test`, `LicitaGym-Sentinela/1.0`; envs `LICITAGYM_*` (19 nomes distintos no repo: `LICITAGYM_HTTP_ALLOWED_HOSTS`, `LICITAGYM_SYNC_RESUME`, `LICITAGYM_USER_JWT`, `LICITAGYM_EMBEDDING_*`…); `supabase_db_licitagym` (container local); `saude-alerta.sh` com `licitagym-dashboard.licitagym.workers.dev`; `scripts/invoke-sync-licitagym-scope.ps1` | env: médio (workflows e máquinas configuradas); URL do Worker: alto (infra Cloudflare) | textos/UA: **trocar** com o grupo 5; env e URL: **manter** até decisão de infra |
| 7 | **Seeds, rollback, SQL avulso, config** | 8 arq / 16 lin | `supabase/seeds/licitagym-curadoria-catmat.json` e `catmat-licitagym.example.json` (citado por `import-catmat-curadoria`); `supabase/config.toml` `project_id = "licitagym"` | seeds: médio (nome citado em mensagem de erro e docs); `project_id`: baixo, só local, mas muda o nome dos containers | **decidir com o Marcelo** (proposta: manter) |
| 8 | **Testes e fixtures** | 45 arq / 100 lin | `supabase/tests/*_check.sql` (jobnames, `licitagym_role`), `tests/supabase/**`, `services/coletor-externo/tests` (bucket, UA, banco `test_licitagym`) | acompanham o código: trocar sozinho quebra a CI | **trocar só junto** com o código do grupo correspondente |
| 9 | **Specs e docs** | specs 26 arq / 99 lin; docs, READMEs, `.audit`, `product-docs`, `gitbook-docs.yaml` 88 arq / 298 lin | nomes de arquivo `docs/arquitetura/licitagym_conectividade_infra_ia.md`, `docs/seguranca/licitagym_rag_seguranca_prompt_injection.md`, PRDs `*_LICITAGYM*.md`; links `github.com/n4rch6pjt9-rgb/LicitaGym` | specs entregues e `.audit` são histórico; renomear arquivo quebra links internos | specs/ADR entregues e `.audit`: **manter como histórico**; docs vivos (README, runbooks, ESCOPO): **trocar** o nome do produto em PR de docs; nomes de arquivo: **manter** |
| 10 | **Instruções de agentes de código** | 21 arq / 39 lin | `CLAUDE.md`, `AGENTS.md`, `.claude/rules`, `.claude/skills`, `.claude/agents`, `.claude/hooks`, `.cursor/rules/licitagym.mdc`, `.github/copilot-instructions.md`, `.githooks/pre-commit`, `ruff.toml` (`licitagym-coletor-sistema-s`) | baixo; `ruff.toml` aponta para pasta/repo com esse nome | **trocar** o nome do produto no texto; manter referências a repo/pasta |

## `LicitaGym` no Dashboard, por grupo

| # | Grupo | Ocorr. | Arquivos / exemplos | Risco de trocar | Proposta |
|---|---|---|---|---|---|
| D1 | **Textos de UI e relatórios PDF** | ~10 lin | `utils/editalPdfReport.ts:42,59,80` e `utils/precosPdfReport.ts:171,508` (cabeçalho/rodapé "LICITAGYM"); `legal/LegalCrossReference.tsx:103` (`[CONFRONTAÇÃO JURÍDICA - LICITAGYM]`); `utils/sync.ts:24` (tooltip "coleta no LicitaGym"); `metadata.json` `"name": "LicitaGym"` | baixo; é o que o cliente vê | **trocar** (escopo natural da spec 0040; marca na tela já é NEXOR em `index.html`, login, AppShell) |
| D2 | **Chaves de `localStorage`** | 3 lin | `licitagym_theme` (`hooks/useTheme.ts`), `licitagym_catmat_grupos_fixados` (`catmatAtalhos.ts`), `licitagym.crm.organizacoes.visualizacao` (`CompaniesListView.tsx`) | médio: trocar perde a preferência salva de cada usuário | **manter**, ou trocar com leitura da chave antiga (decidir com o Marcelo) |
| D3 | **Nome de pacote e Worker** | 3 arq + URL em 3 lin | `package.json`/`wrangler.jsonc` `licitagym-dashboard`; URL `licitagym-dashboard.licitagym.workers.dev` | **alto**: `name` do wrangler é o Worker de produção; trocar cria outro Worker e muda a URL (citada no backend em `saude-alerta.sh`) | **decidir com o Marcelo** (proposta: manter até haver domínio próprio) |
| D4 | **Hash do check-bundle** | 2 arq / 3 lin | `licitagym/check-bundle/v1` (`scripts/check-bundle*.mjs`) | médio: é o sal dos hashes versionados; trocar invalida a lista | **manter** (identificador técnico) |
| D5 | **Mock/demo** | ~10 lin | `src/mockData.ts` (8 lin), e-mails `@licitagym.com(.br)` em `AppShell.tsx:93` e testes | baixo; `check-bundle.mjs:56` barra `operador.demo@licitagym.com.br` no bundle | trocar junto com o check-bundle, se for trocar; **decidir com o Marcelo** |
| D6 | **Comentários que citam o backend** | ~30 lin | `src/data/*.ts` (17 arq), `types.ts`, `EmpresaView.tsx`… | nenhum: referem-se ao repositório `LicitaGym`, que mantém o nome | **manter** enquanto o repo não for renomeado |
| D7 | **Testes** | 20 arq / 33 lin | `src/test`: e-mails fictícios, `licitagym_role` | quebram se trocados sozinhos | acompanham D3/D5 e o claim;  **trocar só junto** |
| D8 | **Docs e instruções** | 13 arq / 66 lin | `CLAUDE.md` (14), `README.md` (9), `.claude` (7 arq, inclui `agents/ux-ui-licitagym.md`), `.github` (2), `docs` (2) | baixo | **trocar** o nome do produto no texto; manter nomes de repo |

## Nomes de infraestrutura (fora do código, não alterar sem decisão)

| Recurso | Nome atual | Onde aparece | Proposta |
|---|---|---|---|
| Repositórios GitHub | `n4rch6pjt9-rgb/LicitaGym`, `Dashboard---LicitaGym`, `licitagym-coletor-sistema-s` | `api-syncs` (`REPO_PADRAO`), `sentinela_observar.py`, workflows, docs | **decidir com o Marcelo**; GitHub redireciona após renome, mas `GITHUB_ACTIONS_REPO`, integração Supabase ↔ GitHub e branches de preview precisam ser reconferidas |
| Projeto Supabase | `ifaiagegyicjzlpskafh` | CLAUDE.md, runbooks | **manter** (id imutável; não contém a marca) |
| Projeto GCP / Cloud Run | `licitagym` (`southamerica-east1`) | `enfileirar-sestsenat.ts`, `sentinela_observar.py`, README do coletor | **manter** (id de projeto GCP não muda) |
| Buckets GCS | `licitagym-documentos`, `licitagym-docs` | `arquivo_raw.py`, testes, README | **manter** (renome = cópia de dados) |
| Worker Cloudflare | `licitagym-dashboard` (`*.licitagym.workers.dev`) | Dashboard `wrangler.jsonc`, backend `saude-alerta.sh` | **decidir com o Marcelo** |
| Jobs pg_cron | 25 `licitagym-*` | migrations, `saude_operacional_resumo`, checks | **manter** (ver grupo 2) |
| Arquivos de dados | `licitagym_sesc_126135_comparacao_agentes.csv`, `licitagym_p03_g51.zip` | citados em docs; não versionados | **manter** (dados de coleta) |

## Ordem sugerida, se o Marcelo aprovar

1. PR de texto (sem risco de contrato): docs vivos, instruções de agentes, docstrings, mensagens de erro do escopo
   e textos/PDF do Dashboard (este último dentro da spec 0040).
2. `specs/0041`: `LG-Txx` → `NX-Txx`; teste do DV com id NX.
3. User-Agent dos coletores e scripts, se a marca pública nos portais for trocar.
4. Só com decisão explícita: env `LICITAGYM_*`, nomes de arquivo `licitagym-*.ts`, chaves de `localStorage`, seeds.
5. Não tocar: migrations aplicadas, `licitagym_role`, jobs cron, buckets, projeto GCP, Worker e repositórios.

## Perguntas para o Marcelo

1. **Escopo:** o rebrand é só da marca visível (tela, PDF, textos, docs) ou também dos nomes internos (env,
   arquivos, constantes)? A proposta acima é só o visível.
2. **`app_metadata.licitagym_role`:** manter para sempre como nome técnico? Trocar exige migrar usuários de produção e
   publicar backend e Dashboard juntos.
3. **User-Agent dos coletores** (`LicitaGym-Coletor/1.1`, `LicitaGymBot/0.1`, `LicitaGym/Collector`): passa a ser
   `Nexor…`? É a identificação pública perante PNCP, Compras.gov e portais.
4. **Repositórios e Worker:** renomear `LicitaGym`, `Dashboard---LicitaGym` e o Worker `licitagym-dashboard`
   (URL `*.licitagym.workers.dev`)? Há domínio próprio do Nexor previsto?
5. **`specs/0041` e teste do DV:** posso trocar `LG-Txx` por `NX-Txx` no próximo PR que tocar a 0041 e
   `import_spec_test.ts`?
6. **Chaves de `localStorage` do Dashboard:** manter, ou trocar com migração da chave antiga (preserva tema e
   preferências dos usuários)?
