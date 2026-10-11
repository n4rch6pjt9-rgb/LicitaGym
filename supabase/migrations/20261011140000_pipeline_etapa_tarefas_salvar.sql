-- LicitaGym: salvar o modelo de tarefas de uma etapa numa transação (spec 0018, PR 3: ação etapa_tarefas_salvar da
-- api-pipeline).
--
-- Por quê: a api-pipeline recebe a lista completa da etapa. Upsert por tarefa_codigo/chave mais desligar o que saiu
-- da lista, em várias chamadas REST, não seria atômico, e o PostgREST não usa índice único parcial como alvo de
-- on_conflict. Esta função faz tudo de uma vez.
--
-- Regras (spec 0018, item 1):
--   * upsert por tarefa_codigo (catálogo) ou chave (empresa); o que sai da lista vira ativo = false, nunca é apagado
--     (o id do modelo não muda e as tarefas já criadas não perdem a referência);
--   * tarefa do catálogo precisa existir e estar ativa (o gatilho pipeline_etapa_tarefas_validar confere o ator);
--   * tarefa da empresa sem chave ganha 'emp-' + 8 hex na criação, nunca derivada do título; chave informada tem de
--     ser de um modelo da mesma empresa e da mesma etapa (não "rouba" modelo de outra etapa nem de outra empresa).
-- Quem chama: só service_role (api-pipeline, depois de conferir que o usuário é admin da empresa).
-- Verificar: supabase/tests/pipeline_etapa_tarefas_salvar_check.sql. Idempotente.

begin;

create or replace function public.pipeline_etapa_tarefas_salvar(
  p_tenant bigint,
  p_etapa  bigint,
  p_itens  jsonb,
  p_user   uuid
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item   jsonb;
  v_origem text;
  v_codigo text;
  v_chave  text;
  v_titulo text;
  v_ordem  integer;
  v_prazo  integer;
  v_codigos text[] := '{}';
  v_chaves  text[] := '{}';
  v_n      integer := 0;
begin
  if p_user is null then
    raise exception 'Usuário obrigatório.' using errcode = '22023';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'A lista de tarefas deve ser um array.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));
  if not exists (select 1 from public.pipeline_etapas e where e.id = p_etapa and e.tenant_id = p_tenant) then
    raise exception 'Etapa não encontrada.' using errcode = 'P0002';
  end if;

  for v_item, v_ordem in
    select x.v, x.n::integer * 10 from jsonb_array_elements(p_itens) with ordinality as x (v, n)
  loop
    v_origem := v_item ->> 'origem';
    if v_origem = 'catalogo' then
      v_codigo := nullif(btrim(v_item ->> 'tarefa_codigo'), '');
      if v_codigo is null or not exists (select 1 from public.tarefas_catalogo c where c.codigo = v_codigo and c.ativo) then
        raise exception 'Tarefa % não existe ou não está ativa no catálogo.', coalesce(v_codigo, '(vazia)')
          using errcode = '22023';
      end if;
      if v_codigo = any (v_codigos) then
        raise exception 'Tarefa % repetida na lista.', v_codigo using errcode = '22023';
      end if;
      v_codigos := v_codigos || v_codigo;
      insert into public.pipeline_etapa_tarefas as m (tenant_id, etapa_id, origem, tarefa_codigo, ordem, ativo, updated_by)
      values (p_tenant, p_etapa, 'catalogo', v_codigo, v_ordem, true, p_user)
      on conflict (etapa_id, tarefa_codigo) where origem = 'catalogo' do update
         set ordem = excluded.ordem, ativo = true, updated_by = excluded.updated_by, updated_at = now();
    elsif v_origem = 'empresa' then
      v_titulo := nullif(btrim(v_item ->> 'titulo'), '');
      if v_titulo is null then
        raise exception 'Tarefa da empresa precisa de título.' using errcode = '22023';
      end if;
      v_prazo := case when v_item ? 'prazo_horas' and jsonb_typeof(v_item -> 'prazo_horas') = 'number'
                      then (v_item ->> 'prazo_horas')::integer end;
      if v_item ? 'prazo_horas' and jsonb_typeof(v_item -> 'prazo_horas') not in ('number', 'null') then
        raise exception 'prazo_horas deve ser número de horas ou null.' using errcode = '22023';
      end if;
      v_chave := nullif(btrim(v_item ->> 'chave'), '');
      if v_chave is null then
        v_chave := 'emp-' || substr(md5(random()::text || clock_timestamp()::text || p_tenant::text), 1, 8);
      elsif not exists (select 1 from public.pipeline_etapa_tarefas m
                         where m.tenant_id = p_tenant and m.origem = 'empresa' and m.chave = v_chave
                           and m.etapa_id = p_etapa) then
        raise exception 'Chave % não é de uma tarefa desta etapa.', v_chave using errcode = '22023';
      end if;
      if v_chave = any (v_chaves) then
        raise exception 'Tarefa % repetida na lista.', v_chave using errcode = '22023';
      end if;
      v_chaves := v_chaves || v_chave;
      insert into public.pipeline_etapa_tarefas as m
             (tenant_id, etapa_id, origem, chave, titulo, descricao, prazo_horas, ordem, ativo, updated_by)
      values (p_tenant, p_etapa, 'empresa', v_chave, v_titulo, nullif(btrim(v_item ->> 'descricao'), ''), v_prazo,
              v_ordem, true, p_user)
      on conflict (tenant_id, chave) where origem = 'empresa' do update
         set titulo = excluded.titulo, descricao = excluded.descricao, prazo_horas = excluded.prazo_horas,
             ordem = excluded.ordem, ativo = true, updated_by = excluded.updated_by, updated_at = now();
    else
      raise exception 'origem deve ser catalogo ou empresa.' using errcode = '22023';
    end if;
    v_n := v_n + 1;
  end loop;

  -- O que saiu da lista é desligado, nunca apagado.
  update public.pipeline_etapa_tarefas m
     set ativo = false, updated_by = p_user, updated_at = now()
   where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.ativo
     and ((m.origem = 'catalogo' and not (m.tarefa_codigo = any (v_codigos)))
          or (m.origem = 'empresa' and not (m.chave = any (v_chaves))));
  return v_n;
end;
$$;
comment on function public.pipeline_etapa_tarefas_salvar(bigint, bigint, jsonb, uuid) is
  'Salva o modelo de tarefas de uma etapa (lista completa) numa transação: upsert por tarefa_codigo/chave e desliga o '
  'que saiu (nunca apaga). Spec 0018. Só service_role.';

revoke all on function public.pipeline_etapa_tarefas_salvar(bigint, bigint, jsonb, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_etapa_tarefas_salvar(bigint, bigint, jsonb, uuid) to service_role;

commit;
