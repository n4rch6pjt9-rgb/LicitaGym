-- Spec 0063: verificações de saúde da coleta externa.
--   CA-5 (K-3): coleta_externa_executando_horas = horas da execução 'executando' mais antiga (0 sem nenhuma), com a
--         fonte no detalhe; limiares atenção 2 h, crítico 7 h;
--   CA-9 (K-7): coleta_externa_dias_sem_sucesso cobra toda fonte ativa; fonte ativa sem conclusão = crítico, com o
--         slug no detalhe; com ela inativa, volta a ok.
-- Fixtures revertidas ao final.
begin;

do $$
declare
  r record;
begin
  -- isola: nenhuma execução e nenhuma fonte ativa além das do teste
  delete from private.coleta_externa_run;
  update public.fontes_externas set ativo = false;

  -- CA-5: sem execução em andamento -> 0 e ok
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_executando_horas';
  if r.verificacao is null then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-5: verificação coleta_externa_executando_horas ausente';
  end if;
  if r.valor is distinct from 0 or r.status <> 'ok' then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-5: sem execução devia ser 0/ok, veio %/%', r.valor, r.status;
  end if;
  if r.atencao <> 2 or r.critico <> 7 then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-5: limiares esperados 2/7, vieram %/%', r.atencao, r.critico;
  end if;

  -- CA-5: execução presa há 7 h -> crítico, com a fonte no detalhe
  insert into private.coleta_externa_run (fonte, modo, status, started_at)
  values ('fiesc', 'leads', 'executando', now() - interval '7 hours 5 minutes');
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_executando_horas';
  if r.valor < 7 or r.status <> 'critico' or r.detalhe::text not like '%fiesc%' then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-5: 7 h devia ser crítico com fiesc no detalhe: % % %',
      r.valor, r.status, r.detalhe;
  end if;

  -- CA-5: 3 h -> atenção
  update private.coleta_externa_run set started_at = now() - interval '3 hours' where fonte = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_executando_horas';
  if r.status <> 'atencao' then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-5: 3 h devia ser atenção, veio % (%)', r.status, r.valor;
  end if;

  -- CA-9: fiesc ativa sem nenhuma conclusão, firjan ativa concluída há 1 dia -> crítico com fiesc no detalhe
  update public.fontes_externas set ativo = true where slug in ('fiesc', 'firjan');
  insert into private.coleta_externa_run (fonte, modo, status, started_at, finished_at)
  values ('firjan', 'leads', 'concluida', now() - interval '25 hours', now() - interval '1 day');
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_dias_sem_sucesso';
  if r.status <> 'critico' or r.detalhe::text not like '%fiesc%' then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-9: fonte ativa sem conclusão devia ser crítico com o slug: % %',
      r.status, r.detalhe;
  end if;

  -- CA-9: fiesc inativa -> só a firjan conta (1 dia) -> ok
  update public.fontes_externas set ativo = false where slug = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_dias_sem_sucesso';
  if r.status <> 'ok' or r.valor is distinct from 1.0 then
    raise exception 'SAUDE COLETA CHECK FALHOU: CA-9: só firjan (1 dia) devia ser ok/1.0, veio %/%', r.status, r.valor;
  end if;

  raise notice 'SUCESSO: saude_coleta_externa_executando_check (CA-5, CA-9)';
end $$;

rollback;
