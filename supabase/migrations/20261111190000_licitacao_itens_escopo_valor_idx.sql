-- LicitaGym: índice parcial para o resumo executivo do painel (spec 0050)
--
-- Contexto (medido em 11/11/2026, só leitura): public.dashboard_resumo_executivo (20261109060000) estoura o
-- statement_timeout do PostgREST (8 s) e a api-dashboard-oportunidades responde 503 "resumo executivo indisponível".
-- Logs de 11/11 (17:00, 17:04, 17:31, 18:26, 18:27 UTC): "canceling statement due to statement timeout" (57014).
-- pg_stat_statements: chamadas concluídas com média de 2,15 s e máxima de 7,05 s. Reprodução com EXPLAIN ANALYZE:
-- 10,15 s, dos quais 9,6 s no CTE valor_itens, que faz um Nested Loop sobre licitacao_itens_licitacao_id_numero_item_key
-- (2.068 certames × ~81 itens lidos, ~78 descartados pelo filtro de escopo). licitacao_itens tem ~290 mil linhas; só
-- ~16 mil atendem o filtro.
--
-- O que muda: índice btree parcial em public.licitacao_itens (licitacao_id) incluindo valor_total_estimado, com o
-- MESMO predicado do CTE valor_itens (categoria_escopo nas 6 categorias que contam + valor não nulo). O CTE passa a
-- ler só as entradas do escopo. Nada mais muda (função, ACL e dados intactos).
-- Lock: create index sem concurrently (concurrently não roda dentro de transação de migration) pega SHARE em
-- licitacao_itens: bloqueia INSERT/UPDATE/DELETE (coletores) até o commit. A construção varre a tabela inteira
-- (~290 mil linhas), então a escrita fica parada por alguns segundos, embora o índice final seja pequeno (~16 mil
-- entradas). lock_timeout de 10 s limita só a espera pelo lock (escritas novas ficam na fila atrás dela): se estourar,
-- a migration falha inteira e precisa ser reaplicada. Preferir o merge fora do horário de coleta.
-- Quem lê: dashboard_resumo_executivo (service_role, via api-dashboard-oportunidades).
-- Idempotente. Verificação: supabase/tests/licitacao_itens_escopo_valor_idx_check.sql.

begin;

set local lock_timeout = '10s';

create index if not exists licitacao_itens_escopo_valor_idx
  on public.licitacao_itens (licitacao_id) include (valor_total_estimado)
  where categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
    and valor_total_estimado is not null;

commit;
