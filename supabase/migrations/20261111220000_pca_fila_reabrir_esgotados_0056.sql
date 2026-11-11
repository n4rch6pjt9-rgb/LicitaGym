-- Reabre os planos PCA de 2026 que esgotaram as tentativas na fila antes da spec 0056 (PR #523).
-- Migration só de dado: sem DDL, sem ACL, sem função nova.
--
-- Contexto (medido em produção em 11/11/2026, MCP somente leitura): 200 linhas em private.pca_plano_fila com
-- status 'erro' e tentativas >= 5, todas de 2026, atualizadas entre 27/10 e 06/11 (nenhuma em 'processando'):
--   140  "1 erro(s) na gravação em lote"            (falha de vínculo com o catálogo, P-3; desde a 0056 é aviso)
--    39  "classificacaoSuperiorCodigo inválida"       (classe fora do padrão; desde a 0056 é aviso)
--    21  "HTTP 503 on pncp.gov.br"                    (queda passageira do PNCP)
-- A impressão diária não reabre essas linhas: pca_fila_enfileirar só volta um 'erro' para 'pendente' quando a data
-- da fonte é mais nova que a gravada. A reabertura pela Edge Function (recuperar_esgotados) exige o segredo do cron e
-- dispara uma descoberta completa pela consulta /v1/pca/; por decisão do Marcelo (11/11/2026), a reabertura vai por
-- migration.
--
-- O que muda: os mesmos campos que private.pca_fila_reabrir_esgotados zera (status, tentativas, disponivel_em,
-- reserva_token, atualizado_em). Para não perder a causa, `erro` guarda "reaberto 0056; antes: <erro anterior>" (a
-- carga sobrescreve ao terminar o plano; status e tentativas é que decidem a fila) e `chain_id` recebe o uuid fixo
-- 00560000-0000-4000-8000-000000000056, que identifica esta reabertura. motivo, plano, data_atualizacao_fonte e
-- criado_em ficam como estão. A continuação da carga (licitagym-sync-pncp-pca-fila-continuacao, 06–08 UTC) processa
-- as linhas depois da impressão das 05:00 UTC.
--
-- Proteções: só as três causas medidas; corte em atualizado_em < 2026-11-11 (rodar de novo não toca linha nenhuma,
-- porque as reabertas saem de 'erro'); teto de 250 linhas, acima do qual a migration falha em vez de reabrir em massa.
-- Na branch de preview a fila nasce vazia: o check verde do preview não prova nada sobre as 200 linhas.
--
-- Verificar: supabase/tests/pca_fila_reabrir_esgotados_0056_check.sql e, em produção,
--   select status, count(*) from private.pca_plano_fila
--    where chain_id = '00560000-0000-4000-8000-000000000056' group by 1;
begin;

set local lock_timeout = '10s';

do $reabrir$
declare
  v_n integer;
begin
  update private.pca_plano_fila
     set status = 'pendente',
         tentativas = 0,
         erro = left('reaberto 0056; antes: ' || coalesce(erro, ''), 500),
         disponivel_em = null,
         reserva_token = null,
         chain_id = '00560000-0000-4000-8000-000000000056'::uuid,
         atualizado_em = now()
   where ano = 2026
     and status = 'erro'
     and tentativas >= 5
     and atualizado_em < timestamptz '2026-11-11 00:00:00+00'
     and (erro like '%erro(s) na gravação em lote%'
       or erro like '%classificacaoSuperiorCodigo%'
       or erro like '%HTTP 503%');
  get diagnostics v_n = row_count;
  if v_n > 250 then
    raise exception 'reabertura 0056: % linhas, acima do teto de 250; nada foi reaberto', v_n;
  end if;
  raise notice 'reabertura 0056: % linha(s) reaberta(s)', v_n;
end;
$reabrir$;

commit;
