-- Checagem da migration 20261113140000_licitacao_valor_escopo (timeout do resumo executivo em 13/11/2026).
-- Falha com EXCEPTION se:
--   A) public.licitacao_valor_escopo não existir, estiver sem RLS, ou anon/authenticated tiverem algum privilégio,
--      ou service_role puder escrever (só lê: a escrita é dos triggers);
--   B) as funções de manutenção não forem security definer com search_path fixo, ou forem executáveis por
--      public/anon/authenticated/service_role;
--   C) os triggers de statement (insert, update, delete, truncate) não estiverem em public.licitacao_itens;
--   D) a tabela divergir da soma direta dos itens no escopo depois de: inserir, mudar valor, mudar categoria, mover
--      item de licitação, upsert (on conflict do update), apagar item e apagar a licitação (cascade);
--   E) depois de tudo, qualquer licitação do banco tiver soma diferente da direta (equivalência total);
--   F) dashboard_resumo_executivo não ler a tabela nova (voltaria a ler o heap de licitacao_itens).
-- As linhas de teste ficam num bloco desfeito no fim (nada fica gravado).
-- Saída esperada: "SUCESSO: licitacao_valor_escopo_check".

do $chk$
declare
  v_tab regclass := to_regclass('public.licitacao_valor_escopo');
  v_fn text;
  v_l1 bigint; v_l2 bigint;
  v_i_forte bigint; v_i_piso bigint;
  r record;
  v_div bigint;
  v_cat text;
begin
  -- A) tabela e ACL -------------------------------------------------------------------------------------------------
  if v_tab is null then
    raise exception 'licitacao_valor_escopo_check A: tabela public.licitacao_valor_escopo ausente';
  end if;
  if not exists (select 1 from pg_class where oid = v_tab and relrowsecurity) then
    raise exception 'licitacao_valor_escopo_check A: RLS desligada';
  end if;
  if has_table_privilege('anon', v_tab, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated', v_tab, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'licitacao_valor_escopo_check A: anon/authenticated com privilégio na tabela';
  end if;
  if not has_table_privilege('service_role', v_tab, 'SELECT') then
    raise exception 'licitacao_valor_escopo_check A: service_role sem SELECT (o resumo é security invoker)';
  end if;
  if has_table_privilege('service_role', v_tab, 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'licitacao_valor_escopo_check A: service_role pode escrever; só os triggers escrevem';
  end if;

  -- B) funções de manutenção ----------------------------------------------------------------------------------------
  for r in
    select p.oid, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('licitacao_valor_escopo_recalcular', 'licitacao_valor_escopo_trg')
  loop
    if not r.prosecdef then
      raise exception 'licitacao_valor_escopo_check B: % deveria ser security definer', r.proname;
    end if;
    if not ('search_path=pg_catalog, public, pg_temp' = any (coalesce(r.proconfig, '{}'))) then
      raise exception 'licitacao_valor_escopo_check B: % sem search_path fixo (%)', r.proname, r.proconfig;
    end if;
    if has_function_privilege('public', r.oid, 'EXECUTE') or has_function_privilege('anon', r.oid, 'EXECUTE')
       or has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'licitacao_valor_escopo_check B: % executável fora do dono', r.proname;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('licitacao_valor_escopo_recalcular', 'licitacao_valor_escopo_trg')) <> 2 then
    raise exception 'licitacao_valor_escopo_check B: funções de manutenção ausentes';
  end if;

  -- C) triggers -----------------------------------------------------------------------------------------------------
  if (select count(*) from pg_trigger
       where tgrelid = 'public.licitacao_itens'::regclass and not tgisinternal
         and tgname in ('licitacao_valor_escopo_ins', 'licitacao_valor_escopo_upd', 'licitacao_valor_escopo_del',
                        'licitacao_valor_escopo_trunc')) <> 4 then
    raise exception 'licitacao_valor_escopo_check C: triggers de licitacao_itens ausentes';
  end if;

  -- F) o resumo lê a tabela nova ------------------------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'dashboard_resumo_executivo';
  if v_fn is null or v_fn !~ 'public\.licitacao_valor_escopo' or v_fn ~ 'public\.licitacao_itens' then
    raise exception 'licitacao_valor_escopo_check F: dashboard_resumo_executivo não lê licitacao_valor_escopo';
  end if;

  -- D) comportamento ------------------------------------------------------------------------------------------------
  begin
    insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
    values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico')
    on conflict (slug) do nothing;

    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, prioridade)
    values ('pncp', 'check-valor-escopo-00000000000951-1-000001/2099', '00000000000951', '0951/2099', 'PE 951/2099', 'leads')
    returning id into v_l1;
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, prioridade)
    values ('pncp', 'check-valor-escopo-00000000000952-1-000001/2099', '00000000000952', '0952/2099', 'PE 952/2099', 'leads')
    returning id into v_l2;

    -- D0: cada uma das 6 categorias, sozinha, passa pelos quatro caminhos do trigger (insert, update saindo do
    -- escopo, update voltando, delete). Pega cópia da regra sem alguma categoria.
    foreach v_cat in array array['forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao'] loop
      insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado, categoria_escopo)
      values (v_l2, 900, 'item ' || v_cat, 3.00, v_cat);
      if not exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2 and valor = 3.00) then
        raise exception 'licitacao_valor_escopo_check D0: insert de % não entrou', v_cat;
      end if;
      update public.licitacao_itens set categoria_escopo = 'fraco' where licitacao_id = v_l2 and numero_item = 900;
      if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2) then
        raise exception 'licitacao_valor_escopo_check D0: update de % para fraco não saiu', v_cat;
      end if;
      update public.licitacao_itens set categoria_escopo = v_cat where licitacao_id = v_l2 and numero_item = 900;
      if not exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2 and valor = 3.00) then
        raise exception 'licitacao_valor_escopo_check D0: update de fraco para % não entrou', v_cat;
      end if;
      delete from public.licitacao_itens where licitacao_id = v_l2 and numero_item = 900;
      if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2) then
        raise exception 'licitacao_valor_escopo_check D0: delete de % não saiu', v_cat;
      end if;
    end loop;

    -- D1: insert em lote; só forte e piso com valor contam (fraco, sem categoria e valor nulo ficam fora).
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado, categoria_escopo)
    values (v_l1, 1, 'item forte', 10.00, 'forte'),
           (v_l1, 2, 'item fraco', 5.00, 'fraco'),
           (v_l1, 3, 'item catmat sem valor', null, 'catmat'),
           (v_l1, 4, 'item piso', 20.00, 'piso'),
           (v_l1, 5, 'item sem categoria', 7.00, null);
    select id into v_i_forte from public.licitacao_itens where licitacao_id = v_l1 and numero_item = 1;
    select id into v_i_piso from public.licitacao_itens where licitacao_id = v_l1 and numero_item = 4;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l1;
    if r.valor is distinct from 30.00::numeric or r.itens is distinct from 2 then
      raise exception 'licitacao_valor_escopo_check D1: insert -> valor=% itens=% (esperado 30.00 e 2)', r.valor, r.itens;
    end if;

    -- D2: licitação só com item fora do escopo não tem linha.
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado, categoria_escopo)
    values (v_l2, 1, 'item fraco', 99.00, 'fraco');
    if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2) then
      raise exception 'licitacao_valor_escopo_check D2: licitação sem item no escopo ganhou linha';
    end if;

    -- D3: mudar valor de item no escopo.
    update public.licitacao_itens set valor_total_estimado = 15.00 where id = v_i_forte;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l1;
    if r.valor is distinct from 35.00::numeric then
      raise exception 'licitacao_valor_escopo_check D3: update de valor -> % (esperado 35.00)', r.valor;
    end if;

    -- D4: item sai do escopo pela categoria.
    update public.licitacao_itens set categoria_escopo = 'fraco' where id = v_i_piso;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l1;
    if r.valor is distinct from 15.00::numeric or r.itens is distinct from 1 then
      raise exception 'licitacao_valor_escopo_check D4: categoria -> valor=% itens=% (esperado 15.00 e 1)', r.valor, r.itens;
    end if;

    -- D5: upsert do coletor (on conflict do update) devolve o item ao escopo com valor novo.
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_total_estimado, categoria_escopo)
    values (v_l1, 4, 'item piso', 25.00, 'borracha')
    on conflict (licitacao_id, numero_item) do update
      set valor_total_estimado = excluded.valor_total_estimado, categoria_escopo = excluded.categoria_escopo;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l1;
    if r.valor is distinct from 40.00::numeric or r.itens is distinct from 2 then
      raise exception 'licitacao_valor_escopo_check D5: upsert -> valor=% itens=% (esperado 40.00 e 2)', r.valor, r.itens;
    end if;

    -- D6: item muda de licitação (as duas recalculam).
    update public.licitacao_itens set licitacao_id = v_l2, numero_item = 2 where id = v_i_piso;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l1;
    if r.valor is distinct from 15.00::numeric then
      raise exception 'licitacao_valor_escopo_check D6: origem -> % (esperado 15.00)', r.valor;
    end if;
    select * into r from public.licitacao_valor_escopo where licitacao_id = v_l2;
    if r.valor is distinct from 25.00::numeric or r.itens is distinct from 1 then
      raise exception 'licitacao_valor_escopo_check D6: destino -> valor=% itens=% (esperado 25.00 e 1)', r.valor, r.itens;
    end if;

    -- D7: valor vira nulo -> sai da soma; último item do escopo apagado -> linha some (nunca valor 0 inventado).
    update public.licitacao_itens set valor_total_estimado = null where id = v_i_forte;
    if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l1) then
      raise exception 'licitacao_valor_escopo_check D7: licitação sem item com valor manteve linha';
    end if;
    delete from public.licitacao_itens where id = v_i_piso;
    if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l2) then
      raise exception 'licitacao_valor_escopo_check D7: delete do último item no escopo manteve linha';
    end if;

    -- D8: apagar a licitação apaga a linha (cascade pelos itens e pela FK).
    update public.licitacao_itens set valor_total_estimado = 1.00 where id = v_i_forte;
    if not exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l1) then
      raise exception 'licitacao_valor_escopo_check D8: linha não voltou depois de valor 1.00';
    end if;
    delete from public.licitacoes_externas where id = v_l1;
    if exists (select 1 from public.licitacao_valor_escopo where licitacao_id = v_l1) then
      raise exception 'licitacao_valor_escopo_check D8: licitação apagada manteve linha';
    end if;

    -- E) equivalência total com a soma direta (inclui o que a migration carregou).
    select count(*) into v_div
      from (select licitacao_id, valor, itens from public.licitacao_valor_escopo) v
      full join (select i.licitacao_id, sum(i.valor_total_estimado) as valor, count(*)::int as itens
                   from public.licitacao_itens i
                  where i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
                    and i.valor_total_estimado is not null
                  group by i.licitacao_id) d using (licitacao_id)
     where v.valor is distinct from d.valor or v.itens is distinct from d.itens;
    if v_div > 0 then
      raise exception 'licitacao_valor_escopo_check E: % licitações divergem da soma direta', v_div;
    end if;

    -- SQLSTATE próprio: só o "desfazer" é engolido; qualquer outro erro derruba a checagem.
    raise exception 'desfazer' using errcode = 'LG001', detail = 'rollback do savepoint';
  exception when sqlstate 'LG001' then null;
  end;

  raise notice 'SUCESSO: licitacao_valor_escopo_check';
end
$chk$;
