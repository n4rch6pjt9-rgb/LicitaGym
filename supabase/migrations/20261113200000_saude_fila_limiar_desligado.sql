-- LicitaGym, spec 0064 (decisão do Marcelo de 13/11/2026, revisão do PR #553): desliga o limiar
-- coleta_externa_fila_pendente_horas até a fila do Sistema S escoar.
--
-- Contexto: a migration 20261113180000_coleta_externa_fila.sql (já aplicada) criou a verificação ligada (atenção 26 h,
-- crítico 48 h). A primeira descoberta de cada portal enche private.coleta_externa_fila com o mural dos últimos 24
-- meses, e a carga leva dias para escoar: a verificação ficaria em atenção/crítico sem falha real e o saude.yml
-- abriria alerta-operacional. Desligada, ela some de private.saude_operacional_resumo() (filtro l.ativo) e sai
-- também de SAUDE_VERIFICACOES_ESPERADAS no saude.yml, no mesmo PR (senão o resumo sem ela acusaria contrato
-- incompleto).
--
-- O que muda: private.saude_limiares.ativo = false na linha coleta_externa_fila_pendente_horas. Nada mais (os
-- limiares 26/48 ficam guardados para quando religar).
-- Escreve: private.saude_limiares (1 linha). Lê: ninguém além da saúde (service_role, api-saude).
-- Verificação: supabase/tests/saude_coleta_externa_fila_check.sql.
-- Idempotente: update só onde ainda está ligado.
--
-- RELIGAR depois do primeiro escoamento (nova migration + saude.yml no mesmo PR):
--   update private.saude_limiares set ativo = true where verificacao = 'coleta_externa_fila_pendente_horas';
--   e coleta_externa_fila_pendente_horas de volta em SAUDE_VERIFICACOES_ESPERADAS.

begin;

update private.saude_limiares
   set ativo = false
 where verificacao = 'coleta_externa_fila_pendente_horas' and ativo;

commit;
