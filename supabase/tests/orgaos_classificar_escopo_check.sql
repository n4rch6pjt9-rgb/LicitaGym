-- Classificação de órgãos/UASGs sobrevive a uma falha do refresh, e o match novo
-- coincide com fn_escopo_item / fn_escopo_pca (a regra de antes).
-- Dados fictícios. begin ... rollback: nada persiste.
-- Trava: aborta se licitacoes_externas tiver mais de 100 linhas (produção).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/orgaos_classificar_escopo_check.sql

begin;

do $$
declare
  v_qtd int;
  v_acl int;
  v_falha text;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.escopo_item_calc')) then
    raise exception 'FALHA DO TESTE: escopo_item_calc sem RLS';
  end if;
  select count(*) into v_acl
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name = 'escopo_item_calc'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC', 'service_role');
  if v_acl <> 0 then
    raise exception 'FALHA DO TESTE: escopo_item_calc tem grant para role de API (%)', v_acl;
  end if;
  if has_function_privilege('anon', 'public.fn_escopo_calc_sincronizar()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_escopo_calc_sincronizar()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.fn_escopo_calc_sincronizar()', 'EXECUTE')
     or has_function_privilege('public', 'public.fn_escopo_calc_sincronizar()', 'EXECUTE')
     or has_function_privilege('anon', 'public.fn_escopo_match_atualizar()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.fn_orgaos_uasgs_classificar()', 'EXECUTE') then
    raise exception 'FALHA DO TESTE: EXECUTE indevido em função de classificação ou de escopo';
  end if;
  if to_regnamespace('cron') is not null then
    if exists (select 1 from cron.job where jobname = 'licitagym-orgaos-classificar-escopo') then
      raise exception 'FALHA DO TESTE: o job combinado ainda está agendado';
    end if;
    if (select count(*) from cron.job
         where jobname = 'licitagym-orgaos-classificar' and schedule = '3 8 * * *'
           and command = $c$set local statement_timeout = '10min'; select public.fn_orgaos_uasgs_classificar();$c$) <> 1
       or (select count(*) from cron.job
            where jobname = 'licitagym-escopo-match' and schedule = '18 8 * * *'
              and command = $c$set local statement_timeout = '10min'; select public.fn_escopo_match_atualizar();$c$) <> 1
       or position('fn_escopo_match_atualizar' in (select command from cron.job where jobname = 'licitagym-orgaos-classificar')) > 0
       or position('fn_orgaos_uasgs_classificar' in (select command from cron.job where jobname = 'licitagym-escopo-match')) > 0 then
      select string_agg(jobname || '=' || command, ' || ' order by jobname) into v_falha
        from cron.job
       where jobname in ('licitagym-orgaos-classificar', 'licitagym-escopo-match');
      raise exception 'FALHA DO TESTE: agenda dos jobs separada diferente do esperado (%).', v_falha;
    end if;
  end if;
end $$;

create temp table _escopo_oracle (like public.mv_escopo_demanda) on commit drop;

do $$
declare
  v_org_a uuid;
  v_org_e uuid;
  v_lic bigint;
  v_item_fixo bigint;
  v_item_muda bigint;
  v_ctid tid;
  v_tipo text;
  v_em timestamptz;
  v_diff int;
  v_nivel text;
  v_familia text;
  v_calc text;
begin
  insert into public.orgaos (codigo_orgao, nome_orgao, cnpj, esfera, compras_raw, compras_payload_hash, ativo)
  values
    (980001, 'PREFEITURA MUNICIPAL DE CIDADE FICTICIA', '00000000009801', 'M', '{}'::jsonb, 'h980001', true),
    (980002, 'XYZ QWERTY FICTICIO', '00000000009802', 'E', '{}'::jsonb, 'h980002', true),
    (980003, 'CAMARA MUNICIPAL DE CIDADE FICTICIA', '00000000009803', 'M', '{}'::jsonb, 'h980003', true),
    (980004, 'UNIVERSIDADE FEDERAL FICTICIA', '00000000009804', 'F', '{}'::jsonb, 'h980004', true),
    (980005, 'ORGAO SEM ESCOPO FICTICIO', '00000000009805', 'M', '{}'::jsonb, 'h980005', true);
  select id into v_org_a from public.orgaos where codigo_orgao = 980001;
  select id into v_org_e from public.orgaos where codigo_orgao = 980005;

  insert into public.uasgs (codigo_uasg, nome_uasg, sigla_uf, codigo_municipio_ibge, codigo_orgao, orgao_id,
                            cnpj_cpf_orgao, raw, payload_hash, ativo)
  select u.codigo, u.nome, u.uf, u.ibge, u.cod, o.id, o.cnpj, '{}'::jsonb, 'uh-' || u.codigo, true
    from (values
      ('980001', 'UNIDADE FICTICIA DA PREFEITURA', 'SP', 3550308, 980001),
      ('980002', 'UNIDADE FICTICIA ADJACENTE', 'RJ', 3304557, 980002),
      ('980003', 'UNIDADE FICTICIA DA CAMARA', 'MG', 3106200, 980003)
    ) as u(codigo, nome, uf, ibge, cod)
    join public.orgaos o on o.codigo_orgao = u.cod;

  insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, data_publicacao, raw)
  values ('pncp', 'fx-escopo-980001', '00000000009801', 'PREFEITURA FICTICIA', '2026-09-01 12:00+00',
          jsonb_build_object('unidade_codigo', '980001'))
  returning id into v_lic;
  insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado)
  values
    (v_lic, 1, 'ANILHA DE FERRO 10 KG PARA MUSCULACAO', 10),
    (v_lic, 2, 'PAPEL A4 BRANCO', 1),
    (v_lic, 3, 'despertador com anilha de ferro', 5),
    (v_lic, 4, '<p>Halter sextavado</p> 5kg', 20),
    (v_lic, 5, 'GRAMA SINTETICA 12 MM', 30);
  insert into public.licitacao_resultados (licitacao_id, numero_item, valor_total_homologado, data_resultado)
  values (v_lic, 1, 100, '2026-09-15 12:00+00');
  select i.id into v_item_muda
    from public.licitacao_itens i where i.licitacao_id = v_lic and i.numero_item = 1;

  insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, data_publicacao, raw)
  values ('pncp', 'fx-escopo-980002', '00000000009802', '2026-09-02 12:00+00',
          jsonb_build_object('unidade_codigo', '980002'))
  returning id into v_lic;
  insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado)
  values (v_lic, 1, 'GRAMA SINTETICA 12 MM', 40);
  insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado)
  values (v_lic, 2, '', 0)
  returning id into v_item_fixo;

  insert into public.contratacoes_editais
    (orgao_cnpj, ano, sequencial, objeto, descricao, valor_estimado, data_publicacao, payload_hash)
  values ('00000000009804', 2026, 980004, 'PISO EMBORRACHADO PARA QUADRA', 'fornecimento', 500,
          '2026-08-01 12:00+00', 'ed980004');

  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, unidade_codigo, payload_hash, data_publicacao)
  values ('fx-pca-980003', 2026, '00000000009803', '980003', 'pca980003', '2026-07-01');
  insert into public.pca_itens (pca_plano_id, numero_item, descricao, valor_total_estimado, payload_hash, codigo_classe_catmat, ativo)
  select p.id, x.n, x.descricao, x.valor, x.hash, 7830, true
    from public.pca_planos p
    cross join (values
      (1, 'BANCO SUPINO REGULAVEL', 80::numeric, 'pi1'),
      (2, 'PLAYGROUND INFANTIL', 15, 'pi2'),
      (3, '', 7, 'pi3')) as x(n, descricao, valor, hash)
   where p.id_pca_pncp = 'fx-pca-980003';

  perform public.fn_orgaos_uasgs_classificar();
  select o.tipo_orgao, o.classificado_em into v_tipo, v_em
    from public.orgaos o where o.id = v_org_a;
  if v_tipo is distinct from 'prefeitura' or v_em is null
     or (select match_nivel from public.orgaos where id = v_org_a) is not null then
    raise exception 'FALHA DO TESTE: classificação inicial inesperada (%, %)', v_tipo, v_em;
  end if;
  if (select tipo_orgao from public.orgaos where id = v_org_e) is null
     or (select classificado_em from public.uasgs where codigo_uasg = '980001') is null then
    raise exception 'FALHA DO TESTE: órgão sem escopo ou UASG ficou sem classificado_em';
  end if;

  -- Falha do refresh numa subtransação: a classificação de fora permanece.
  begin
    alter table public.licitacao_itens rename column descricao to descricao_escopo_off;
    perform public.fn_escopo_match_atualizar();
    raise exception 'FALHA DO TESTE: o refresh deveria ter falhado sem a coluna descricao';
  exception
    when others then
      if sqlerrm like 'FALHA DO TESTE:%' then
        raise;
      end if;
  end;

  if (select tipo_orgao from public.orgaos where id = v_org_a) is distinct from v_tipo
     or (select classificado_em from public.orgaos where id = v_org_a) is distinct from v_em
     or (select match_nivel from public.orgaos where id = v_org_a) is not null
     or (select classificado_em from public.uasgs where codigo_uasg = '980001') is null
     or exists (
       select 1 from pg_attribute a
        where a.attrelid = 'public.licitacao_itens'::regclass
          and a.attname = 'descricao_escopo_off' and not a.attisdropped) then
    raise exception 'FALHA DO TESTE: a falha do refresh desfez a classificação ou deixou o rename';
  end if;

  perform public.fn_escopo_match_atualizar();

  insert into _escopo_oracle
  with it as (
    select l.id as licitacao_id, l.orgao_cnpj,
           case when l.raw->>'unidade_codigo' ~ '^\d{6}$' then l.raw->>'unidade_codigo' end as unidade_codigo,
           coalesce(l.data_publicacao, l.data_inicio) as data_pub,
           i.valor_total_estimado, e.nivel,
           r.homologado, r.data_res
      from public.licitacoes_externas l
      join public.licitacao_itens i on i.licitacao_id = l.id
      cross join lateral public.fn_escopo_item(i.descricao) e
      left join lateral (
        select sum(x.valor_total_homologado) as homologado, max(x.data_resultado) as data_res
          from public.licitacao_resultados x
         where x.licitacao_id = i.licitacao_id and x.numero_item = i.numero_item) r on true
     where e.nivel is not null and l.orgao_cnpj ~ '^\d{14}$'
       and l.codigo_externo like 'fx-escopo-%'
  ), ed as (
    select c.orgao_cnpj, null::text as unidade_codigo, c.valor_estimado, c.data_publicacao, e.nivel
      from public.contratacoes_editais c
      cross join lateral public.fn_escopo_item(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, '')) e
     where e.nivel is not null and c.orgao_cnpj ~ '^\d{14}$' and c.payload_hash = 'ed980004'
  ), pca as (
    select p.orgao_cnpj, p.unidade_codigo, i.valor_total_estimado, p.data_publicacao,
           public.fn_escopo_pca(i.descricao) as k
      from public.pca_itens i
      join public.pca_planos p on p.id = i.pca_plano_id
     where i.codigo_classe_catmat = 7830 and coalesce(i.ativo, true) and coalesce(p.ativo, true)
       and p.id_pca_pncp = 'fx-pca-980003'
  )
  select orgao_cnpj, unidade_codigo, 'licitacao'::text,
         count(distinct licitacao_id) filter (where nivel = 'nucleo'),
         count(distinct licitacao_id),
         count(*) filter (where nivel = 'nucleo'),
         count(*) filter (where nivel = 'adjacente'),
         sum(valor_total_estimado), sum(homologado), max(data_pub), max(data_res)
    from it group by orgao_cnpj, unidade_codigo
  union all
  select orgao_cnpj, unidade_codigo, 'edital',
         count(*) filter (where nivel = 'nucleo'), count(*),
         null::bigint, null::bigint, sum(valor_estimado), null::numeric, max(data_publicacao), null::timestamptz
    from ed group by orgao_cnpj, unidade_codigo
  union all
  select orgao_cnpj, unidade_codigo, 'pca',
         null::bigint, null::bigint,
         count(*) filter (where k in ('escopo', 'vazio')), null::bigint,
         sum(valor_total_estimado) filter (where k in ('escopo', 'vazio')), null::numeric,
         max(data_publicacao)::timestamptz, null::timestamptz
    from pca group by orgao_cnpj, unidade_codigo
  having count(*) filter (where k in ('escopo', 'vazio')) > 0;

  select count(*) into v_diff
    from (
      select * from _escopo_oracle
      except
      select d.* from public.mv_escopo_demanda d
       where d.orgao_cnpj in ('00000000009801', '00000000009802', '00000000009803', '00000000009804')
      union all
      select d.* from public.mv_escopo_demanda d
       where d.orgao_cnpj in ('00000000009801', '00000000009802', '00000000009803', '00000000009804')
      except
      select * from _escopo_oracle
    ) x;
  if v_diff <> 0 then
    raise exception 'FALHA DO TESTE: mv_escopo_demanda difere do agregado por fn_escopo_item (% linhas)', v_diff;
  end if;

  if (select match_nivel from public.orgaos where codigo_orgao = 980001) is distinct from 'comprou'
     or (select match_nivel from public.orgaos where codigo_orgao = 980002) is distinct from 'adjacente'
     or (select match_nivel from public.orgaos where codigo_orgao = 980003) is distinct from 'planeja'
     or (select match_nivel from public.orgaos where codigo_orgao = 980004) is distinct from 'comprou'
     or (select match_nivel from public.orgaos where codigo_orgao = 980005) is not null
     or (select match_nivel from public.uasgs where codigo_uasg = '980001') is distinct from 'comprou'
     or (select match_nivel from public.uasgs where codigo_uasg = '980002') is distinct from 'adjacente'
     or (select match_nivel from public.uasgs where codigo_uasg = '980003') is distinct from 'planeja' then
    raise exception 'FALHA DO TESTE: match_nivel diferente da regra comprou > planeja > adjacente';
  end if;

  select (e.nivel || '/' || e.familia) into v_calc
    from public.fn_escopo_item('ANILHA DE FERRO 10 KG PARA MUSCULACAO') e;
  select c.nivel || '/' || c.familia into v_nivel
    from public.escopo_item_calc c
   where c.origem = 'licitacao_item' and c.origem_id = v_item_muda::text;
  if v_nivel is distinct from v_calc then
    raise exception 'FALHA DO TESTE: cache da anilha % <> fn_escopo_item %', v_nivel, v_calc;
  end if;
  if exists (
    select 1 from public.escopo_item_calc c
     where c.origem = 'licitacao_item'
       and c.origem_id = (select i.id::text from public.licitacao_itens i
                           join public.licitacoes_externas l on l.id = i.licitacao_id
                          where l.codigo_externo = 'fx-escopo-980001' and i.numero_item = 3)
       and c.nivel is not null) then
    raise exception 'FALHA DO TESTE: exclusão não venceu a anilha no despertador';
  end if;

  select c.ctid into v_ctid
    from public.escopo_item_calc c
   where c.origem = 'licitacao_item' and c.origem_id = v_item_fixo::text;
  update public.licitacao_itens set descricao = 'PAPEL A4 BRANCO' where id = v_item_muda;
  perform public.fn_escopo_calc_sincronizar();
  if (select c.ctid from public.escopo_item_calc c
       where c.origem = 'licitacao_item' and c.origem_id = v_item_fixo::text) is distinct from v_ctid then
    raise exception 'FALHA DO TESTE: item cujo texto não mudou foi regravado no cache';
  end if;
  select c.nivel into v_nivel
    from public.escopo_item_calc c
   where c.origem = 'licitacao_item' and c.origem_id = v_item_muda::text;
  select e.nivel into v_familia from public.fn_escopo_item('PAPEL A4 BRANCO') e;
  if v_nivel is distinct from v_familia then
    raise exception 'FALHA DO TESTE: item alterado ficou com nível % e a função devolve %', v_nivel, v_familia;
  end if;

  raise notice 'SUCESSO: orgaos_classificar_escopo_check';
end $$;

rollback;
