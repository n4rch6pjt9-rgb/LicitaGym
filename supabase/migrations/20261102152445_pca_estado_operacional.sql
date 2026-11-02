-- Resumo de leitura para api-syncs; dados privados acessiveis somente ao service_role.
begin;

create or replace function public.pca_estado_operacional(p_ano integer)
returns jsonb language plpgsql stable security invoker set search_path = ''
as $fn$
declare resultado jsonb;
begin
  if p_ano is null or p_ano < 1900 or p_ano > 2100 then
    raise exception 'Ano PCA invalido' using errcode = '22023';
  end if;

  with fila as (
    select count(*) as total,
      count(*) filter (where status = 'pendente' and tentativas < 5) as pendentes,
      count(*) filter (where status = 'processando' and tentativas < 5) as processando,
      count(*) filter (where status = 'erro' and tentativas < 5) as erros_nao_esgotados,
      count(*) filter (where status in ('pendente','processando','erro') and tentativas >= 5) as esgotados,
      count(*) filter (where status = 'feito') as feitos,
      count(*) filter (where status in ('pendente','processando','erro') and tentativas < 5) as abertos,
      count(*) filter (where status = 'processando' and tentativas < 5
        and atualizado_em < statement_timestamp() - interval '15 minutes') as reservas_expiradas
    from private.pca_plano_fila where ano = p_ano
  ), execucoes as (
    select r.*,
      coalesce(r.last_heartbeat_at,r.iniciada_em) < statement_timestamp() - interval '15 minutes' as sem_heartbeat,
      jsonb_build_object(
        'sync_id',r.id, 'status',r.status,
        'rotina',coalesce(r.parametros #>> '{resumo,rotina}',r.parametros ->> 'rotina',r.modo),
        'iniciada_em',r.iniciada_em, 'finalizada_em',r.finalizada_em,
        'heartbeat_em',r.last_heartbeat_at,
        'tem_erro',r.erro_principal is not null or coalesce(r.total_erros,0) > 0,
        'contagens',jsonb_build_object(
          'recebidos',r.total_recebidos, 'novos',r.total_novos,
          'alterados',r.total_atualizados, 'inalterados',r.total_inalterados,
          'erros',r.total_erros,
          'planos_feitos',r.parametros #> '{resumo,carga,planos_feitos}',
          'planos_erro',r.parametros #> '{resumo,carga,planos_erro}',
          'itens_inativados',r.parametros #> '{resumo,carga,itens_inativados}',
          'planos_inativados',r.parametros #> '{resumo,carga,planos_inativados}'
        )
      ) as resumo
    from private.pncp_sync_run r
    where r.resource_type = 'pca'
      and (r.parametros ->> 'ano' = p_ano::text or r.lock_key = 'pca-fila:' || p_ano::text)
  )
  select jsonb_build_object(
    'ano',p_ano, 'observado_em',statement_timestamp(), 'fila',to_jsonb(fila),
    'execucoes_ativas',(select count(*) from execucoes where status = 'executando' and not sem_heartbeat),
    'execucoes_sem_heartbeat',(select count(*) from execucoes where status = 'executando' and sem_heartbeat),
    'ultima_execucao',(select resumo from execucoes order by iniciada_em desc,id desc limit 1),
    'ultimo_lote_sem_erros',(
      select resumo from execucoes
      where status in ('concluida','incompleta','retomada') and finalizada_em is not null
        and coalesce(total_erros,0) = 0 and erro_principal is null
        and parametros #>> '{resumo,carga,erros}' = '0'
        and parametros #>> '{resumo,carga,planos_feitos}' ~ '^[1-9][0-9]*$'
      order by finalizada_em desc,id desc limit 1
    )
  ) into resultado from fila;
  return resultado;
end;
$fn$;

revoke all on function public.pca_estado_operacional(integer) from public, anon, authenticated;
grant execute on function public.pca_estado_operacional(integer) to service_role;
comment on function public.pca_estado_operacional(integer) is
  'Leitura operacional PCA por ano. api-syncs exige administrador; nao altera fila nem dispara sync. Contagens nao sao progresso percentual.';

commit;
