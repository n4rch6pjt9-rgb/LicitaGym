-- Verificação da migration 20261002170000_licitacao_match_rpc_unica.
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacao_match_check.sql):
--   1. licitacao_match, licitacao_match_pendente e licitacao_match_estado com RLS; anon/authenticated sem nada;
--      service_role só SELECT (quem escreve são as funções SECURITY DEFINER);
--   2. RPCs e drenagem executáveis só por service_role; recálculo completo e carga só pelo owner; RPCs STABLE e
--      SECURITY INVOKER; recálculo/drenagem/carga/triggers SECURITY DEFINER com search_path fixo;
--   3. os 10 triggers de manutenção existem; recálculo, drenagem e carga pegam o mesmo advisory lock de
--      transação (20261002), o que serializa a drenagem com a edição de padrões;
--   4. com fixture (desfeita no fim):
--      a) sem carga (carregado_em null): triggers e drenagem inertes, nada gravado em licitacao_match, e a RPC
--         responde pelo caminho ao vivo (fallback) com o casamento certo;
--      b) depois de licitacao_match_carregar(): inserção, update, upsert (on conflict) e alteração de
--         padrão/exclusão mantêm licitacoes_ids_por_catmat igual ao casamento ao vivo, com pendência e drenado;
--   5. licitacoes_ids_por_catmat_unica devolve uma linha, ids distintos ordenados e os mesmos casamentos.
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_fn text;
  v_n int;
  v_pdm int;
  v_fonte text;
  v_l1 bigint;
  v_l2 bigint;
  v_i1 bigint;
  v_i2 bigint;
  v_i3 bigint;
  v_rest bigint;
  v_got text;
  v_exp text;
  v_ids bigint[];
  v_matches jsonb;
  v_priv text;
  v_role text;
begin
  -- 1
  foreach v_fn in array array['public.licitacao_match', 'public.licitacao_match_pendente', 'public.licitacao_match_estado'] loop
    if not (select relrowsecurity from pg_class where oid = v_fn::regclass) then
      raise exception '% sem RLS', v_fn;
    end if;
    if not has_table_privilege('service_role', v_fn, 'SELECT') then
      raise exception '%: service_role sem SELECT', v_fn;
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if (v_role <> 'service_role' or v_priv <> 'SELECT') and has_table_privilege(v_role, v_fn, v_priv) then
          raise exception '%: % não deveria ter % (só SELECT de service_role)', v_fn, v_role, v_priv;
        end if;
      end loop;
    end loop;
  end loop;

  -- 2
  foreach v_fn in array array[
    'public.licitacao_match_recalcular_pdms(int[])', 'public.licitacao_match_atualizar(int)',
    'public.licitacao_match_marcar_itens()', 'public.licitacao_match_marcar_objetos()',
    'public.licitacao_match_padroes_alterados()', 'public.licitacao_match_carregar()',
    'public.licitacoes_ids_por_catmat(int[],int[],int[],int[],boolean)',
    'public.licitacoes_ids_por_catmat_unica(int[],int[],int[],int[],boolean)'] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '%: EXECUTE não deveria ser de anon/authenticated', v_fn;
    end if;
    if (v_fn like '%atualizar%' or v_fn like '%ids_por_catmat%') <> has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '%: EXECUTE de service_role inesperado (só RPCs e drenagem)', v_fn;
    end if;
    if (select prosecdef from pg_proc where oid = v_fn::regprocedure) <> (v_fn not like '%ids_por_catmat%') then
      raise exception '%: SECURITY DEFINER/INVOKER inesperado', v_fn;
    end if;
    if not coalesce((select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where oid = v_fn::regprocedure), false) then
      raise exception '%: search_path deveria ser fixo (public, pg_temp)', v_fn;
    end if;
  end loop;
  if exists (select 1 from pg_proc where proname in ('licitacoes_ids_por_catmat', 'licitacoes_ids_por_catmat_unica')
              and pronamespace = 'public'::regnamespace and provolatile <> 's') then
    raise exception 'RPCs do recorte CATMAT deveriam ser STABLE';
  end if;

  -- 3
  select count(*) into v_n from pg_trigger
   where not tgisinternal and tgname like 'licitacao_match_%'
     and tgrelid in ('public.licitacao_itens'::regclass, 'public.licitacoes_externas'::regclass,
                     'public.catmat_pdm_palavras'::regclass, 'public.catmat_pdm_exclusoes'::regclass);
  if v_n <> 10 then raise exception 'esperados 10 triggers licitacao_match_*, há %', v_n; end if;

  -- 3b: cada função, num sub-bloco desfeito, deixa o advisory lock 20261002 com esta transação
  foreach v_fn in array array['select public.licitacao_match_recalcular_pdms(array[-1])',
                              'select public.licitacao_match_atualizar(1)',
                              'select public.licitacao_match_carregar()'] loop
    if exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
                and classid = 0 and objid = 20261002 and objsubid = 1) then
      raise exception 'advisory lock 20261002 já estava com a sessão antes de: %', v_fn;
    end if;
    begin
      execute v_fn;
      if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted
                      and mode = 'ExclusiveLock' and classid = 0 and objid = 20261002 and objsubid = 1) then
        raise exception 'sem o advisory lock 20261002 depois de: %', v_fn;
      end if;
      raise exception using errcode = 'LG002', message = 'desfaz';
    exception when sqlstate 'LG002' then
      null;
    end;
  end loop;

  -- 4 e 5: fixture num sub-bloco desfeito no fim (exceção LG001)
  begin
    -- parte do estado sem carga, como logo depois da migration em prod
    update public.licitacao_match_estado set carregado_em = null;
    delete from public.licitacao_match_pendente;
    select codigo_pdm into v_pdm from public.catmat_pdms order by codigo_pdm limit 1;
    if v_pdm is null then
      v_pdm := 999999901;
      insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash)
      values (v_pdm, 99, 9999, 'PDM DE VERIFICACAO', 'verificacao');
    end if;
    -- id é identity nas migrations; numa cópia de dados pode não ser
    foreach v_fn in array array['catmat_pdm_palavras|\mzzverif(s)?\M', 'catmat_pdm_exclusoes|zzverif proibid'] loop
      if (select attidentity from pg_attribute
           where attrelid = ('public.' || split_part(v_fn, '|', 1))::regclass and attname = 'id') in ('a', 'd') then
        execute format('insert into public.%I (codigo_pdm, padrao) values ($1, $2)', split_part(v_fn, '|', 1))
          using v_pdm, split_part(v_fn, '|', 2);
      else
        execute format('insert into public.%I (id, codigo_pdm, padrao) select coalesce(max(id), 0) + 1, $1, $2 from public.%I',
                       split_part(v_fn, '|', 1), split_part(v_fn, '|', 1))
          using v_pdm, split_part(v_fn, '|', 2);
      end if;
    end loop;

    select slug into v_fonte from public.fontes_externas order by slug limit 1;
    if v_fonte is null then
      v_fonte := 'verificacao';
      insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
      values (v_fonte, 'Verificação', 'manual', 'https://licitagym.invalid', 'manual');
    end if;
    insert into public.licitacoes_externas (fonte, objeto) values (v_fonte, 'Aquisição de ZZVERIFS') returning id into v_l1;
    insert into public.licitacoes_externas (fonte, objeto) values (v_fonte, 'Outra compra') returning id into v_l2;
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao) values (v_l2, 1, 'zzverif azul') returning id into v_i1;
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao) values (v_l2, 2, 'ZZVERIF PROIBIDO') returning id into v_i2;
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao) values (v_l1, 3, 'outra coisa') returning id into v_i3;

    -- a) sem carga: nada marcado nem gravado; fallback ao vivo responde certo
    if exists (select 1 from public.licitacao_match_pendente)
       or exists (select 1 from public.licitacao_match where licitacao_id in (v_l1, v_l2)) then
      raise exception 'sem carga, triggers deveriam ficar inertes';
    end if;
    if public.licitacao_match_atualizar(1000) <> 0
       or exists (select 1 from public.licitacao_match where licitacao_id in (v_l1, v_l2)) then
      raise exception 'sem carga, licitacao_match_atualizar não deveria gravar';
    end if;
    select string_agg(format('%s/%s', licitacao_id, motivo), ',' order by licitacao_id, motivo) into v_got
      from public.licitacoes_ids_por_catmat(null, null, array[v_pdm], null, false)
     where licitacao_id in (v_l1, v_l2) and motivo like 'texto%';
    if v_got is distinct from format('%s/texto_objeto,%s/texto_item', v_l1, v_l2) then
      raise exception 'fallback sem carga: licitacoes_ids_por_catmat = %', v_got;
    end if;

    -- b) carga, e depois as escritas marcam pendência
    perform public.licitacao_match_carregar();
    if not exists (select 1 from public.licitacao_match_estado where carregado_em is not null)
       or exists (select 1 from public.licitacao_match_pendente)
       or (select count(*) from public.licitacao_match where licitacao_id in (v_l1, v_l2)) <> 2 then
      raise exception 'licitacao_match_carregar deveria carregar 2 casamentos da fixture, zerar pendências e marcar o estado';
    end if;
    update public.licitacao_itens set descricao = descricao || ' ' where id in (v_i1, v_i2, v_i3);
    update public.licitacoes_externas set objeto = objeto || ' ' where id in (v_l1, v_l2);
    select count(*) into v_n from public.licitacao_match_pendente
     where (origem = 'texto_item' and ref_id in (v_i1, v_i2, v_i3)) or (origem = 'texto_objeto' and ref_id in (v_l1, v_l2));
    if v_n <> 5 then raise exception 'update de texto deveria marcar 5 pendências, marcou %', v_n; end if;

    for v_n in 1..4 loop
      -- etapa 1: pendente; 2: drenado; 3: update + upsert pendentes; 4: exclusão desativada (recalculo por trigger) e drenado
      if v_n = 2 or v_n = 4 then
        loop
          v_rest := public.licitacao_match_atualizar(1000);
          exit when v_rest = 0;
        end loop;
      end if;
      if v_n = 3 then
        update public.licitacao_itens set descricao = 'zzverif verde' where id = v_i3;
        insert into public.licitacao_itens (licitacao_id, numero_item, descricao) values (v_l2, 1, 'sem nada')
        on conflict (licitacao_id, numero_item) do update set descricao = excluded.descricao;
        if (select count(*) from public.licitacao_match_pendente where origem = 'texto_item' and ref_id in (v_i1, v_i3)) <> 2 then
          raise exception 'update/upsert de descrição deveria marcar pendência';
        end if;
      end if;
      if v_n = 4 then
        update public.catmat_pdm_exclusoes set ativo = false where codigo_pdm = v_pdm and padrao = 'zzverif proibid';
      end if;

      select string_agg(format('%s/%s', licitacao_id, motivo), ',' order by licitacao_id, motivo) into v_got
        from public.licitacoes_ids_por_catmat(null, null, array[v_pdm], null, false)
       where licitacao_id in (v_l1, v_l2) and motivo like 'texto%';
      v_exp := case v_n
        when 1 then format('%s/texto_objeto,%s/texto_item', v_l1, v_l2)
        when 2 then format('%s/texto_objeto,%s/texto_item', v_l1, v_l2)
        when 3 then format('%s/texto_item,%s/texto_objeto', v_l1, v_l1)
        else format('%s/texto_item,%s/texto_objeto,%s/texto_item', v_l1, v_l1, v_l2) end;
      if v_got is distinct from v_exp then
        raise exception 'etapa %: licitacoes_ids_por_catmat = %, esperado %', v_n, v_got, v_exp;
      end if;
    end loop;

    if v_rest <> 0 or exists (select 1 from public.licitacao_match_pendente) then
      raise exception 'drenagem deveria zerar as pendências';
    end if;
    if (select count(*) from public.licitacao_match where item_id in (v_i1, v_i2, v_i3)) <> 2
       or not exists (select 1 from public.licitacao_match where item_id = v_i2)
       or exists (select 1 from public.licitacao_match where item_id = v_i1) then
      raise exception 'licitacao_match com casamentos de item inesperados';
    end if;

    -- 5
    select count(*) into v_n from public.licitacoes_ids_por_catmat_unica(null, null, array[v_pdm], null, false);
    if v_n <> 1 then raise exception 'licitacoes_ids_por_catmat_unica deveria devolver 1 linha, devolveu %', v_n; end if;
    select u.ids, u.matches into v_ids, v_matches from public.licitacoes_ids_por_catmat_unica(null, null, array[v_pdm], null, false) u;
    if v_ids is distinct from (select array_agg(distinct licitacao_id order by licitacao_id)
                                 from public.licitacoes_ids_por_catmat(null, null, array[v_pdm], null, false))
       or jsonb_array_length(v_matches) <> (select count(*) from public.licitacoes_ids_por_catmat(null, null, array[v_pdm], null, false))
       or not (v_ids @> array[v_l1, v_l2]) then
      raise exception 'licitacoes_ids_por_catmat_unica diverge da RPC: ids=% matches=%', v_ids, jsonb_array_length(v_matches);
    end if;
    select count(*) into v_n from public.licitacoes_ids_por_catmat_unica(null, null, array[-1], null, false) u
     where u.ids = '{}'::bigint[] and u.matches = '[]'::jsonb;
    if v_n <> 1 then raise exception 'licitacoes_ids_por_catmat_unica sem casamento deveria devolver ids {} e matches []'; end if;

    raise exception using errcode = 'LG001', message = 'desfaz fixture';
  exception when sqlstate 'LG001' then
    null;
  end;

  raise notice 'SUCESSO: licitacao_match_check';
end
$$;
