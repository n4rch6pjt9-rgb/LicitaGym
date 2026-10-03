# LicitaGym — Instruções para o Copilot (chat e code review)

SaaS de monitoramento de licitações públicas (foco: equipamentos fitness). Stack: Supabase (Postgres + RLS + Edge Functions em Deno/TypeScript), collectors Python, app Electron (`Kuib-Harness/`). Fontes oficiais: PNCP, Compras.gov.br (Dados Abertos), Compras RJ.

Responda e comente reviews **em português**. Regras detalhadas: `AGENTS.md` e `.github/instructions/*.instructions.md`.

## Prioridades do produto
Precisão > rastreabilidade > dados oficiais > auditabilidade > segurança. Não sugira atalhos que troquem precisão por conveniência.

## Como revisar um PR
Siga `.github/skills/code-review/SKILL.md` em toda revisão de pull request.

Classifique cada comentário: **Alto**, **[IMPORTANTE]** ou **[SUGESTÃO]**. **Alto** é a severidade alta do review (o que antes era [BLOQUEANTE]). Não comente estilo que um linter resolveria. Seja específico: aponte a linha, a regra e a correção.

## Sinalizar como Alto

Produto (o cliente vende produtos que casam com o CATMAT dele, equipamentos fitness — não serviços):

- Contrato de serviço nunca vira lead: credenciamento, locação, manutenção (inclusive manutenção com fornecimento de peças), obra, oficineiros.
- Um termo de busca sozinho não torna a linha `forte`.
- Polia e espaldar são `forte`. Pilates, "aparelho para condicionamento físico" genérico e colchonete são `fraco`. `Puxador` é positivo só na categoria acessórios. Academia ao ar livre só conta junto com piso.
- Prioridade: `leads` = recebendo proposta; `monitorar` = em julgamento, suspensa, adjudicação ou recurso; `historico` = encerrada ou homologada. Status desconhecido nunca vira lead.
- Fallback silencioso que troca a prioridade (ex.: cair para `encerradas` ignorando documento ou falha de API).
- O pipeline do Dashboard nunca é alimentado automaticamente. Só entra pelo botão explícito "Enviar para pipeline".
- Histórico e mapa de fornecedor (marca, preço por item CATMAT, revenda ou fabricante) só de certames homologados, só no BI, rastreáveis pelo certame.
- CPF e CNPJ em documentos de edital são dados públicos: não mascarar no RAG.
- RAG usa `text-multilingual-embedding-002` com 768 dimensões. Trocar o modelo de embedding sem plano de reindex aprovado no PR.
- Alteração de classificação sem dry-run (contagem antes e depois) no texto do PR.

Engenharia e deploy:

- Merge na `main` republica **todas** as Edge Functions pela integração Supabase ↔ GitHub e aplica migrations em produção. PR que mexe em `supabase/functions/**` ou `supabase/migrations/**` é alto risco.
- Migration com timestamp menor ou igual à última da `main`, ou não idempotente (`IF NOT EXISTS` / `CREATE OR REPLACE`). Já houve quebra de deploy por migration aplicada só em produção.
- `DROP` ou `DELETE` destrutivo sem backup e sem dizer isso no PR.
- Chave ou segredo no código. `SUPABASE_SERVICE_ROLE_KEY` e credenciais GCP só em secret.
- `wrangler deploy`.
- Coletor não idempotente, `DELAY_SEGUNDOS` < 1, ou tipo de arquivo pela extensão em vez dos bytes.

Os itens [BLOQUEANTE] abaixo também são Alto.

Se a descrição citar issue (`#123`), check do Actions ou outro pull request, consulte o GitHub MCP (somente leitura) antes de comentar. Se a ferramenta falhar, declare o contexto como não verificado. Não use o MCP do Supabase nesta revisão: o servidor em `.cursor/mcp.json` exige OAuth, e o Copilot code review não suporta MCP remoto com OAuth.

Sempre **[BLOQUEANTE]**:
1. **Dado inventado** — valor, preço, quantidade, CATMAT/PDM, UASG, número da compra, data, BDI, imposto ou margem hardcoded/fabricado em fluxo de produção, ou default que mascara ausência (`0`, `""`, `"N/A"`). Ausência deve ser representada como ausente/não verificada.
2. **Erro tratado como vazio** — `except: return []`, `catch { return [] }`, timeout/429/5xx/JSON inválido virando lista vazia ou `null`.
3. **Secrets** — `service_role`, `sbp_…`, JWT, senha, API key em código, migration, log, fixture ou `.env` versionado.
4. **Schema sem migration** — alteração de banco fora de `supabase/migrations/`.
5. **Tabela nova sem `ENABLE ROW LEVEL SECURITY`**.
6. **Edge Function sem autenticação** — as funções são publicadas com `--no-verify-jwt`; todo handler protegido deve, logo no início, chamar um helper de `_shared/http.ts` e retornar a resposta 401 que ele devolve: `requireCronAuth(req)` para sync/cron (o legado `validateCronAuth(req)` + 401 ainda é aceito), `requireUserAuth(req)` para endpoint de usuário (JWT do Supabase Auth; o secret de cron **não** vale como sessão) e `requireCronOrUserAuth(req)` quando ambos são permitidos. Ação pública deve ser explícita e não expor dado sensível. Não criar validação de token própria.
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
