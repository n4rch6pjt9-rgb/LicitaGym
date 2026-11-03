-- Checagem da migration 20261021120000_pipeline_etapas_reordenar (spec 0034, K-5 a K-7).
--   CA-3e: ACL das 4 funções (só service_role); ordem final única e contínua (10, 20, 30...).
--   CA-3g: a versao de pipeline_etapas_listar é a de pipeline_etapas_versao sobre as mesmas linhas.
--   CA-3a a CA-3d: reordenar com a versão lida; lista inválida (LG001) só com versão certa; versão velha (LG002),
--   inclusive depois de criar ou excluir etapa. pipeline_etapa_criar põe a etapa no fim.
-- Tudo o que grava é desfeito ao final (exceção proposital).

do $$
declare
  r       text;
  f       text;
  v_t     bigint;
  v_t2    bigint;
  v_u     uuid := '00000000-0000-0000-0000-0000000000a4';
  v_ids   bigint[];
  v_ids2  bigint[];
  v_rev   bigint[];
  v_v0    text;
  v_v1    text;
  v_n     integer;
  v_estado text;
  v_ok    boolean;
  v_nova  bigint;
  v_ordem integer;
begin
  foreach f in array array[
    'public.pipeline_etapas_versao(bigint)',
    'public.pipeline_etapas_listar(bigint)',
    'public.pipeline_etapas_reordenar(bigint,bigint[],text,uuid)',
    'public.pipeline_etapa_criar(bigint,text,text,text,boolean,uuid)'
  ] loop
    foreach r in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % executa %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', f;
    end if;
    if exists (select 1 from pg_proc where oid = f::regprocedure and prosecdef) then
      raise exception 'CHECK FALHOU: % é security definer', f;
    end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and proconfig @> array['search_path=public, pg_temp']) then
      raise exception 'CHECK FALHOU: % sem search_path fixo', f;
    end if;
  end loop;

  begin
    insert into public.tenants (slug, nome) values ('check-reordenar-1', 'Check reordenar 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-reordenar-2', 'Check reordenar 2') returning id into v_t2;
    select array_agg(id order by ordem, id) into v_ids from public.pipeline_etapas where tenant_id = v_t;
    select array_agg(id order by ordem, id) into v_ids2 from public.pipeline_etapas where tenant_id = v_t2;
    if cardinality(v_ids) <> 13 then
      raise exception 'CHECK FALHOU: tenant novo com % etapas (esperado 13)', cardinality(v_ids);
    end if;

    -- CA-3g: mesma versão nas linhas e em pipeline_etapas_versao; total por etapa; ordem da lista
    select count(*), min(versao), count(distinct versao), array_agg(id order by ordem, id)
      into v_n, v_v0, v_ordem, v_rev
      from public.pipeline_etapas_listar(v_t);
    if v_n <> 13 or v_ordem <> 1 or v_v0 is distinct from public.pipeline_etapas_versao(v_t) or v_rev <> v_ids then
      raise exception 'CHECK FALHOU: pipeline_etapas_listar (n=%, versões=%, versao=%, esperado %)', v_n, v_ordem, v_v0,
        public.pipeline_etapas_versao(v_t);
    end if;
    if v_v0 = public.pipeline_etapas_versao(v_t2) then
      raise exception 'CHECK FALHOU: dois tenants com a mesma versão';
    end if;

    -- CA-3b: id repetido, faltando etapa, etapa do outro tenant, lista vazia → LG001 e nada muda
    foreach f in array array['repetido', 'faltando', 'outro_tenant', 'vazia'] loop
      v_ok := false;
      begin
        perform public.pipeline_etapas_reordenar(v_t, case f
          when 'repetido' then v_ids[1:12] || v_ids[1]
          when 'faltando' then v_ids[2:13]
          when 'outro_tenant' then v_ids[1:12] || v_ids2[1]
          else '{}'::bigint[] end, v_v0, v_u);
      exception when sqlstate 'LG001' then
        v_ok := true;
      end;
      if not v_ok then
        raise exception 'CHECK FALHOU: lista % aceita', f;
      end if;
    end loop;
    if public.pipeline_etapas_versao(v_t) <> v_v0 then
      raise exception 'CHECK FALHOU: lista inválida mudou alguma etapa';
    end if;

    -- CA-3a: as 13 ao contrário com a versão lida; ordem = posição × 10; versão nova devolvida em todas as linhas
    select array_agg(x order by i desc) into v_rev from unnest(v_ids) with ordinality as u (x, i);
    -- como service_role (o papel da api-pipeline), para pegar grant de tabela que falte
    set local role service_role;
    select count(*), min(versao), array_agg(id order by ordem) into v_n, v_v1, v_ids2
      from public.pipeline_etapas_reordenar(v_t, v_rev, v_v0, v_u);
    reset role;
    if v_n <> 13 or v_ids2 <> v_rev or v_v1 = v_v0 or v_v1 is distinct from public.pipeline_etapas_versao(v_t) then
      raise exception 'CHECK FALHOU: reordenar (n=%, versao nova=%, atual=%)', v_n, v_v1, public.pipeline_etapas_versao(v_t);
    end if;
    -- CA-3e: ordem única e contínua; updated_by de quem reordenou
    if exists (
      select 1 from (select ordem, row_number() over (order by ordem) * 10 as esperado
                       from public.pipeline_etapas where tenant_id = v_t) o
       where o.ordem <> o.esperado
    ) then
      raise exception 'CHECK FALHOU: ordem final não é 10, 20, 30...';
    end if;
    if exists (select 1 from public.pipeline_etapas where tenant_id = v_t and updated_by is distinct from v_u
                and id <> v_ids[7]) then
      raise exception 'CHECK FALHOU: etapa reordenada sem updated_by';
    end if;
    -- o outro tenant não mudou
    if exists (select 1 from public.pipeline_etapas where tenant_id = v_t2 and updated_by is not null) then
      raise exception 'CHECK FALHOU: reordenar mexeu no outro tenant';
    end if;

    -- CA-3c: versão velha depois da reordenação → LG002, nada muda
    v_estado := null;
    begin
      perform public.pipeline_etapas_reordenar(v_t, v_ids, v_v0, v_u);
    exception when sqlstate 'LG002' then
      v_estado := 'versao_desatualizada';
    end;
    if v_estado is null or public.pipeline_etapas_versao(v_t) <> v_v1 then
      raise exception 'CHECK FALHOU: versão velha aceita ou mudou a lista';
    end if;

    -- K-7: criar põe no fim (maior + 10), dentro do lock; nome repetido continua 23505
    set local role service_role;
    select id, ordem into v_nova, v_ordem
      from public.pipeline_etapa_criar(v_t, 'Visita técnica', 'proposta', null, false, v_u);
    reset role;
    if v_ordem <> 140 then
      raise exception 'CHECK FALHOU: etapa criada com ordem % (esperado 140)', v_ordem;
    end if;
    v_ok := false;
    begin
      perform public.pipeline_etapa_criar(v_t, 'Visita técnica', 'proposta', null, false, v_u);
    exception when unique_violation then
      v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: nome repetido aceito';
    end if;
    v_ok := false;
    begin
      perform public.pipeline_etapa_criar(v_t, 'Sem usuário', 'proposta', null, false, null);
    exception when invalid_parameter_value then
      v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: criar sem usuário aceito';
    end if;
    -- fase inválida chamando a função direto (sem a api-pipeline) continua barrada pela constraint
    v_ok := false;
    begin
      perform public.pipeline_etapa_criar(v_t, 'Fase errada', 'outra', null, false, v_u);
    exception when check_violation then
      v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: criar com fase inválida aceito';
    end if;

    -- CA-3d: a versão v_v1 (13 etapas) depois de criar a 14ª → LG002, não LG001, embora a lista esteja incompleta
    v_estado := null;
    begin
      perform public.pipeline_etapas_reordenar(v_t, v_rev, v_v1, v_u);
    exception
      when sqlstate 'LG002' then v_estado := 'versao_desatualizada';
      when sqlstate 'LG001' then v_estado := 'lista_invalida';
    end;
    if v_estado is distinct from 'versao_desatualizada' then
      raise exception 'CHECK FALHOU: depois de criar, versão velha deu % (esperado versao_desatualizada)', v_estado;
    end if;
    -- e depois de excluir uma etapa
    v_v1 := public.pipeline_etapas_versao(v_t);
    select array_agg(id order by ordem) into v_ids2 from public.pipeline_etapas where tenant_id = v_t;
    perform public.pipeline_etapa_excluir(v_t, v_nova, null, v_u);
    v_estado := null;
    begin
      perform public.pipeline_etapas_reordenar(v_t, v_ids2, v_v1, v_u);
    exception
      when sqlstate 'LG002' then v_estado := 'versao_desatualizada';
      when sqlstate 'LG001' then v_estado := 'lista_invalida';
    end;
    if v_estado is distinct from 'versao_desatualizada' then
      raise exception 'CHECK FALHOU: depois de excluir, versão velha deu % (esperado versao_desatualizada)', v_estado;
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_etapas_reordenar (ACL, versão, lista, lock de criar) conferida (desfeito)';
end
$$;
