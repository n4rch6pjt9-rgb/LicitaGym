-- Checagem da spec 0039, etapa 1 (migration 20261108130000_sessao_chat_cron_retencao.sql).
-- Falha com EXCEPTION se:
--   - private.integra_compras_run não tiver licitacao_id;
--   - anon, authenticated ou service_role puderem executar private.sessao_mensagens_retencao();
--   - CA-8: a retenção não marcar expira_em = homologação + 90 dias, não apagar o texto vencido, apagar a linha
--     (a contagem tem que continuar igual), apagar texto ainda no prazo ou marcar compra sem homologação;
--   - com pg_cron: os jobs licitagym-sync-sessao-chat e licitagym-sessao-retencao não existirem.
-- Fixtures com a compra de demonstração do Serpro; tudo termina em rollback.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_papel text;
  v_n int;
  v_r record;
  v_ret jsonb;
  v_lic_vencida bigint;
  v_lic_no_prazo bigint;
  v_lic_sem_homolog bigint;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'private' and table_name = 'integra_compras_run' and column_name = 'licitacao_id'
  ) then
    v_falhas := v_falhas || 'private.integra_compras_run sem licitacao_id'::text;
  end if;

  if to_regprocedure('private.sessao_mensagens_retencao()') is null then
    raise exception 'sessao_chat_cron_retencao_check: função private.sessao_mensagens_retencao() não existe';
  end if;
  foreach v_papel in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_papel, 'private.sessao_mensagens_retencao()', 'EXECUTE') then
      v_falhas := v_falhas || format('%s pode executar private.sessao_mensagens_retencao()', v_papel);
    end if;
  end loop;

  -- Três compras: homologada há 100 dias (vence), homologada há 10 dias (no prazo), sem homologação.
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', now() - interval '100 days')
  returning id into v_lic_vencida;
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', now() - interval '10 days')
  returning id into v_lic_no_prazo;
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', null)
  returning id into v_lic_sem_homolog;
  insert into private.integra_compras_run (chave_compra, origem, licitacao_id) values
    ('99998803000012026', 'cron', v_lic_vencida),
    ('99998803000022026', 'cron', v_lic_no_prazo),
    ('99998803000032026', 'cron', v_lic_sem_homolog);
  insert into public.sessao_mensagens
    (chave_compra, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
  values
    ('99998803000012026', gen_random_uuid(), 'mensagem', '11', '0', 'vencida 1', now() - interval '120 days', 'x'),
    ('99998803000012026', gen_random_uuid(), 'diligencia', null, null, 'vencida 2', now() - interval '120 days', 'x'),
    ('99998803000022026', gen_random_uuid(), 'mensagem', '2', '0', 'no prazo', now() - interval '20 days', 'x'),
    ('99998803000032026', gen_random_uuid(), 'mensagem', '2', '0', 'sem homologação', now(), 'x');

  v_ret := private.sessao_mensagens_retencao();

  select count(*) into v_n from public.sessao_mensagens where chave_compra like '999988030000_2026';
  if v_n <> 4 then
    v_falhas := v_falhas || format('retenção apagou linha: restaram %s de 4', v_n);
  end if;

  for v_r in
    select m.chave_compra, m.texto, m.expira_em, l.data_homologacao
      from public.sessao_mensagens m
      join private.integra_compras_run r on r.chave_compra = m.chave_compra
      left join public.licitacoes_externas l on l.id = r.licitacao_id
     where m.chave_compra like '999988030000_2026'
  loop
    if v_r.chave_compra = '99998803000012026' then
      if v_r.texto is not null then
        v_falhas := v_falhas || 'texto vencido (homologação + 90 dias no passado) não foi apagado'::text;
      end if;
      if v_r.expira_em is distinct from v_r.data_homologacao + interval '90 days' then
        v_falhas := v_falhas || format('expira_em %s diferente de homologação + 90 dias', v_r.expira_em);
      end if;
    elsif v_r.chave_compra = '99998803000022026' then
      if v_r.texto is null then
        v_falhas := v_falhas || 'texto ainda no prazo foi apagado'::text;
      end if;
      if v_r.expira_em is distinct from v_r.data_homologacao + interval '90 days' then
        v_falhas := v_falhas || 'expira_em não marcado na compra no prazo'::text;
      end if;
    elsif v_r.expira_em is not null or v_r.texto is null then
      v_falhas := v_falhas || 'compra sem homologação foi marcada ou apagada'::text;
    end if;
  end loop;

  if (v_ret->>'textos_apagados')::int < 2 then
    v_falhas := v_falhas || format('retorno da retenção sem os 2 textos apagados: %s', v_ret);
  end if;

  -- Reaplicar não muda nada (idempotente).
  v_ret := private.sessao_mensagens_retencao();
  select count(*) into v_n from public.sessao_mensagens
   where chave_compra like '999988030000_2026' and texto is null;
  if v_n <> 2 then
    v_falhas := v_falhas || format('segunda execução mudou o resultado: %s textos nulos', v_n);
  end if;

  if to_regclass('cron.job') is not null then
    for v_r in
      select t.nome from (values ('licitagym-sync-sessao-chat'), ('licitagym-sessao-retencao')) as t(nome)
       where not exists (select 1 from cron.job c where c.jobname = t.nome)
    loop
      v_falhas := v_falhas || format('job %s ausente', v_r.nome);
    end loop;
  else
    raise notice 'sessao_chat_cron_retencao_check: sem pg_cron, checagem dos jobs pulada';
  end if;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'ACL CHECK FALHOU (sessao_chat_cron_retencao): %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: sessao_chat_cron_retencao_check';
end
$chk$;

rollback;
