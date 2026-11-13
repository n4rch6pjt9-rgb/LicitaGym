# 0023: Registrar na linha da oportunidade o SHA do payload, a origem e a hora da última ingestão

- **Status:** entregue
- **Issue:** #363 (requisito registrado nos comentários de 14/10/2026); Dashboard #93 (coluna Sync)
- **Área:** migrations + coletor + edge-functions + dashboard-contrato
- **Depende do ok do Marcelo:** sim (migration em `licitacoes_externas`, mudança de contrato da `api-dashboard-oportunidades`, republicação de funções)

## Problema

A tabela `/oportunidades` ganhou a coluna **Sync** (Dashboard #93, 14/10/2026), mas o backend não sabe dizer quando
nem como cada linha foi ingerida pela última vez. Medido em produção em 14/10/2026 (MCP somente leitura):

- `licitacoes_externas`: 1.656 linhas (1.651 `pncp`, 3 `sestsenat`, 2 `sfiec`), todas com `raw`. `last_synced_at`
  e `updated_at` são iguais a `created_at` em **todas** (0 linhas diferentes): o upsert do coletor
  (`destino.py:156`, `merge-duplicates`) não envia essas colunas, então uma recoleta não as toca. Hoje a coluna Sync
  mostra "Coleta dd/mm às hh:mm" com `last_synced_at`, que é a primeira coleta.
- As colunas `payload_hash`, `first_seen_at` e `last_seen_run_id` já existem desde a migration `20260925120000`
  (Sistema S), mas para esta tabela estão vazias: 0 linhas com `payload_hash`, 0 com `last_seen_run_id`;
  `first_seen_at` preenchido em todas (default). `private.coleta_externa_run` tem 0 execuções (nenhum coletor a grava).
- Nenhuma coluna diz se a linha veio de cron ou de disparo manual. `private.cron_edge_chamadas` registra chamadas de
  Edge Functions pelo cron (última em 14/10 11:00 UTC), mas o coletor Python (`python -m coletor.pncp`) roda à mão,
  fora do cron, e não registra execução.
- **Quem escreve em `licitacoes_externas`:** o coletor Python (`coletor/pncp.py:1456-1464`, `paradigma.py`,
  `main.py`), os backfills `coletor/backfill_*.py` e a Edge Function `sync-portal-compras` (só `link_sistema_origem`
  e consulta ao portal). Os syncs nacionais `sync-pncp-contratacoes-editais/-atas/-contratos/-itens` e `sync-pncp-irp`
  **não** escrevem nessa tabela (gravam `contratacoes_*`, `source_record`, `pncp_sync_run`). O pedido original cita
  esses syncs como fonte da proveniência: hoje eles não alimentam a lista de oportunidades (pergunta 1).

Decisões já tomadas pelo Marcelo em 14/10/2026 (#363): SHA-256 do payload normalizado; origem `cron` ou `manual`
com data/hora; UTC no banco, Brasília na tela; **só a última passagem, em colunas da própria linha** (sem tabela 1:N).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova (resultado em 14/10/2026) |
|---|---|---|
| CA-1 | **Dado** a migration aplicada, **então** `licitacoes_externas` tem `ingestao_origem text check in ('cron','manual')` (nulo permitido: linha anterior à spec), `ingestao_em timestamptz` e reutiliza `payload_hash text`; aplicada duas vezes, sem erro; `anon` sem privilégio e `authenticated` sem SELECT direto (como hoje). | `scripts/validar-migrations.sh` + SQL `supabase/tests/proveniencia_oportunidades_check.sql`: passa |
| CA-2 | **Dado** uma compra do PNCP coletada por `coletor.pncp`, **quando** a linha é gravada ou regravada, **então** `payload_hash = sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False, separators=(',', ':')))`, `ingestao_em = agora (UTC)` e `ingestao_origem` = valor do argumento `--origem` (`cron` ou `manual`; padrão `manual`). Teste unitário sem API real. | pytest `services/coletor-externo/tests/test_pncp_proveniencia.py`: passa |
| CA-3 | **Dado** a mesma compra recoletada com `raw` idêntico, **quando** o coletor grava de novo, **então** `payload_hash` não muda, `ingestao_em` e `ingestao_origem` mudam para a passagem nova (última passagem, não histórico) e `first_seen_at`/`created_at` ficam como estavam. | pytest `services/coletor-externo/tests/test_pncp_proveniencia.py` + SQL `supabase/tests/proveniencia_oportunidades_check.sql` (upsert duas vezes em `begin/rollback`): passa |
| CA-4 | **Dado** `raw` ausente ou vazio, **então** `payload_hash` é nulo (nada inventado) e `ingestao_em`/`ingestao_origem` ainda são gravados. | pytest `services/coletor-externo/tests/test_pncp_proveniencia.py`: passa |
| CA-5 | **Dado** `action=list` ou `get` da `api-dashboard-oportunidades`, **então** cada item traz `ingestao_origem`, `ingestao_em` e `payload_hash` (nulos quando a linha é anterior à spec), sem mudar os campos existentes. | Deno `tests/supabase/functions/api_dashboard_oportunidades_proveniencia_test.ts`: passa |
| CA-6 | **Dado** a `api-syncs` com `action: "rodar"`, **então** o corpo enviado à função disparada inclui `origem: "manual"`; e o job do pg_cron chama a mesma função com `origem: "cron"` (migration do cron, `private.cron_edge_chamadas.corpo`). O `sync-portal-compras` recebe `origem` mas não altera `ingestao_*` (só link do portal; decisão 4). | Deno `tests/supabase/functions/api_syncs_test.ts` (já existe; caso novo) + SQL `supabase/tests/proveniencia_oportunidades_check.sql` (corpo do job com `origem`, só onde há pg_cron): passa |
| CA-7 | **Dado** `anon` ou `authenticated` sem vínculo, **quando** tenta ler `licitacoes_externas` direto, **então** sem acesso (ACL atual preservada: migration `20260928140000`). CA negativo. | SQL `supabase/tests/proveniencia_oportunidades_check.sql`: passa |
| CA-9 | **Dado** qualquer escritor de `licitacoes_externas` que grave ou regrave o payload (hoje `coletor.pncp` e `coletor.paradigma`; depois da #363, os syncs nacionais), **então** envia os três campos; o `sync-portal-compras` (só link do portal) e os `backfill_*.py` não os tocam. | pytest `services/coletor-externo/tests/test_pncp_proveniencia.py` (paradigma incluso) + Deno `tests/supabase/functions/sync_portal_compras_test.ts` (caso: linha regravada sem mudar `ingestao_*`): passa |
| CA-8 | **Dado** o Dashboard com um item com `ingestao_origem = 'cron'` e `ingestao_em = '2026-10-14T09:00:00Z'`, **então** a célula Sync mostra `cron · 14/10/2026 às 06:00`; com os campos nulos, mostra `Coleta <first_seen_at>` como hoje (sem inventar origem). | Dashboard: vitest `src/test/oportunidades-ux-48.test.tsx` (`src/test/sync-origem.test.ts`, Dashboard #94 mergeado `5969e20` em 14/10): passa |

## Fora de escopo

- Histórico de todas as passagens (tabela 1:N): decisão do Marcelo em 14/10, só a última passagem.
- Ligar os syncs nacionais no cron, o gate pelo catálogo e a gravação deles em `licitacoes_externas` (#363): esta spec
  define o contrato (`origem` no corpo, três colunas) que a #363 reutiliza.
- Cloud Run Job do coletor (#187): aqui o coletor ganha `--origem`; quem o agenda decide o valor.
- Backfill do `payload_hash` das 1.656 linhas antigas: não; preenche na próxima recoleta (decisão de 14/10).
- Proveniência de `licitacao_documentos`, `licitacao_resultados`, `contratacoes_*`.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/20261014190000_proveniencia_oportunidades.sql`, aditiva e idempotente:
  `add column if not exists ingestao_origem text`, `ingestao_em timestamptz`, check de `ingestao_origem`, comentários
  nas três colunas (inclusive `payload_hash`, que passa a ter semântica definida: sha256 hex do `raw` serializado de
  forma estável pelo coletor Python). Achado do `revisor-codigo` em 14/10: esse cálculo **não** é o de
  `_shared/pncp/hash.ts` (`150000.0` vs `150000`; chaves voláteis descartadas só no TS). Alinhar os dois é
  pré-requisito da #363 antes de os syncs em TS gravarem `licitacoes_externas`. Sem `set not null` (linhas antigas ficam nulas).
  Ajuste do job do pg_cron de `sync-portal-compras` (`20261008180000`) para enviar `origem: "cron"` no corpo (migration
  de cron depende de `pg_cron`: pulada no validador, como as outras).
- **Tabelas/views/funções tocadas:** `licitacoes_externas` (escreve: coletor Python, `sync-portal-compras`; lê:
  `api-dashboard-oportunidades`, `api-pipeline`, `api-tarefas`, `api-agentes`, `link-pca-edital`, views
  `licitacoes_externas_prioridade_efetiva` e `licitacoes_pncp_canonica`). As views `select *`? Conferir no
  `/implement`: se forem `select` com colunas nomeadas, as colunas novas não aparecem nelas e a API precisa lê-las da
  tabela ou a view precisa ser recriada (`create or replace view` com as colunas novas no fim).
- **ACL/RLS:** nenhuma mudança; colunas novas herdam a ACL da tabela.
- **Backfill/reprocessamento:** não. Contagem no PR: antes 0 linhas com `payload_hash`/`ingestao_origem`; depois da
  primeira recoleta, N linhas (relatar).
- **Edge Functions republicadas no merge:** todas (integração); com mudança de código em `api-dashboard-oportunidades`
  (3 campos novos na projeção) e `api-syncs` (`origem` no corpo); `sync-portal-compras` não grava proveniência (decisão 4).
- **Contrato com o Dashboard:** muda, aditivo: `contratacao.ingestao_origem` (`'cron' | 'manual' | null`),
  `contratacao.ingestao_em` (ISO UTC ou null), `contratacao.payload_hash` (hex ou null). Backend vai ao ar antes; o
  front mantém o fallback "Coleta <first_seen_at>" para nulos.
- **Dado oficial x derivado:** `raw` é oficial; `payload_hash`, `ingestao_origem` e `ingestao_em` são derivados da
  passagem do coletor, nunca inventados (nulo quando não há passagem registrada).
- **Branch Supabase:** não necessária (só `add column`, sem backfill, sem RLS).

## Perguntas em aberto

Nenhuma. Respondidas pelo Marcelo em 14/10/2026:
1. **Sim:** depois da #363 os syncs nacionais (editais, atas, contratos, IRP) passam a alimentar `licitacoes_externas`.
   Consequência: todo escritor de `licitacoes_externas`, atual ou futuro, grava `payload_hash`, `ingestao_origem` e
   `ingestao_em`; a regra entra como CA-9 e a ligação sync → `licitacoes_externas` em si é implementada na #363,
   que reutiliza o mesmo contrato (`origem` no corpo da chamada, CA-6).
2. **Backfills não mexem** na proveniência.
3. **Hash só na próxima recoleta**, sem backfill por migration.
4. **`sync-portal-compras` não conta** como ingestão: não altera `ingestao_em`/`ingestao_origem`.
