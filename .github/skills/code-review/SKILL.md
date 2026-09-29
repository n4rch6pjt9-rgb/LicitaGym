---
name: code-review
description: Revisa pull requests do LicitaGym (Edge Functions Deno, migrations Supabase, collectors Python, app Electron) contra as regras de precisão, rastreabilidade e segurança do projeto. Use em toda revisão de PR, diff ou branch antes do merge.
---

# Code Review — LicitaGym

Revisão objetiva e acionável, em **português**. O objetivo é encontrar problemas reais que afetem a precisão dos dados de licitação, a segurança ou a operação dos syncs — não reescrever o código ao seu gosto.

Prioridades do produto, nesta ordem: **precisão > rastreabilidade > dados oficiais > auditabilidade > segurança**. Nunca sugira atalho que troque precisão por conveniência.

## Fontes de regra (leia antes de comentar)

| Arquivo | Quando |
|---|---|
| `AGENTS.md` | Sempre (regras de ouro, CATMAT, Supabase, critério de conclusão) |
| `.github/copilot-instructions.md` | Sempre (lista de BLOQUEANTE/IMPORTANTE) |
| `.github/instructions/edge-functions.instructions.md` | `supabase/functions/**` |
| `.github/instructions/database-migrations.instructions.md` | `*.sql`, `supabase/migrations/**` |
| `.github/instructions/pncp.instructions.md` | arquivos de PNCP, contratações, PCA, IRP |
| `.github/instructions/catmat.instructions.md` | CATMAT, PDM, catálogo, taxonomia |
| `.github/instructions/python-ingestion.instructions.md` | `**/*.py` |
| `.github/instructions/document-pipeline.instructions.md` | editais, PDF, OCR, chunks, embeddings |
| `.github/instructions/tests.instructions.md` | `tests/**` e arquivos de teste |
| `docs/pncp/schemas-consultas-pncp.md`, `docs/compras-gov/schemas-consultas.md` | PR que cria/altera requisição HTTP |
| `supabase/migrations/SCHEMA_STANDARDS.md` | PR que cria/altera tabela |

Se este arquivo e as instruções acima divergirem, aplique a regra mais restritiva e mencione a divergência no relatório.

## Processo

1. **Contexto** — leia título, descrição, issue vinculada (`#123`) e commits. Se a descrição citar issue, check do Actions ou outro PR, consulte o GitHub (somente leitura). Se não for possível, declare o contexto como **não verificado**.
2. **Diff completo** — `git diff origin/main...HEAD --stat` e depois o diff inteiro. Mapeie cada arquivo alterado para a linha correspondente da tabela acima e carregue as instruções aplicáveis.
3. **Consumidores** — para cada função, tabela, view, RPC ou tipo alterado, busque quem usa (`grep -rn` em `supabase/functions`, `scripts`, `services`, `Kuib-Harness/src`). Documentação em Markdown **não prova** o schema implantado: confira as migrations.
4. **Revisão** pelas dimensões abaixo.
5. **Verifique cada achado** no código antes de reportar: aponte arquivo e linha e descreva um cenário concreto (entrada/estado → resultado errado). Descarte suspeitas que não se confirmam.
6. **Execute as verificações** da seção "Comandos" que se aplicam aos arquivos alterados. O que não puder rodar, declare explicitamente.
7. **Relatório** no formato definido no fim deste arquivo.

## Checklist por dimensão

### Zero alucinação — sempre [BLOQUEANTE]
- Valor, preço, quantidade, CATMAT/PDM, UASG, número da compra, data, BDI, imposto ou margem hardcoded/fabricado em fluxo de produção.
- Default que mascara ausência: `0`, `""`, `"N/A"`, `'BR'`, data de hoje. Ausência deve ficar ausente/`NULL`/não verificada.
- Identificador oficial substituído por chave interna; `codigoItem` tratado como `codigoPdm`.
- Mock/dado fictício alcançando caminho de produção.

### Erro ≠ vazio — sempre [BLOQUEANTE]
- `except Exception: return []`, `catch { return [] }`, `return null` para timeout/429/5xx/JSON inválido.
- Falha de página intermediária encerrando o sync como sucesso (deve ficar `partial`/`failed`).
- HTTP 200 aceito sem validar envelope e campos.

### Segurança
- **[BLOQUEANTE]** Secret (`service_role`, `sbp_…`, JWT, senha, API key) em código, migration, seed, log, fixture ou `.env` versionado.
- **[BLOQUEANTE]** Edge Function sem autenticação. O deploy usa `--no-verify-jwt`, então todo handler protegido precisa, logo no início, de um helper de `supabase/functions/_shared/http.ts` que retorne 401:
  - sync/cron: `requireCronAuth(req)` (ou o legado `validateCronAuth(req)` + 401);
  - endpoint de usuário (`api-*`): `requireUserAuth(req)`;
  - ambos: `requireCronOrUserAuth(req)`.
  Helpers de usuário são assíncronos: `requireUserAuth`/`requireCronOrUserAuth` sem `await` também é [BLOQUEANTE]. Código novo não usa o deprecado `validateCronAuth`. Ação pública (ex.: `readiness`) precisa ser explícita e não expor dado sensível.
- **[BLOQUEANTE]** Cliente admin/`service_role` (`_shared/pncp/supabase-admin.ts`) em endpoint `api-*` sem checar autorização.
- **[IMPORTANTE]** Mensagem de erro interna (stack, SQL) refletida para o cliente.

### Banco e migrations
- **[BLOQUEANTE]** Alteração de schema fora de `supabase/migrations/`.
- **[BLOQUEANTE]** Tabela nova sem `ALTER TABLE … ENABLE ROW LEVEL SECURITY`; policy `USING (true)` para `anon`/`authenticated` em dado sensível; `GRANT` amplo a `anon`.
- **[BLOQUEANTE]** `SECURITY DEFINER` sem `SET search_path` fixo.
- **[BLOQUEANTE]** `ON CONFLICT (...)` cujo alvo não corresponde a UNIQUE/índice existente (confira nas migrations).
- **[BLOQUEANTE]** `NOT NULL` em campo que pode vir nulo da fonte, ou NULL convertido em `0`/`''`/`'N/A'` para caber em chave.
- Alteração destrutiva (`DROP`, `ALTER TYPE`, `SET NOT NULL`, `ADD UNIQUE`, troca de PK) sem justificativa no PR sobre dados existentes, consumidores, backfill, ordem de deploy e rollback → **[BLOQUEANTE]**.
- Staging `icatmat_*`: PK `BIGINT GENERATED ALWAYS AS IDENTITY`, `payload_hash TEXT NOT NULL UNIQUE`, `data_hora_atualizacao` e `sync_timestamp` `NOT NULL DEFAULT NOW()`, CHECK de escopo G78/7830 e G72/7220.
- **[IMPORTANTE]** Índice sem query/join/conflict target concreto; FK sem índice ou sem análise de órfãos.

### Ingestão (PNCP, Compras.gov, Compras RJ)
- **[BLOQUEANTE]** Parâmetro de API inventado ou com nome errado (confira nos docs de schema).
- **[IMPORTANTE]** `tamanhoPagina` global. Limites por família: `contratacoes/*` ≤ 50, `instrumentoscobranca` ≤ 100, `atas/*` e `contratos/*` ≤ 500; PCA tem contrato próprio. Use `clampConsultaPageSize` / `clampComprasGovPageSize`.
- **[IMPORTANTE]** HTTP sem timeout; retry sem limite, sem backoff ou sem respeitar `Retry-After`; retry em 4xx permanente.
- **[IMPORTANTE]** Ingestão não idempotente (reexecutar duplica). Identidade = chave oficial; `payload_hash` só detecta mudança.
- **[IMPORTANTE]** Dado oficial sobrescrito por derivado sem preservar original e provenance (fonte, endpoint, parâmetros, id externo, timestamp, hash).
- **[IMPORTANTE]** Discovery e hydration misturados sem fronteira recuperável; fan-out longo sem checkpoint ou lock.

### Cálculos financeiros
- **[BLOQUEANTE]** BDI, margem, imposto ou exequibilidade sem regra de arredondamento explícita e sem teste; cálculo não determinístico ou delegado a LLM.

### Reuso e escopo
- **[IMPORTANTE]** Segunda implementação de conceito que já existe em `supabase/functions/_shared/` (http, retry, idempotency, upsert, hash, checkpoint, lock, clients) ou `scripts/`.
- **[IMPORTANTE]** Edge Function nova fora da lista `FUNCTIONS` de `.github/workflows/deploy-supabase-functions.yml` (nunca será publicada) ou fora do `deno check` de `.github/workflows/pr-quality.yml`.
- **[IMPORTANTE]** Refatoração fora do escopo; arquivo de dados/log > 5 MB ou `*_resultado.json` commitado.
- **[BLOQUEANTE]** AWS Cognito/RDS/S3 ou Asaas introduzidos sem pedido explícito.

### Testes
- **[BLOQUEANTE]** Correção de bug P0/P1 sem teste de regressão.
- **[IMPORTANTE]** Mudança funcional sem teste proporcional ao risco (ver cobertura esperada em `tests.instructions.md`: erro ≠ vazio, paginação, retry, idempotência, NULL em `codigoValorCaracteristica`).
- **[IMPORTANTE]** Teste unitário chamando PNCP/Compras.gov reais ou com `sleep` real. A CI roda `deno test` sem `--allow-net`.

### Front-end (Kuib-Harness)
- Estados de carregamento, vazio e erro explícitos; nunca preencher com valor inventado.
- Nenhuma chave privilegiada no renderer; chamadas privilegiadas via backend.

## Comandos

Rode somente o que se aplica aos arquivos alterados:

```bash
# Edge Functions (mesmos arquivos do job "Deno check" da CI + os alterados)
deno check <arquivos .ts alterados>
deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt --reporter=dot

# Collectors Python (raiz)
python -m pip install -r requirements-dev.txt
pytest tests/ -q --tb=short

# coletor-externo
cd services/coletor-externo && python -m pytest -q --tb=short

# App Electron
cd Kuib-Harness && npm run typecheck && npm run build

# Secrets no diff
git diff origin/main...HEAD | grep -nE "service_role|sbp_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}\.|SUPABASE_SERVICE|api[_-]?key\s*[:=]"
```

## Severidade

| Tag | Significado | Merge |
|---|---|---|
| **[BLOQUEANTE]** | Dado inventado, erro virando vazio, falha de segurança, perda/corrupção de dado, schema sem migration | Não aprovar até corrigir |
| **[IMPORTANTE]** | Risco real e limitado: idempotência, paginação, timeout, reuso, teste faltando | Corrigir no PR ou abrir issue vinculada |
| **[SUGESTÃO]** | Legibilidade, nomes, melhoria opcional | A critério do autor |

Não comente estilo que um linter/formatter resolveria. Não invente problemas: "nenhum problema encontrado" é um resultado válido.

## Formato do relatório

```markdown
## Resumo
<1–3 frases: o que o PR faz e a avaliação geral>

**Veredito:** ✅ Aprovar | ⚠️ Aprovar com ressalvas | ❌ Solicitar alterações

## Achados

### [BLOQUEANTE] <título curto> — `caminho/arquivo.ext:linha`
**Regra:** <arquivo de instrução/AGENTS.md que a define>
**Problema:** <uma frase>
**Cenário:** <entrada/estado concreto → resultado errado>
**Correção sugerida:**
```<linguagem>
<código>
```

### [IMPORTANTE] …
### [SUGESTÃO] …

## Verificações
- [x] <comando> — <resultado>
- [ ] <o que não foi executado e por quê>
- Contexto externo (issues/checks/PRs citados): verificado | não verificado
```

## Regras finais

- Ordene os achados do mais grave para o menos grave.
- Todo achado tem arquivo, linha, regra de origem e cenário concreto.
- Critique o código, não a pessoa; proponha a correção em código.
- Não aprove com qualquer [BLOQUEANTE] aberto.
- PR grande demais para revisar com qualidade: diga isso e sugira dividir.
- Não use o MCP do Supabase na revisão do Copilot (exige OAuth, não suportado no code review).
