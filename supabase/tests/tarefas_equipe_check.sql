-- Checagem da migration 20261011110000_tarefas_equipe (#252, spec 0019).
--   (a) ACL e RLS (CA-6): tabela com RLS e sem privilégio para anon/authenticated/PUBLIC; funções só service_role,
--       com search_path fixo.
--   (b) Regras (CA-1 a CA-5, CA-7, CA-12), num sub-bloco que termina com uma exceção proposital: tudo o que (b) grava
--       é desfeito.
-- Falha com RAISE EXCEPTION 'CHECK FALHOU: ...'; sucesso termina com NOTICE 'SUCESSO: ...'.

do $$
declare
  r text;
  p text;
  f text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.tarefas_equipe'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em public.tarefas_equipe';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.tarefas_equipe'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em public.tarefas_equipe', r, p;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.tarefas_equipe'::regclass, 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'CHECK FALHOU: service_role sem escrita em public.tarefas_equipe';
  end if;

  foreach f in array array[
    'public.tarefas_contexto_certame(bigint)',
    'public.tarefas_prazo_situacao(public.prazo_unidade)',
    'public.tarefas_equipe_liberar(bigint,bigint,text,text,uuid)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % pode executar %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', f;
    end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
      raise exception 'CHECK FALHOU: % sem search_path fixo', f;
    end if;
  end loop;

  raise notice 'SUCESSO: tarefas_equipe ACL/RLS ok';
end
$$;

do $$
declare
  v_t      bigint;
  v_t2     bigint;
  v_nova   bigint;
  v_srp    bigint;   -- LEI_14133, srp = true no PNCP
  v_nsrp   bigint;   -- LEI_14133, srp = false no PNCP
  v_ssrp   bigint;   -- LEI_14133, sem srp no PNCP e objeto com "registro de preço" (a regex não pode valer)
  v_rca    bigint;   -- regulamento RCA
  v_outro  bigint;   -- regulamento OUTRO
  v_nulo   bigint;   -- regulamento nulo
  v_rlc    bigint;   -- regulamento RLC
  v_fora   bigint;   -- LEI_14133 fora do pipeline
  v_u      uuid := '00000000-0000-0000-0000-0000000000b1';
  v_res    record;
  v_hash   text;
begin
  begin
    insert into auth.users (id, email) values (v_u, 'check-tarefas@example.invalid') on conflict (id) do nothing;
    insert into public.tenants (slug, nome) values ('check-tarefas-1', 'Check tarefas 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-tarefas-2', 'Check tarefas 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';

    insert into public.licitacoes_externas (fonte, regulamento, raw) values ('pncp', 'LEI_14133', '{"srp": true}')  returning id into v_srp;
    insert into public.licitacoes_externas (fonte, regulamento, raw) values ('pncp', 'LEI_14133', '{"srp": false}') returning id into v_nsrp;
    insert into public.licitacoes_externas (fonte, regulamento, raw, objeto)
      values ('pncp', 'LEI_14133', '{}', 'Registro de preço para aquisição de equipamentos') returning id into v_ssrp;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'RCA')   returning id into v_rca;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'OUTRO') returning id into v_outro;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', null)        returning id into v_nulo;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'RLC')       returning id into v_rlc;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_fora;
    perform public.pipeline_mover(v_t, array[v_srp, v_nsrp, v_ssrp, v_nulo, v_rlc, v_rca, v_outro], v_nova, null, v_u);

    select md5(string_agg(t::text, '|' order by t.codigo)) into v_hash from public.tarefas_catalogo t;

    -- Contexto só com dado oficial
    if public.tarefas_contexto_certame(v_srp) <> '{"srp": true}'::jsonb
       or public.tarefas_contexto_certame(v_nsrp) <> '{"srp": false}'::jsonb
       or public.tarefas_contexto_certame(v_ssrp) <> '{}'::jsonb
       or public.tarefas_contexto_certame(v_nulo) <> '{}'::jsonb then
      raise exception 'CHECK FALHOU: tarefas_contexto_certame (%, %, %)', public.tarefas_contexto_certame(v_srp),
        public.tarefas_contexto_certame(v_ssrp), public.tarefas_contexto_certame(v_nulo);
    end if;

    -- CA-12: gate de regulamento e de pipeline, nada gravado
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_nulo, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'regulamento_nao_informado' or v_res.criadas <> 0 then
      raise exception 'CHECK FALHOU: regulamento nulo liberou (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_rlc, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo' then
      raise exception 'CHECK FALHOU: RLC liberou tarefa do catálogo (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_rca, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo' then
      raise exception 'CHECK FALHOU: RCA liberou tarefa do catálogo (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_outro, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo' then
      raise exception 'CHECK FALHOU: OUTRO liberou tarefa do catálogo (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_fora, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'fora_do_pipeline' then
      raise exception 'CHECK FALHOU: licitação fora do pipeline liberou (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t2, v_srp, null, 'ATA_HABILITACAO', v_u);
    if v_res.bloqueio is distinct from 'fora_do_pipeline' then
      raise exception 'CHECK FALHOU: outra empresa liberou tarefa em licitação que não está no pipeline dela (%)', v_res;
    end if;
    if exists (select 1 from public.tarefas_equipe where licitacao_id in (v_nulo, v_rlc, v_rca, v_outro, v_fora)
               or tenant_id = v_t2) then
      raise exception 'CHECK FALHOU: bloqueio gravou tarefa';
    end if;

    -- Exatamente um entre fase e evento
    begin
      perform public.tarefas_equipe_liberar(v_t, v_srp, 'F05', 'ATA_HABILITACAO', v_u);
      raise exception 'CHECK FALHOU: aceitou fase e evento juntos';
    exception when sqlstate '22023' then null;
    end;
    -- fase ou evento inexistente, e usuário nulo, são erro (não "nada a liberar")
    begin
      perform public.tarefas_equipe_liberar(v_t, v_srp, 'F99', null, v_u);
      raise exception 'CHECK FALHOU: aceitou fase inexistente';
    exception when sqlstate '22023' then null;
    end;
    begin
      perform public.tarefas_equipe_liberar(v_t, v_srp, null, 'ATA_HABILITACAO', null);
      raise exception 'CHECK FALHOU: aceitou usuário nulo';
    exception when sqlstate '22023' then null;
    end;

    -- CA-1: srp = true libera as tarefas da ata SRP com condição verificada; srp = false não libera
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_srp, null, 'ATA_SRP_ASSINADA', v_u);
    if v_res.bloqueio is not null or v_res.criadas < 1
       or exists (select 1 from public.tarefas_equipe
                   where tenant_id = v_t and licitacao_id = v_srp and condicao_verificada is distinct from true) then
      raise exception 'CHECK FALHOU: srp = true (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_nsrp, null, 'ATA_SRP_ASSINADA', v_u);
    if v_res.criadas <> 0 or exists (select 1 from public.tarefas_equipe where licitacao_id = v_nsrp) then
      raise exception 'CHECK FALHOU: srp = false criou tarefa que exige srp (%)', v_res;
    end if;

    -- Sem srp no PNCP (objeto cita "registro de preço"): as tarefas nascem com condição não verificada, nunca somem
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_ssrp, null, 'ATA_SRP_ASSINADA', v_u);
    if v_res.criadas < 1 or exists (select 1 from public.tarefas_equipe
                                     where licitacao_id = v_ssrp and condicao_verificada is not null) then
      raise exception 'CHECK FALHOU: sem srp oficial não virou "condição não verificada" (%)', v_res;
    end if;
    -- o dado oficial chega depois: liberar de novo confirma a condição, sem duplicar
    update public.licitacoes_externas set raw = '{"srp": true}' where id = v_ssrp;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_ssrp, null, 'ATA_SRP_ASSINADA', v_u);
    if v_res.criadas <> 0 or exists (select 1 from public.tarefas_equipe
                                      where licitacao_id = v_ssrp and condicao_verificada is not true) then
      raise exception 'CHECK FALHOU: condição confirmada depois não foi gravada (%)', v_res;
    end if;

    -- CA-2: chave ausente (inversao_fases) -> criada com condição não verificada; sem condição -> true
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_srp, null, 'ATA_HABILITACAO', v_u);
    if (select condicao_verificada from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_srp and tarefa_codigo = '14133-F05-T01') is not null
       or not exists (select 1 from public.tarefas_equipe
                       where tenant_id = v_t and licitacao_id = v_srp and tarefa_codigo = '14133-F05-T01') then
      raise exception 'CHECK FALHOU: chave ausente não virou "condição não verificada"';
    end if;
    if (select condicao_verificada from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_srp and tarefa_codigo = '14133-F05-T03') is not true then
      raise exception 'CHECK FALHOU: tarefa sem condição não ficou verificada';
    end if;

    -- CA-3: liberar de novo o evento, ou a fase que contém as mesmas tarefas, não duplica
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_srp, null, 'ATA_HABILITACAO', v_u);
    if v_res.criadas <> 0 or v_res.existentes < 1 then
      raise exception 'CHECK FALHOU: liberar o mesmo evento duplicou (%)', v_res;
    end if;
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_srp, 'F05', null, v_u);
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_srp
                group by tarefa_codigo having count(*) > 1) then
      raise exception 'CHECK FALHOU: fase e evento duplicaram a mesma tarefa';
    end if;
    -- a segunda origem fica registrada
    if not exists (select 1 from public.tarefas_equipe
                    where tenant_id = v_t and licitacao_id = v_srp and tarefa_codigo = '14133-F05-T01'
                      and liberada_por_evento = 'ATA_HABILITACAO' and liberada_por_fase = 'F05') then
      raise exception 'CHECK FALHOU: liberar pela fase depois do evento não registrou a segunda origem';
    end if;

    -- CA-4: dias úteis -> prazo não calculado, sem data
    if exists (select 1 from public.tarefas_equipe e join public.tarefas_catalogo c on c.codigo = e.tarefa_codigo
                where e.tenant_id = v_t and c.prazo_unidade = 'dias_uteis'
                  and (e.prazo_situacao <> 'nao_calculado' or e.prazo_em is not null))
       or not exists (select 1 from public.tarefas_equipe where tenant_id = v_t and tarefa_codigo = '14133-F05-T02') then
      raise exception 'CHECK FALHOU: prazo em dias úteis não ficou "não calculado"';
    end if;
    -- meses/anos sem data do evento: também não calculado (14133-F12-T01 é em anos)
    if (select prazo_situacao from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_srp and tarefa_codigo = '14133-F12-T01') is distinct from 'nao_calculado' then
      raise exception 'CHECK FALHOU: prazo em anos não ficou "não calculado"';
    end if;

    -- CA-7: nasce na fila do admin, sem pessoa
    if exists (select 1 from public.tarefas_equipe
                where tenant_id = v_t and (responsavel_papel <> 'admin' or responsavel_user_id is not null)) then
      raise exception 'CHECK FALHOU: tarefa não nasceu para o papel admin sem pessoa';
    end if;

    -- prazo manual exige data, e data exige "manual"
    begin
      update public.tarefas_equipe set prazo_em = now() where tenant_id = v_t and tarefa_codigo = '14133-F05-T02';
      raise exception 'CHECK FALHOU: aceitou prazo_em sem prazo_situacao manual';
    exception when check_violation then null;
    end;

    -- CA-5: status e responsável mudam só na instância
    update public.tarefas_equipe
       set status = 'concluida', concluida_em = now(), responsavel_user_id = v_u,
           prazo_situacao = 'manual', prazo_em = now(), prazo_informado_por = v_u, prazo_informado_em = now()
     where tenant_id = v_t and licitacao_id = v_srp;
    if (select md5(string_agg(t::text, '|' order by t.codigo)) from public.tarefas_catalogo t) <> v_hash then
      raise exception 'CHECK FALHOU: tarefas_catalogo mudou';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: tarefas_equipe regras ok (desfeitas)';
end
$$;
