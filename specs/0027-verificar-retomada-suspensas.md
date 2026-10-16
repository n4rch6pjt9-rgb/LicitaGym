# 0027: Verificar a retomada das licitações suspensas conforme a regra do documento de suspensão

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** coletor + migrations + edge-functions
- **Sequência:** 0026a (situação atual) → 0026b (rota e tela de suspensas) → 0027 (esta)
- **Depende do ok do Marcelo:** sim (migration, cron novo e leitura de documento em produção)

## Problema

Depois da 0026b, a compra suspensa sai de Oportunidades e fica na tela de suspensas. Ela só volta quando a coleta
diária do PNCP ou o `sync-portal-compras` mudarem a situação. Nenhum dos dois olha o que o **documento de suspensão**
diz sobre a retomada: data marcada, prazo em dias ou *sine die*.

**Decisão do Marcelo em 16/10/2026:** um cron verifica cada suspensa **conforme a regra posta no documento de
suspensão**, em spec própria.

**Casos:**
- **Biguaçu** (id 2392): aviso de suspensão *sine die*, de 19/08/2026; retomada por errata em 29/09.
- **Ibatiba** (id 2660): termo de 22/09/2026 sem data de retomada, reinício em 02/10; nova suspensão no portal em
  16/10, "para análise e retificação", sem documento no PNCP.

**Medição em produção** (somente leitura, 16/10/2026):
- **30** compras em "Suspensa" ou "Suspensa (documento)";
- **1** delas tem texto de documento extraído em `licitacao_chunks`. Para ler a regra, o texto do documento de
  suspensão precisa ser extraído; hoje quase nenhum é;
- quantas têm data ou prazo de retomada escritos no documento: **não medido** (depende da extração).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o texto extraído de um documento de suspensão, **quando** a regra é lida, **então** sai uma de três, por padrões escritos nesta spec e com o trecho que casou guardado: (i) **data de retomada** ("até DD/MM/AAAA", "retomada em DD/MM/AAAA", "nova data … DD/MM/AAAA"); (ii) **prazo** ("por N dias", "pelo prazo de N dias úteis"), contado da data do documento, com a regra de dias úteis escrita; (iii) **sine die ou sem regra** (nada casou, "sine die", "prazo indeterminado"). Nunca inventa data. | pytest `services/coletor-externo/tests/test_regra_suspensao.py`, com fixtures do texto de Biguaçu e de Ibatiba |
| CA-2 | **Dado** uma compra suspensa por documento do PNCP sem texto extraído, **quando** o cron roda, **então** baixa só o documento de suspensão (PDF, timeout explícito, retry com backoff), extrai o texto e guarda a regra; PDF sem texto (imagem) vira "sem regra", registrado. | pytest `services/coletor-externo/tests/test_suspensas.py` (sem rede, PDF de fixture) |
| CA-3 | **Dado** a regra, **quando** o cron agenda, **então**: data ou prazo → próxima verificação no dia da retomada e diária depois dele; sine die, sem regra ou suspensão só do portal → verificação diária. | pytest `services/coletor-externo/tests/test_suspensas.py` |
| CA-4 | **Dado** uma compra no dia de verificação, **quando** o cron roda, **então** relê o PNCP (situação, documentos, datas) e, quando houver página, o portal; se aparecer edital retificado (regra da 0026a) ou status do portal fora da suspensão, a situação é recalculada e ela sai da tela de suspensas. Falha de leitura não tira a compra da suspensão: fica registrada, e a execução termina parcial. | pytest `services/coletor-externo/tests/test_suspensas.py` |
| CA-5 | **Dado** a data de retomada vencida e nenhum sinal de retomada, **quando** o cron roda, **então** a compra continua suspensa, com o alerta "Retomada prevista para DD/MM não confirmada" na tela de suspensas. | pytest + vitest `src/test/suspensas.test.tsx` (repo `Dashboard---LicitaGym`) |
| CA-6 | **Dado** a rota `action=suspensas` da 0026b, **quando** o usuário a consulta, **então** cada compra traz a regra (tipo, data prevista, trecho do documento), a última e a próxima verificação e o resultado da última. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-7 | **Dado** o cron, **quando** roda, **então** registra a execução em `private.coleta_externa_run` (ou tabela de execução já existente), aparece na saúde operacional e respeita `DELAY_SEGUNDOS >= 1` entre chamadas. | pytest + SQL `supabase/tests/suspensa_verificacao_check.sql` |

## Fora de escopo

- Extrair texto de outros documentos além do de suspensão (edital, TR): pipeline de documentos e Agente de Edital.
- Interpretar a suspensão por IA: a regra é por padrão escrito e determinístico.
- Notificar o usuário quando a suspensa retomar.
- Suspensão de item (item 73 de Ibatiba).

## Impacto em dados

- **Migration:** sim, `<timestamp>_suspensa_verificacao.sql`, aditiva e idempotente: tabela
  `private.suspensa_verificacao` (licitação, documento, tipo de regra, data prevista, trecho, última e próxima
  verificação, resultado), RLS ligada, só `service_role`, e o job do `pg_cron`. **Pede branch Supabase** (pg_cron e o
  stub `pre.sql`).
- **Tabelas/views/funções tocadas:** `licitacoes_externas` (recalculada pela coleta), `portal_consulta` (leitura),
  `api-dashboard-oportunidades` (`action=suspensas` ganha os campos da regra).
- **ACL/RLS:** tabela nova só para `service_role`.
- **Backfill/reprocessamento:** sim, primeira leitura dos documentos das suspensas atuais (30 em 16/10), com
  contagem por tipo de regra no PR.
- **Onde roda:** no coletor Python (Cloud Run) ou em Edge Function: pergunta 1.
- **Edge Functions republicadas no merge:** todas.
- **Contrato com o Dashboard:** muda, por campos novos em `action=suspensas`.
- **Dado oficial x derivado:** o documento e o trecho aparecem como vieram; a data prevista é derivada por regra
  escrita e aparece marcada como calculada, com o trecho de origem.

## Perguntas em aberto

1. **Onde roda o cron:** no coletor Python (já baixa documentos do PNCP e tem retry e backoff) ou numa Edge Function
   nova? A proposta é o coletor, com um job diário próprio.
2. **Prazo em dias:** "N dias" sem "úteis" conta corridos? E dias úteis consideram só fim de semana ou também
   feriados (qual calendário)?
