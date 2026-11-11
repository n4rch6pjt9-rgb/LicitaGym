-- Checagem da migration 20261111220000_pca_fila_reabrir_esgotados_0056.sql. Falha com EXCEPTION se:
--   RESTO  ainda existir linha de 2026 em private.pca_plano_fila com status 'erro', tentativas >= 5, atualizada antes
--          de 2026-11-11 e erro de uma das três causas reabertas (P-3, classe, HTTP 503);
--   EFEITO alguma linha marcada com o chain_id da reabertura estiver em 'pendente' sem os campos zerados (tentativas,
--          disponivel_em, reserva_token) ou sem o rastro "reaberto 0056" no erro.
-- No banco descartável a fila nasce vazia e a checagem passa; em produção ela prova que a reabertura pegou todas as
-- linhas do corte e deixou as reabertas prontas para a carga.
do $chk$
declare
  v_restantes integer;
  v_sujas integer;
begin
  select count(*) into v_restantes
    from private.pca_plano_fila
   where ano = 2026
     and status = 'erro'
     and tentativas >= 5
     and atualizado_em < timestamptz '2026-11-11 00:00:00+00'
     and (erro like '%erro(s) na gravação em lote%'
       or erro like '%classificacaoSuperiorCodigo%'
       or erro like '%HTTP 503%');
  if v_restantes > 0 then
    raise exception 'pca_fila_reabrir_esgotados_0056_check (RESTO): % linha(s) esgotada(s) antes de 11/11 em erro',
      v_restantes;
  end if;

  select count(*) into v_sujas
    from private.pca_plano_fila
   where chain_id = '00560000-0000-4000-8000-000000000056'::uuid
     and status = 'pendente'
     and (tentativas <> 0 or disponivel_em is not null or reserva_token is not null
       or erro is null or erro not like 'reaberto 0056; antes: %');
  if v_sujas > 0 then
    raise exception 'pca_fila_reabrir_esgotados_0056_check (EFEITO): % linha(s) reaberta(s) sem os campos zerados',
      v_sujas;
  end if;

  raise notice 'SUCESSO pca_fila_reabrir_esgotados_0056_check: corte reaberto e linhas prontas para a carga';
end;
$chk$;
