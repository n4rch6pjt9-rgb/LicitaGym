# LicitaGym — Instruções para o Copilot (chat e code review)

SaaS de monitoramento de licitações públicas (foco: equipamentos fitness). Stack: Supabase (Postgres + RLS + Edge Functions em Deno/TypeScript), collectors Python, app Electron (`Kuib-Harness/`). Fontes oficiais: PNCP, Compras.gov.br (Dados Abertos), Compras RJ.

Responda e comente reviews **em português**. Regras detalhadas: `AGENTS.md` e `.github/instructions/*.instructions.md`.

## Prioridades do produto
Precisão > rastreabilidade > dados oficiais > auditabilidade > segurança. Não sugira atalhos que troquem precisão por conveniência.

## Como revisar um PR
Siga `.github/skills/code-review/SKILL.md` em toda revisão de pull request.

Classifique cada comentário: **[BLOQUEANTE]**, **[IMPORTANTE]** ou **[SUGESTÃO]**. Não comente estilo que um linter resolveria. Seja específico: aponte a linha e proponha a correção.

Se a descrição citar issue (`#123`), check do Actions ou outro pull request, consulte o GitHub MCP (somente leitura) antes de comentar. Se a ferramenta falhar, declare o contexto como não verificado. Não use o MCP do Supabase nesta revisão: o servidor em `.cursor/mcp.json` exige OAuth, e o Copilot code review não suporta MCP remoto com OAuth.

Sempre **[BLOQUEANTE]**:
1. **Dado inventado** — valor, preço, quantidade, CATMAT/PDM, UASG, número da compra, data, BDI, imposto ou margem hardcoded/fabricado em fluxo de produção, ou default que mascara ausência (`0`, `""`, `"N/A"`). Ausência deve ser representada como ausente/não verificada.
2. **Erro tratado como vazio** — `except: return []`, `catch { return [] }`, timeout/429/5xx/JSON inválido virando lista vazia ou `null`.
3. **Secrets** — `service_role`, `sbp_…`, JWT, senha, API key em código, migration, log, fixture ou `.env` versionado.
4. **Schema sem migration** — alteração de banco fora de `supabase/migrations/`.
5. **Tabela nova sem `ENABLE ROW LEVEL SECURITY`**.
6. **Edge Function sem autenticação** — as funções são publicadas com `--no-verify-jwt`; todo handler protegido deve chamar `validateCronAuth(req)` de `_shared/http.ts` e retornar 401 quando o resultado for `false`. Se forem necessários handlers de usuário, adicionar e documentar helper de validação de sessão/claims antes de exigir seu uso.
7. **Identificador oficial substituído** por chave interna, ou `codigoItem` tratado como equivalente a `codigoPdm`.
8. **Cálculo financeiro não determinístico** (BDI, margem, exequibilidade) sem regra de arredondamento explícita e sem teste.

Normalmente **[IMPORTANTE]**:
- Ingestão não idempotente (reexecução duplica registros).
- Dado oficial sobrescrito por dado derivado/normalizado sem preservar o original e a provenance.
- Chamada HTTP sem timeout, retry sem limite ou `PAGE_SIZE` global.
- Segunda implementação de um conceito que já existe em `_shared/` ou `scripts/`.
- Mudança funcional sem teste proporcional ao risco.
- Arquivo de dados grande (JSON/log > 5 MB) adicionado ao repositório.
- Refatoração fora do escopo do PR.

## Ao gerar código
- Leia `docs/pncp/schemas-consultas-pncp.md` e `docs/compras-gov/schemas-consultas.md` antes de escrever requisições.
- Reutilize os clientes e helpers de `supabase/functions/_shared/` (http, retry, idempotency, upsert, hash, checkpoint, lock) e os limitadores de página `clampConsultaPageSize` (`pncp/consulta-client.ts`) e `clampComprasGovPageSize` (`compras-gov/material-client.ts`).
- Não introduza AWS Cognito/RDS/S3 nem Asaas sem pedido explícito.
- UI: estados de carregamento, vazio e erro explícitos; nunca preencher com valor inventado.

## Critério de conclusão
Typecheck, lint, testes relevantes e build passando; migration para mudança de banco; nenhum secret; sem dados hardcoded desnecessários. Se algo não pôde ser verificado, diga explicitamente.
