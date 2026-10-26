-- #289: pausa recuperável não deve monopolizar o início FIFO.
-- Esta migration do PR ainda está em revisão. Mesma versão preserva erro, recuo e tentativas;
-- só uma data oficial estritamente maior, fora de processamento vivo, inicia outro ciclo.
begin;
set local lock_timeout = '10s';

alter table private.pca_plano_fila
  add column if not exists disponivel_em timestamptz;

create or replace function private.pca_fila_reservar(
  p_limite integer, p_max_tentativas integer default 5, p_ano integer default null
)
returns setof private.pca_plano_fila
language sql
set search_path to ''
as $function$
  update private.pca_plano_fila f
     set status = 'processando',
         tentativas = f.tentativas + case when f.status = 'processando' then 1 else 0 end,
         atualizado_em = now(),
         disponivel_em = null
   where f.id in (
     select g.id
       from private.pca_plano_fila g
      where (p_ano is null or g.ano = p_ano)
        and g.tentativas < p_max_tentativas
        and (g.disponivel_em is null or g.disponivel_em <= now())
        and (g.status = 'pendente'
         or (g.status = 'erro' and g.tentativas < p_max_tentativas
             and g.atualizado_em < now() - interval '10 minutes')
         or (g.status = 'processando' and g.tentativas < p_max_tentativas
             and g.atualizado_em < now() - interval '15 minutes'))
      order by g.criado_em, g.id
      limit greatest(p_limite, 0)
      for update skip locked
   )
  returning f.*;
$function$;

-- Redescoberta não é tentativa e não renova o relógio de erro/abandono.
-- Não promove a versão enquanto há worker vivo: ele ainda está carregando o cabeçalho anterior.
create or replace function private.pca_fila_enfileirar(p_itens jsonb)
returns integer
language plpgsql
set search_path to ''
as $function$
declare v_total integer;
begin
  insert into private.pca_plano_fila as f
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, plano, classes, data_atualizacao_fonte, chain_id)
  select x.id_pca_pncp, x.orgao_cnpj, x.ano, x.sequencial, x.motivo, x.plano,
         coalesce(x.classes, array['7830']::text[]), x.data_atualizacao_fonte, x.chain_id
    from jsonb_to_recordset(coalesce(p_itens, '[]'::jsonb)) as x(
      id_pca_pncp text, orgao_cnpj text, ano integer, sequencial integer, motivo text,
      plano jsonb, classes text[], data_atualizacao_fonte timestamptz, chain_id uuid)
  on conflict (id_pca_pncp) where status in ('pendente', 'processando', 'erro')
  do update set
    plano = case
      when f.status = 'processando' and f.atualizado_em >= now() - interval '15 minutes' then f.plano
      when f.data_atualizacao_fonte is not null and
           (excluded.data_atualizacao_fonte is null or excluded.data_atualizacao_fonte < f.data_atualizacao_fonte)
        then f.plano
      else coalesce(excluded.plano, f.plano) end,
    classes = (select array_agg(distinct c order by c) from unnest(f.classes || excluded.classes) c),
    data_atualizacao_fonte = case
      when f.status = 'processando' and f.atualizado_em >= now() - interval '15 minutes'
        then f.data_atualizacao_fonte
      else greatest(excluded.data_atualizacao_fonte, f.data_atualizacao_fonte) end,
    motivo = case when excluded.motivo = 'ausente' and f.plano is not null then f.motivo else excluded.motivo end,
    chain_id = excluded.chain_id,
    status = case when excluded.data_atualizacao_fonte > f.data_atualizacao_fonte
                       and (f.status <> 'processando' or f.atualizado_em < now() - interval '15 minutes')
                  then 'pendente' else f.status end,
    tentativas = case when excluded.data_atualizacao_fonte > f.data_atualizacao_fonte
                           and (f.status <> 'processando' or f.atualizado_em < now() - interval '15 minutes')
                      then 0 else f.tentativas end,
    erro = case when excluded.data_atualizacao_fonte > f.data_atualizacao_fonte
                     and (f.status <> 'processando' or f.atualizado_em < now() - interval '15 minutes')
                then null else f.erro end,
    atualizado_em = case when excluded.data_atualizacao_fonte > f.data_atualizacao_fonte
                               and (f.status <> 'processando' or f.atualizado_em < now() - interval '15 minutes')
                          then now() else f.atualizado_em end;
  get diagnostics v_total = row_count;
  return v_total;
end
$function$;

commit;
