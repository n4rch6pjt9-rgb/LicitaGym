-- Checagem da migration 20261011120000_pipeline_etapa_tarefas (spec 0018).
--   (a) ACL e RLS (CA-11): pipeline_etapa_tarefas sem acesso para anon/authenticated; funções só service_role.
--   (b) Regras (CA-1 a CA-8, CA-12 a CA-14, CA-16, CA-18 a CA-22), num sub-bloco que termina com exceção proposital:
--       tudo o que (b) grava é desfeito.
-- Falha com RAISE EXCEPTION 'CHECK FALHOU: ...'; sucesso termina com NOTICE 'SUCESSO: ...'.

do $$
declare
  r text;
  p text;
  f text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.pipeline_etapa_tarefas'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em public.pipeline_etapa_tarefas';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'public.pipeline_etapa_tarefas'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em public.pipeline_etapa_tarefas', r, p;
      end if;
    end loop;
  end loop;
  foreach f in array array[
    'public.pipeline_semear_tarefas(bigint)',
    'public.pipeline_etapa_tarefas_criar(bigint,bigint,bigint,uuid,timestamptz)',
    'public.pipeline_tarefas_reaplicar(bigint,bigint,uuid)',
    'public.pipeline_etapa_tarefas_validar()',
    'public.pipeline_oportunidades_tarefas()',
    'public.licitacoes_externas_regulamento_reaplicar()'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % pode executar %', r, f;
      end if;
    end loop;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
      raise exception 'CHECK FALHOU: % sem search_path fixo', f;
    end if;
  end loop;
  foreach f in array array[
    'public.pipeline_semear_tarefas(bigint)',
    'public.pipeline_etapa_tarefas_criar(bigint,bigint,bigint,uuid,timestamptz)',
    'public.pipeline_tarefas_reaplicar(bigint,bigint,uuid)'
  ] loop
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', f;
    end if;
  end loop;
  -- tenant ativo já tem o modelo padrão
  if exists (select 1 from public.tenants t where t.ativo
              and not exists (select 1 from public.pipeline_etapa_tarefas m where m.tenant_id = t.id)) then
    raise exception 'CHECK FALHOU: tenant ativo sem o modelo padrão de tarefas';
  end if;
  raise notice 'SUCESSO: pipeline_etapa_tarefas ACL/RLS ok';
end
$$;

do $$
declare
  v_t      bigint;
  v_t2     bigint;
  v_u      uuid := '00000000-0000-0000-0000-0000000000d1';
  v_nova   bigint; v_tri bigint; v_ana bigint; v_int bigint; v_qua bigint; v_doc bigint; v_dis bigint; v_agu bigint;
  v_l1     bigint;   -- LEI_14133
  v_l2     bigint;   -- regulamento nulo
  v_l3     bigint;   -- RCA (Sistema S)
  v_n      integer;
  v_res    record;
  v_hash   text;
  v_ok     boolean;
begin
  begin
    insert into auth.users (id, email) values (v_u, 'check-etapa-tarefas@example.invalid') on conflict (id) do nothing;
    insert into public.tenants (slug, nome) values ('check-etapa-tarefas-1', 'Check etapa tarefas 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-etapa-tarefas-2', 'Check etapa tarefas 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';
    select id into v_tri  from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_ana  from public.pipeline_etapas where tenant_id = v_t and nome = 'Em análise';
    select id into v_int  from public.pipeline_etapas where tenant_id = v_t and nome = 'Interessante';
    select id into v_qua  from public.pipeline_etapas where tenant_id = v_t and nome = 'Qualificação';
    select id into v_doc  from public.pipeline_etapas where tenant_id = v_t and nome = 'Documentação';
    select id into v_dis  from public.pipeline_etapas where tenant_id = v_t and nome = 'Disputa';
    select id into v_agu  from public.pipeline_etapas where tenant_id = v_t and nome = 'Aguardando resultado';

    -- CA-8 / CA-16 / CA-18: tenant novo recebe o modelo padrão
    if (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_nova) <> 0
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'empresa') <> 2
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_ana and origem = 'empresa') <> 4
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_int and origem = 'empresa') <> 1
       or exists (select 1 from public.pipeline_etapa_tarefas where etapa_id in (v_tri, v_ana, v_int) and origem = 'catalogo')
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_qua and origem = 'catalogo') <> 5
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_doc and origem = 'catalogo') <> 6 then
      raise exception 'CHECK FALHOU: modelo padrão do tenant novo diferente das seções 2 e 2b';
    end if;
    if not exists (select 1 from public.pipeline_etapa_tarefas where etapa_id = v_tri and chave = 'triagem-restricoes-lote')
       or not exists (select 1 from public.pipeline_etapa_tarefas where etapa_id = v_ana and chave = 'analise-dossie') then
      raise exception 'CHECK FALHOU: CA-18 (restrições por lote / dossiê) ausente do modelo';
    end if;
    if exists (select 1 from public.pipeline_etapa_tarefas where tenant_id = v_t and tarefa_codigo = '14133-F01-T02') then
      raise exception 'CHECK FALHOU: F01-T02 (gate de prazo mínimo) não pode estar no modelo';
    end if;

    -- CA-8 / CA-19: reaplicar a semente não duplica nem desfaz edição do admin
    update public.pipeline_etapa_tarefas set ativo = false, titulo = 'Frete (editado)'
     where tenant_id = v_t and chave = 'analise-frete';
    if public.pipeline_semear_tarefas(v_t) <> 0 then
      raise exception 'CHECK FALHOU: reaplicar a semente inseriu modelo';
    end if;
    if (select ativo from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'analise-frete') then
      raise exception 'CHECK FALHOU: semente desfez edição do admin';
    end if;

    -- desligar um modelo cuja tarefa ficou inativa no catálogo sempre pode (Codex #327)
    update public.tarefas_catalogo set ativo = false where codigo = '14133-F01-T06';
    update public.pipeline_etapa_tarefas set ativo = false where tenant_id = v_t and tarefa_codigo = '14133-F01-T06';
    update public.tarefas_catalogo set ativo = true where codigo = '14133-F01-T06';
    update public.pipeline_etapa_tarefas set ativo = true where tenant_id = v_t and tarefa_codigo = '14133-F01-T06';

    -- CA-13: tarefa inexistente ou inativa no catálogo é recusada no modelo
    select md5(string_agg(t::text, '|' order by t.codigo)) into v_hash from public.tarefas_catalogo t;
    v_ok := false;
    begin
      insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, tarefa_codigo)
      values (v_t, v_nova, 'catalogo', '14133-F99-T99');
    exception when foreign_key_violation or check_violation then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: modelo aceitou tarefa inexistente'; end if;

    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', null)        returning id into v_l2;
    insert into public.licitacoes_externas (fonte, regulamento) values ('sestsenat', 'RCA')  returning id into v_l3;

    -- CA-1 / CA-4: Documentação cria as tarefas do modelo; condição sem dado nasce "não verificada"
    perform public.pipeline_mover(v_t, array[v_l1], v_doc, null, v_u);
    if (select count(*) from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l1 and origem = 'catalogo' and origem_etapa_id = v_doc
           and origem_etapa_nome = 'Documentação') <> 6 then
      raise exception 'CHECK FALHOU: CA-1 Documentação não criou as 6 tarefas do modelo';
    end if;
    if (select condicao_verificada from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l1 and tarefa_codigo = '14133-F01-T11') is not null then
      raise exception 'CHECK FALHOU: CA-4 inversao_fases ausente não virou "condição não verificada"';
    end if;
    -- CA-14: fila do admin, sem pessoa
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t
                and (responsavel_papel <> 'admin' or responsavel_user_id is not null)) then
      raise exception 'CHECK FALHOU: CA-14 tarefa não nasceu para o papel admin';
    end if;

    -- CA-5: dias úteis sem calendário -> não calculado
    perform public.pipeline_mover(v_t, array[v_l1], v_qua, null, v_u);
    if (select prazo_situacao from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l1 and tarefa_codigo = '14133-F01-T03') <> 'nao_calculado'
       or exists (select 1 from public.tarefas_equipe
                   where tenant_id = v_t and licitacao_id = v_l1 and tarefa_codigo = '14133-F01-T03' and prazo_em is not null) then
      raise exception 'CHECK FALHOU: CA-5 prazo em dias úteis não ficou "não calculado"';
    end if;

    -- CA-2 / CA-19: sair e voltar não duplica (catálogo e empresa); renomear o modelo não cria outra
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    if (select count(*) from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l1 and origem = 'empresa' and origem_etapa_id = v_tri) <> 2 then
      raise exception 'CHECK FALHOU: Triagem não criou as 2 tarefas da empresa';
    end if;
    update public.pipeline_etapa_tarefas set titulo = 'Aderência (renomeada)' where tenant_id = v_t and chave = 'triagem-aderencia';
    select count(*) into v_n from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1;
    perform public.pipeline_mover(v_t, array[v_l1], v_doc, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_doc, null, v_u);
    if (select count(*) from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1) <> v_n
       or exists (select 1 from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1
                   group by coalesce(tarefa_codigo, origem_modelo_chave) having count(*) > 1) then
      raise exception 'CHECK FALHOU: CA-2/CA-19 voltar para a etapa duplicou tarefa';
    end if;

    -- CA-3: tarefa já liberada pelo evento do certame (#252) + etapa = uma instância, com as duas origens
    select * into v_res from public.tarefas_equipe_liberar(v_t, v_l1, null, 'ATA_HABILITACAO', v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_agu, null, v_u);
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1 and origem = 'catalogo'
                group by tarefa_codigo having count(*) > 1)
       or not exists (select 1 from public.tarefas_equipe
                       where tenant_id = v_t and licitacao_id = v_l1 and tarefa_codigo = '14133-F05-T03'
                         and liberada_por_evento = 'ATA_HABILITACAO' and origem_etapa_nome = 'Aguardando resultado') then
      raise exception 'CHECK FALHOU: CA-3 evento + etapa não ficaram numa instância com as duas origens';
    end if;

    -- CA-6: tarefas de Documentação continuam abertas depois de mover para Disputa
    perform public.pipeline_mover(v_t, array[v_l1], v_dis, null, v_u);
    if exists (select 1 from public.tarefas_equipe
                where tenant_id = v_t and licitacao_id = v_l1 and origem_etapa_nome = 'Documentação' and status <> 'aberta') then
      raise exception 'CHECK FALHOU: CA-6 sair da etapa fechou tarefa';
    end if;

    -- CA-7: regulamento sem catálogo (RCA) -> só tarefas da empresa
    perform public.pipeline_mover(v_t, array[v_l3], v_ana, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l3], v_doc, null, v_u);
    if exists (select 1 from public.tarefas_equipe where licitacao_id = v_l3 and origem = 'catalogo')
       or (select count(*) from public.tarefas_equipe where licitacao_id = v_l3 and origem = 'empresa') <> 3 then
      raise exception 'CHECK FALHOU: CA-7 RCA criou tarefa do catálogo (ou não criou as da empresa)';
    end if;
    select * into v_res from public.pipeline_etapa_tarefas_criar(v_t, v_l3, v_doc, v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo' then
      raise exception 'CHECK FALHOU: CA-21 RCA deveria dar regulamento_sem_catalogo (%)', v_res;
    end if;

    -- CA-12: mover na empresa 1 não cria nada na empresa 2; etapa de outra empresa é recusada
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t2) then
      raise exception 'CHECK FALHOU: CA-12 tarefa criada para outra empresa';
    end if;
    select * into v_res from public.pipeline_etapa_tarefas_criar(v_t2, v_l1, v_doc, v_u);
    if v_res.bloqueio is distinct from 'etapa_inexistente' or exists (select 1 from public.tarefas_equipe where tenant_id = v_t2) then
      raise exception 'CHECK FALHOU: CA-12 criar com etapa de outra empresa gravou (%)', v_res;
    end if;

    -- CA-21: regulamento nulo -> só empresa, com bloqueio informado
    perform public.pipeline_mover(v_t, array[v_l2], v_tri, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l2], v_doc, null, v_u);
    -- a empresa 2 também acompanha v_l2 (Documentação dela)
    perform public.pipeline_mover(v_t2, array[v_l2], (select id from public.pipeline_etapas
                                                       where tenant_id = v_t2 and nome = 'Documentação'), null, v_u);
    if exists (select 1 from public.tarefas_equipe where licitacao_id = v_l2 and origem = 'catalogo')
       or (select count(*) from public.tarefas_equipe where licitacao_id = v_l2 and origem = 'empresa') <> 2 then
      raise exception 'CHECK FALHOU: CA-21 regulamento nulo criou tarefa do catálogo';
    end if;
    select * into v_res from public.pipeline_etapa_tarefas_criar(v_t, v_l2, v_doc, v_u);
    if v_res.bloqueio is distinct from 'regulamento_nao_informado' then
      raise exception 'CHECK FALHOU: CA-21 bloqueio deveria ser regulamento_nao_informado (%)', v_res;
    end if;

    -- CA-22: o regulamento chega (update) -> o gatilho cria as tarefas da lei das etapas visitadas, sem duplicar
    update public.licitacoes_externas set regulamento = 'LEI_14133' where id = v_l2;
    if (select count(*) from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l2 and origem = 'catalogo' and origem_etapa_nome = 'Documentação') <> 6 then
      raise exception 'CHECK FALHOU: CA-22 regulamento que chegou não criou as tarefas da lei';
    end if;
    -- CA-12 + CA-22: cada empresa recebeu só as tarefas dos próprios modelos e etapas
    if (select count(*) from public.tarefas_equipe where tenant_id = v_t2 and licitacao_id = v_l2 and origem = 'catalogo') <> 6
       or exists (select 1 from public.tarefas_equipe te
                    join public.pipeline_etapas e on e.id = te.origem_etapa_id
                   where te.licitacao_id = v_l2 and e.tenant_id <> te.tenant_id)
       or exists (select 1 from public.tarefas_equipe te
                    join public.pipeline_etapa_tarefas m on m.id = te.origem_modelo_id
                   where te.licitacao_id = v_l2 and m.tenant_id <> te.tenant_id) then
      raise exception 'CHECK FALHOU: CA-12/CA-22 tarefa ligada a etapa ou modelo de outra empresa';
    end if;
    -- empresa desativada não recebe tarefa nova pelo gatilho de regulamento
    update public.tenants set ativo = false where id = v_t2;
    update public.licitacoes_externas set regulamento = null where id = v_l3;
    perform public.pipeline_mover(v_t2, array[v_l3], (select id from public.pipeline_etapas
                                                       where tenant_id = v_t2 and nome = 'Qualificação'), null, v_u);
    update public.licitacoes_externas set regulamento = 'LEI_14133' where id = v_l3;
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t2 and licitacao_id = v_l3 and origem = 'catalogo') then
      raise exception 'CHECK FALHOU: empresa desativada recebeu tarefa pelo gatilho de regulamento';
    end if;
    update public.tenants set ativo = true where id = v_t2;

    select * into v_res from public.pipeline_tarefas_reaplicar(v_t, v_l2, null);
    if v_res.criadas <> 0 then
      raise exception 'CHECK FALHOU: CA-22 reaplicar de novo duplicou (%)', v_res;
    end if;
    -- fora do pipeline, reaplicar não cria nada (Codex #327)
    select * into v_res from public.pipeline_tarefas_reaplicar(v_t2, v_l1, null);
    if v_res.bloqueio is distinct from 'fora_do_pipeline' or exists (select 1 from public.tarefas_equipe
                                                                     where tenant_id = v_t2 and licitacao_id = v_l1) then
      raise exception 'CHECK FALHOU: reaplicar fora do pipeline criou tarefa (%)', v_res;
    end if;

    -- CA-20: excluir etapa com tarefas (do catálogo só pela etapa, e da empresa) funciona e preserva o retrato;
    -- os cards movidos recebem as tarefas do destino
    perform public.pipeline_etapa_excluir(v_t, v_doc, v_ana, v_u);
    if exists (select 1 from public.pipeline_etapas where id = v_doc)
       or not exists (select 1 from public.tarefas_equipe
                       where tenant_id = v_t and licitacao_id = v_l2 and origem = 'catalogo' and origem_etapa_id is null
                         and origem_etapa_nome = 'Documentação' and status = 'aberta')
       or (select count(*) from public.tarefas_equipe
            where tenant_id = v_t and licitacao_id = v_l2 and origem = 'empresa' and origem_etapa_nome = 'Em análise') <> 3 then
      raise exception 'CHECK FALHOU: CA-20 excluir etapa perdeu tarefa/retrato ou não criou as do destino';
    end if;

    if (select md5(string_agg(t::text, '|' order by t.codigo)) from public.tarefas_catalogo t) <> v_hash then
      raise exception 'CHECK FALHOU: tarefas_catalogo mudou';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_etapa_tarefas regras ok (desfeitas)';
end
$$;
