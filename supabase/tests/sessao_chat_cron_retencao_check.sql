-- Checagem da spec 0039, etapa 1 (migration 20261108130000_sessao_chat_cron_retencao.sql).
-- Falha com EXCEPTION se:
--   - private.integra_compras_run não tiver licitacao_id;
--   - anon, authenticated ou service_role puderem executar private.sessao_mensagens_retencao();
--   - CA-8: a retenção não marcar expira_em = homologação + 90 dias, não apagar o texto vencido, apagar a linha
--     (a contagem tem que continuar igual), apagar texto ainda no prazo ou marcar compra sem homologação;
--   - K-3: private.sessao_chat_alvos() trouxer licitação fora do pipeline, de empresa inativa, em etapa perdida ou
--     descartada, homologada ou fora da janela de data_fim, ou deixar de trazer a que está em etapa sem desfecho ou
--     vencida; ou anon/authenticated puderem executá-la, ou service_role não puder;
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
  v_t bigint;
  v_t_inativo bigint;
  v_nova bigint;
  v_perdida bigint;
  v_descartada bigint;
  v_vencida bigint;
  v_l bigint[] := array[]::bigint[];
  v_id bigint;
  v_alvos bigint[];
  i int;
  v_u uuid := gen_random_uuid();
  v_runs_antes text;
  v_lic_outra bigint;
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


  -- K-3: alvos da coleta agendada.
  foreach v_papel in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_papel, 'private.sessao_chat_alvos(timestamptz)', 'EXECUTE') then
      v_falhas := v_falhas || format('%s pode executar private.sessao_chat_alvos', v_papel);
    end if;
  end loop;
  if not has_function_privilege('service_role', 'private.sessao_chat_alvos(timestamptz)', 'EXECUTE') then
    v_falhas := v_falhas || 'service_role não pode executar private.sessao_chat_alvos'::text;
  end if;

  insert into auth.users (id, email) values (v_u, 'check-0039@example.invalid') on conflict (id) do nothing;
  insert into public.tenants (slug, nome, ativo) values ('chk-0039-ativo', 'Check 0039 ativo', true) returning id into v_t;
  insert into public.tenants (slug, nome, ativo) values ('chk-0039-inativo', 'Check 0039 inativo', false)
  returning id into v_t_inativo;
  select id into v_nova from public.pipeline_etapas where tenant_id = v_t and desfecho is null order by ordem limit 1;
  select id into v_perdida from public.pipeline_etapas where tenant_id = v_t and desfecho = 'perdida' limit 1;
  select id into v_descartada from public.pipeline_etapas where tenant_id = v_t and desfecho = 'descartada' limit 1;
  select id into v_vencida from public.pipeline_etapas where tenant_id = v_t and desfecho = 'vencida' limit 1;
  if v_nova is null or v_perdida is null or v_descartada is null or v_vencida is null then
    raise exception 'sessao_chat_cron_retencao_check: etapas padrão do tenant de teste não encontradas';
  end if;

  -- 1..8: 1 entra (sem desfecho), 2 entra (vencida), 3 perdida, 4 descartada, 5 empresa inativa, 6 homologada,
  -- 7 data_fim fora da janela, 8 fora do pipeline.
  for i in 1..8 loop
    insert into public.licitacoes_externas (fonte, data_fim, data_homologacao)
    values ('pncp',
            case when i = 7 then now() - interval '40 days' else now() - interval '1 day' end,
            case when i = 6 then now() - interval '1 hour' end)
    returning id into v_id;
    v_l := v_l || v_id;
  end loop;
  insert into public.pipeline_oportunidades (tenant_id, licitacao_id, etapa_id, adicionada_por, atualizada_por) values
    (v_t, v_l[1], v_nova, v_u, v_u), (v_t, v_l[2], v_vencida, v_u, v_u), (v_t, v_l[3], v_perdida, v_u, v_u),
    (v_t, v_l[4], v_descartada, v_u, v_u), (v_t, v_l[6], v_nova, v_u, v_u), (v_t, v_l[7], v_nova, v_u, v_u);
  insert into public.pipeline_oportunidades (tenant_id, licitacao_id, etapa_id, adicionada_por, atualizada_por)
  select v_t_inativo, v_l[5], e.id, v_u, v_u from public.pipeline_etapas e
   where e.tenant_id = v_t_inativo and e.desfecho is null order by e.ordem limit 1;

  select array_agg(a.licitacao_id order by a.licitacao_id) into v_alvos
    from private.sessao_chat_alvos(now()) a where a.licitacao_id = any (v_l);
  if v_alvos is distinct from array[v_l[1], v_l[2]] then
    v_falhas := v_falhas || format('sessao_chat_alvos trouxe %s; esperado só %s', v_alvos, array[v_l[1], v_l[2]]);
  end if;

  -- Três compras: homologada há 100 dias (vence), homologada há 10 dias (no prazo), sem homologação.
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', now() - interval '100 days')
  returning id into v_lic_vencida;
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', now() - interval '10 days')
  returning id into v_lic_no_prazo;
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', null)
  returning id into v_lic_sem_homolog;
  insert into public.licitacoes_externas (fonte, data_homologacao) values ('pncp', now() - interval '5 days')
  returning id into v_lic_outra;
  insert into private.integra_compras_run (chave_compra, origem, licitacao_id) values
    ('99998803000012026', 'cron', v_lic_outra), -- mesma compra, homologação posterior: vale a menor
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

  select string_agg(format('%s|%s|%s|%s', id, chamadas, mensagens_lidas, mensagens_novas), ',' order by id)
    into v_runs_antes from private.integra_compras_run where chave_compra like '999988030000_2026';

  v_ret := private.sessao_mensagens_retencao();

  if v_runs_antes is distinct from (
    select string_agg(format('%s|%s|%s|%s', id, chamadas, mensagens_lidas, mensagens_novas), ',' order by id)
      from private.integra_compras_run where chave_compra like '999988030000_2026'
  ) then
    v_falhas := v_falhas || 'retenção mudou o registro de execução (K-2)'::text;
  end if;

  select count(*) into v_n from public.sessao_mensagens where chave_compra like '999988030000_2026';
  if v_n <> 4 then
    v_falhas := v_falhas || format('retenção apagou linha: restaram %s de 4', v_n);
  end if;

  for v_r in
    select m.chave_compra, m.texto, m.expira_em, l.data_homologacao
      from public.sessao_mensagens m
      join lateral (
        select min(l.data_homologacao) as data_homologacao
          from private.integra_compras_run r
          join public.licitacoes_externas l on l.id = r.licitacao_id
         where r.chave_compra = m.chave_compra
      ) l on true
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
  if v_n <> 2 or (v_ret->>'marcadas')::int <> 0 or (v_ret->>'textos_apagados')::int <> 0 then
    v_falhas := v_falhas || format('segunda execução mudou o resultado: %s textos nulos, retorno %s', v_n, v_ret);
  end if;

  -- Homologação desfeita na fonte: o prazo da compra ainda com texto some.
  update public.licitacoes_externas set data_homologacao = null where id = v_lic_no_prazo;
  perform private.sessao_mensagens_retencao();
  if exists (select 1 from public.sessao_mensagens where chave_compra = '99998803000022026' and expira_em is not null) then
    v_falhas := v_falhas || 'expira_em ficou depois que a homologação foi desfeita'::text;
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
