-- LicitaGym: responsável da tarefa pode ser papel, usuário da empresa ou agente (spec 0035, K-11, K-13, K-14,
-- R-12 a R-14 e R-16).
--
-- Por quê (Marcelo, 21/10): a criação de tarefas considera o responsável — usuários cadastrados e agentes, com o nome
-- da API de execução — para servir a agentes em outras etapas. O agente vem de public.agentes_catalogo.
--
-- O que muda:
--   public.pipeline_etapa_tarefas  (modelo) origem nova 'agente'; colunas responsavel_tipo/papel/user_id/agente;
--                                  um agente por etapa (índice parcial); chave da tarefa de agente única na empresa.
--   public.tarefas_equipe          (instância) colunas responsavel_tipo e responsavel_agente; unique (tenant_id, id)
--                                  para a FK de agente_execucoes.tarefa_id (migration seguinte).
--   pipeline_etapa_tarefas_criar   cria também as tarefas de agente (origem 'empresa' na instância, fora da trava de
--                                  regulamento) e copia o responsável do modelo; agente inativo ou membro que saiu
--                                  da empresa cai em papel admin.
--   pipeline_etapa_tarefas_salvar  aceita responsável papel/usuário (usuário só se membro ativo da empresa); não toca
--                                  linha de agente.
--   pipeline_etapa_tarefas_agentes_salvar (nova) salva a lista de agentes da etapa: um por agente ativo do catálogo,
--                                  chave 'agt-' + 8 hex; o que sai da lista é desligado, nunca apagado.
-- Constraints de check só ampliam (drop/add guardado por pg_get_constraintdef), numa transação com lock_timeout.
-- Quem chama: só service_role. Aditiva e idempotente. O merge na main aplica em produção.
-- Verificação: supabase/tests/tarefas_responsavel_agente_check.sql.

begin;

set local lock_timeout = '5s';

-- 1) Modelo ------------------------------------------------------------------------------------------------------
alter table public.pipeline_etapa_tarefas
  add column if not exists responsavel_tipo    text not null default 'papel',
  add column if not exists responsavel_papel   text,
  add column if not exists responsavel_user_id uuid,
  add column if not exists responsavel_agente  text;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pipeline_etapa_tarefas'::regclass and conname = 'pipeline_etapa_tarefas_origem_chk'
                    and pg_get_constraintdef(oid) like '%agente%') then
    alter table public.pipeline_etapa_tarefas drop constraint if exists pipeline_etapa_tarefas_origem_chk;
    alter table public.pipeline_etapa_tarefas add constraint pipeline_etapa_tarefas_origem_chk check (
      (origem = 'catalogo' and tarefa_codigo is not null and chave is null and titulo is null and prazo_horas is null)
      or (origem = 'empresa' and tarefa_codigo is null and nullif(btrim(chave), '') is not null
          and nullif(btrim(titulo), '') is not null)
      or (origem = 'agente' and tarefa_codigo is null and nullif(btrim(chave), '') is not null
          and nullif(btrim(titulo), '') is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pipeline_etapa_tarefas_responsavel_chk') then
    -- usuario sem user_id é permitido: o membro saiu da empresa (FK set null) e a tarefa nasce em papel admin.
    alter table public.pipeline_etapa_tarefas add constraint pipeline_etapa_tarefas_responsavel_chk check (
      responsavel_tipo in ('papel', 'usuario', 'agente')
      and (responsavel_papel is null or responsavel_papel in ('admin', 'operacao'))
      and ((responsavel_tipo = 'agente') = (origem = 'agente'))
      and ((responsavel_tipo = 'agente') = (responsavel_agente is not null))
      and (responsavel_tipo = 'usuario' or responsavel_user_id is null)
      and (responsavel_tipo = 'papel' or responsavel_papel is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pipeline_etapa_tarefas_responsavel_user_fkey') then
    alter table public.pipeline_etapa_tarefas add constraint pipeline_etapa_tarefas_responsavel_user_fkey
      foreign key (tenant_id, responsavel_user_id) references public.tenant_membros (tenant_id, user_id)
      on delete set null (responsavel_user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pipeline_etapa_tarefas_responsavel_agente_fkey') then
    alter table public.pipeline_etapa_tarefas add constraint pipeline_etapa_tarefas_responsavel_agente_fkey
      foreign key (responsavel_agente) references public.agentes_catalogo (codigo) on delete restrict;
  end if;
end $$;

create unique index if not exists pipeline_etapa_tarefas_agente_uq
  on public.pipeline_etapa_tarefas (tenant_id, etapa_id, responsavel_agente) where origem = 'agente';
create unique index if not exists pipeline_etapa_tarefas_agente_chave_uq
  on public.pipeline_etapa_tarefas (tenant_id, chave) where origem = 'agente';
create index if not exists pipeline_etapa_tarefas_responsavel_user_idx
  on public.pipeline_etapa_tarefas (tenant_id, responsavel_user_id) where responsavel_user_id is not null;

comment on column public.pipeline_etapa_tarefas.responsavel_tipo is
  'papel (fila admin/operação), usuario (membro da empresa) ou agente (só origem agente). Spec 0035.';
comment on column public.pipeline_etapa_tarefas.responsavel_agente is
  'Código em agentes_catalogo (só origem agente). Agente inativo: a tarefa nasce em papel admin.';

-- 2) Instância ---------------------------------------------------------------------------------------------------
alter table public.tarefas_equipe
  add column if not exists responsavel_tipo   text not null default 'papel',
  add column if not exists responsavel_agente text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_responsavel_tipo_chk') then
    -- só a regra do agente: linhas de hoje com papel + responsavel_user_id continuam válidas
    alter table public.tarefas_equipe add constraint tarefas_equipe_responsavel_tipo_chk check (
      responsavel_tipo in ('papel', 'usuario', 'agente')
      and ((responsavel_tipo = 'agente') = (responsavel_agente is not null))
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_responsavel_agente_fkey') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_responsavel_agente_fkey
      foreign key (responsavel_agente) references public.agentes_catalogo (codigo) on delete restrict;
  end if;
end $$;

create unique index if not exists tarefas_equipe_tenant_id_uq on public.tarefas_equipe (tenant_id, id);
create index if not exists tarefas_equipe_agente_idx
  on public.tarefas_equipe (tenant_id, licitacao_id, responsavel_agente) where responsavel_tipo = 'agente';

comment on column public.tarefas_equipe.responsavel_tipo is
  'papel, usuario ou agente (spec 0035). Tarefa de agente: status muda só pela revisão da análise (api-agentes).';

-- 3) Criar: tarefas de agente e responsável do modelo -------------------------------------------------------------
create or replace function public.pipeline_etapa_tarefas_criar(
  p_tenant      bigint,
  p_licitacao   bigint,
  p_etapa       bigint,
  p_user        uuid default null,
  p_prazo_desde timestamptz default null
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_etapa_nome  text;
  v_regulamento text;
  v_contexto    jsonb;
  v_bloqueio    text;
  v_total       integer := 0;
  v_cat         integer := 0;
  v_emp         integer := 0;
  v_desde       timestamptz := coalesce(p_prazo_desde, now());
begin
  select e.nome into v_etapa_nome from public.pipeline_etapas e where e.id = p_etapa and e.tenant_id = p_tenant;
  if v_etapa_nome is null then
    return query select 0, 0, 'etapa_inexistente'::text;
    return;
  end if;
  if not exists (select 1 from public.pipeline_oportunidades po
                  where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao) then
    return query select 0, 0, 'fora_do_pipeline'::text;
    return;
  end if;

  select l.regulamento into v_regulamento from public.licitacoes_externas l where l.id = p_licitacao;
  if v_regulamento is null then
    v_bloqueio := 'regulamento_nao_informado';
  elsif v_regulamento not in ('LEI_14133', 'LEI_14981') then
    v_bloqueio := 'regulamento_sem_catalogo';
  end if;

  if v_bloqueio is null then
    v_contexto := public.tarefas_contexto_certame(p_licitacao);
    with modelo as (
      select m.id as modelo_id, m.tarefa_codigo, m.ativo
        from public.pipeline_etapa_tarefas m
       where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo'
    ),
    alvo as (
      select distinct on (c.codigo) c.codigo, c.prazo_unidade, c.condicao,
             coalesce(mo.modelo_id, mp.modelo_id) as modelo_id
        from public.tarefas_catalogo c
        left join modelo mo on mo.tarefa_codigo = c.codigo and mo.ativo
        left join modelo mp on mp.tarefa_codigo = c.parent_codigo and mp.ativo
       where c.ativo
         and (mo.tarefa_codigo is not null or mp.tarefa_codigo is not null)
         -- filha desligada no modelo desta etapa não nasce pela mãe
         and not exists (select 1 from modelo off where off.tarefa_codigo = c.codigo and not off.ativo)
       order by c.codigo
    ),
    avaliado as (
      select a.*, public.catalogo_condicao_avaliar(a.condicao, v_contexto) as aplicavel from alvo a
    ),
    gravadas as (
      insert into public.tarefas_equipe as te (
        tenant_id, licitacao_id, origem, tarefa_codigo, condicao_verificada, contexto, prazo_situacao,
        responsavel_papel, criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome
      )
      select p_tenant, p_licitacao, 'catalogo', v.codigo, v.aplicavel, v_contexto,
             public.tarefas_prazo_situacao(v.prazo_unidade), 'admin', p_user, p_user,
             p_etapa, v.modelo_id, v_etapa_nome
        from avaliado v
       where v.aplicavel is distinct from false
      on conflict (tenant_id, licitacao_id, tarefa_codigo) where origem = 'catalogo' do update
         set origem_etapa_id     = coalesce(te.origem_etapa_id, excluded.origem_etapa_id),
             origem_modelo_id    = coalesce(te.origem_modelo_id, excluded.origem_modelo_id),
             origem_etapa_nome   = coalesce(te.origem_etapa_nome, excluded.origem_etapa_nome),
             condicao_verificada = coalesce(te.condicao_verificada, excluded.condicao_verificada),
             contexto            = case when te.condicao_verificada is null and excluded.condicao_verificada
                                        then excluded.contexto else te.contexto end,
             atualizada_por      = coalesce(excluded.atualizada_por, te.atualizada_por),
             atualizada_em       = now()
       where te.origem_etapa_nome is null
          or (te.condicao_verificada is null and excluded.condicao_verificada)
      returning (xmax = 0) as nova
    )
    select count(*) filter (where nova) into v_cat from gravadas;
    select count(*) into v_total
      from public.tarefas_catalogo c
     where c.ativo
       and public.catalogo_condicao_avaliar(c.condicao, v_contexto) is distinct from false
       and exists (select 1 from public.pipeline_etapa_tarefas m
                    where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
                      and m.tarefa_codigo in (c.codigo, c.parent_codigo))
       and not exists (select 1 from public.pipeline_etapa_tarefas m
                        where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo'
                          and not m.ativo and m.tarefa_codigo = c.codigo);
  end if;

  -- Tarefas da empresa e de agente (spec 0035): sempre (qualquer regulamento), uma por chave. Prazo conta de v_desde
  -- (entrada na etapa). O responsável vem do modelo: agente inativo ou membro que saiu da empresa cai em papel admin
  -- (R-14), nunca nasce com responsável inválido. A tarefa de agente nasce origem = 'empresa' (R-13).
  with gravadas as (
    insert into public.tarefas_equipe (
      tenant_id, licitacao_id, origem, titulo, descricao, condicao_verificada, prazo_situacao, prazo_em,
      responsavel_papel, responsavel_tipo, responsavel_user_id, responsavel_agente,
      criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome, origem_modelo_chave
    )
    select p_tenant, p_licitacao, 'empresa', m.titulo, m.descricao, true,
           case when m.prazo_horas is null then 'sem_prazo' else 'calculado' end,
           case when m.prazo_horas is null then null else v_desde + make_interval(hours => m.prazo_horas) end,
           -- usuário: o papel dele na empresa (como tarefa_atribuir); senão o papel do modelo, padrão admin
           case when m.origem = 'empresa' and m.responsavel_tipo = 'usuario' and tm.user_id is not null then tm.papel
                else coalesce(m.responsavel_papel, 'admin') end,
           case when m.origem = 'agente' and ag.codigo is not null then 'agente'
                when m.origem = 'empresa' and m.responsavel_tipo = 'usuario' and tm.user_id is not null then 'usuario'
                else 'papel' end,
           case when m.origem = 'empresa' and m.responsavel_tipo = 'usuario' then tm.user_id end,
           case when m.origem = 'agente' then ag.codigo end,
           p_user, p_user, p_etapa, m.id, v_etapa_nome, m.chave
      from public.pipeline_etapa_tarefas m
      left join public.tenant_membros tm
        on tm.tenant_id = m.tenant_id and tm.user_id = m.responsavel_user_id and tm.ativo
      left join public.agentes_catalogo ag on ag.codigo = m.responsavel_agente and ag.ativo
     where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem in ('empresa', 'agente') and m.ativo
    on conflict (tenant_id, licitacao_id, origem_modelo_chave) where origem = 'empresa' do nothing
    returning 1
  )
  select count(*) into v_emp from gravadas;
  v_total := v_total + (select count(*) from public.pipeline_etapa_tarefas m
                         where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem in ('empresa', 'agente')
                           and m.ativo);

  return query select v_cat + v_emp, v_total - (v_cat + v_emp), v_bloqueio;
end;
$$;
comment on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) is
  'Cria as tarefas do modelo da etapa para a licitação (spec 0018, seção 3). Idempotente. p_prazo_desde = entrada '
  'na etapa (prazo da tarefa da empresa); nulo = now(). bloqueio: regulamento_nao_informado / regulamento_sem_catalogo '
  '(só as da empresa e as de agente nascem), etapa_inexistente, fora_do_pipeline. Spec 0035: copia o responsável do modelo.';

-- 4) Salvar a lista de tarefas da empresa com responsável ---------------------------------------------------------
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
  v_resp   jsonb;
  v_rtipo  text;
  v_rpapel text;
  v_ruser  uuid;
  v_tresp  boolean;
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
      if v_codigo = any (v_codigos) then
        raise exception 'Tarefa % repetida na lista.', v_codigo using errcode = '22023';
      end if;
      if v_codigo is not null and exists (select 1 from public.tarefas_catalogo c where c.codigo = v_codigo and c.ativo) then
        v_codigos := v_codigos || v_codigo;
        insert into public.pipeline_etapa_tarefas as m (tenant_id, etapa_id, origem, tarefa_codigo, ordem, ativo, updated_by)
        values (p_tenant, p_etapa, 'catalogo', v_codigo, v_ordem, true, p_user)
        on conflict (etapa_id, tarefa_codigo) where origem = 'catalogo' do update
           set ordem = excluded.ordem, ativo = true, updated_by = excluded.updated_by, updated_at = now();
      elsif v_codigo is not null and exists (select 1 from public.pipeline_etapa_tarefas m
                                              where m.tenant_id = p_tenant and m.etapa_id = p_etapa
                                                and m.origem = 'catalogo' and m.tarefa_codigo = v_codigo) then
        -- já estava no modelo e o catálogo a desativou: fica, desligada (reenviar a lista não trava a edição)
        v_codigos := v_codigos || v_codigo;
        update public.pipeline_etapa_tarefas m
           set ordem = v_ordem, ativo = false, updated_by = p_user, updated_at = now()
         where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.tarefa_codigo = v_codigo;
      else
        raise exception 'Tarefa % não existe ou não está ativa no catálogo.', coalesce(v_codigo, '(vazia)')
          using errcode = '22023';
      end if;
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
        -- chave nova, conferida contra as da empresa (32 bits podem colidir; a colisão sobrescreveria outra tarefa)
        loop
          v_chave := 'emp-' || substr(md5(random()::text || clock_timestamp()::text || p_tenant::text), 1, 8);
          exit when not exists (select 1 from public.pipeline_etapa_tarefas m
                                 where m.tenant_id = p_tenant and m.origem = 'empresa' and m.chave = v_chave)
                and not (v_chave = any (v_chaves));
        end loop;
      elsif not exists (select 1 from public.pipeline_etapa_tarefas m
                         where m.tenant_id = p_tenant and m.origem = 'empresa' and m.chave = v_chave
                           and m.etapa_id = p_etapa) then
        raise exception 'Chave % não é de uma tarefa desta etapa.', v_chave using errcode = '22023';
      end if;
      if v_chave = any (v_chaves) then
        raise exception 'Tarefa % repetida na lista.', v_chave using errcode = '22023';
      end if;
      v_chaves := v_chaves || v_chave;
      -- Responsável (spec 0035): papel (admin/operação, padrão admin) ou usuário ativo desta empresa.
      v_resp := v_item -> 'responsavel';
      v_rtipo := 'papel'; v_rpapel := null; v_ruser := null;
      -- sem a chave 'responsavel' (front anterior à spec 0035), o responsável já gravado fica como está
      v_tresp := v_item ? 'responsavel';
      if v_resp is not null and jsonb_typeof(v_resp) <> 'null' then
        if jsonb_typeof(v_resp) <> 'object' then
          raise exception 'responsavel deve ser objeto.' using errcode = '22023';
        end if;
        v_rtipo := coalesce(v_resp ->> 'tipo', 'papel');
        if v_rtipo = 'papel' then
          v_rpapel := nullif(btrim(v_resp ->> 'papel'), '');
          if v_rpapel is not null and v_rpapel not in ('admin', 'operacao') then
            raise exception 'Papel do responsável deve ser admin ou operacao.' using errcode = '22023';
          end if;
        elsif v_rtipo = 'usuario' then
          begin
            v_ruser := (v_resp ->> 'user_id')::uuid;
          exception when invalid_text_representation then
            raise exception 'user_id do responsável inválido.' using errcode = '22023';
          end;
          if v_ruser is null or not exists (select 1 from public.tenant_membros tm
                                             where tm.tenant_id = p_tenant and tm.user_id = v_ruser and tm.ativo) then
            raise exception 'Responsável não é membro ativo desta empresa.' using errcode = '22023';
          end if;
        else
          raise exception 'Tipo de responsável deve ser papel ou usuario (agente vai em etapa_tarefas_agentes_salvar).'
            using errcode = '22023';
        end if;
      end if;
      insert into public.pipeline_etapa_tarefas as m
             (tenant_id, etapa_id, origem, chave, titulo, descricao, prazo_horas, ordem, ativo, updated_by,
              responsavel_tipo, responsavel_papel, responsavel_user_id)
      values (p_tenant, p_etapa, 'empresa', v_chave, v_titulo, nullif(btrim(v_item ->> 'descricao'), ''), v_prazo,
              v_ordem, true, p_user, v_rtipo, v_rpapel, v_ruser)
      on conflict (tenant_id, chave) where origem = 'empresa' do update
         set titulo = excluded.titulo, descricao = excluded.descricao, prazo_horas = excluded.prazo_horas,
             ordem = excluded.ordem, ativo = true, updated_by = excluded.updated_by, updated_at = now(),
             responsavel_tipo    = case when v_tresp then excluded.responsavel_tipo else m.responsavel_tipo end,
             responsavel_papel   = case when v_tresp then excluded.responsavel_papel else m.responsavel_papel end,
             responsavel_user_id = case when v_tresp then excluded.responsavel_user_id else m.responsavel_user_id end;
    else
      raise exception 'origem deve ser catalogo ou empresa.' using errcode = '22023';
    end if;
    v_n := v_n + 1;
  end loop;

  -- O que saiu da lista é desligado, nunca apagado. Tarefa de agente não está nesta lista e não é tocada (R-16).
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
  'que saiu (nunca apaga). Spec 0018; responsável papel/usuário na spec 0035 (agente fica fora: '
  'pipeline_etapa_tarefas_agentes_salvar). Só service_role.';

-- 5) Salvar a lista de agentes de uma etapa -----------------------------------------------------------------------
create or replace function public.pipeline_etapa_tarefas_agentes_salvar(
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
  v_item    jsonb;
  v_agente  text;
  v_nome    text;
  v_titulo  text;
  v_prazo   integer;
  v_ordem   integer;
  v_chave   text;
  v_agentes text[] := '{}';
  v_n       integer := 0;
begin
  if p_user is null then
    raise exception 'Usuário obrigatório.' using errcode = '22023';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'A lista de agentes deve ser um array.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));
  if not exists (select 1 from public.pipeline_etapas e where e.id = p_etapa and e.tenant_id = p_tenant) then
    raise exception 'Etapa não encontrada.' using errcode = 'P0002';
  end if;

  for v_item, v_ordem in
    select x.v, 1000 + x.n::integer * 10 from jsonb_array_elements(p_itens) with ordinality as x (v, n)
  loop
    v_agente := nullif(btrim(v_item ->> 'agente'), '');
    select a.nome into v_nome from public.agentes_catalogo a where a.codigo = v_agente and a.ativo;
    if v_nome is null then
      raise exception 'Agente % não existe ou não está ativo.', coalesce(v_agente, '(vazio)') using errcode = '22023';
    end if;
    if v_agente = any (v_agentes) then
      raise exception 'Agente % repetido na lista.', v_agente using errcode = '22023';
    end if;
    v_agentes := v_agentes || v_agente;
    v_titulo := coalesce(nullif(btrim(v_item ->> 'titulo'), ''), v_nome);
    if char_length(v_titulo) > 200 then
      raise exception 'Título com mais de 200 caracteres.' using errcode = '22023';
    end if;
    if v_item ? 'prazo_horas' and jsonb_typeof(v_item -> 'prazo_horas') not in ('number', 'null') then
      raise exception 'prazo_horas deve ser número de horas ou null.' using errcode = '22023';
    end if;
    v_prazo := case when jsonb_typeof(v_item -> 'prazo_horas') = 'number' then (v_item ->> 'prazo_horas')::integer end;

    update public.pipeline_etapa_tarefas m
       set titulo = v_titulo, descricao = nullif(btrim(v_item ->> 'descricao'), ''), prazo_horas = v_prazo,
           ordem = v_ordem, ativo = true, updated_by = p_user, updated_at = now()
     where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'agente' and m.responsavel_agente = v_agente;
    if not found then
      loop
        v_chave := 'agt-' || substr(md5(random()::text || clock_timestamp()::text || p_tenant::text), 1, 8);
        exit when not exists (select 1 from public.pipeline_etapa_tarefas m
                               where m.tenant_id = p_tenant and m.chave = v_chave);
      end loop;
      insert into public.pipeline_etapa_tarefas
             (tenant_id, etapa_id, origem, chave, titulo, descricao, prazo_horas, ordem, ativo, updated_by,
              responsavel_tipo, responsavel_agente)
      values (p_tenant, p_etapa, 'agente', v_chave, v_titulo, nullif(btrim(v_item ->> 'descricao'), ''), v_prazo,
              v_ordem, true, p_user, 'agente', v_agente);
    end if;
    v_n := v_n + 1;
  end loop;

  update public.pipeline_etapa_tarefas m
     set ativo = false, updated_by = p_user, updated_at = now()
   where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'agente' and m.ativo
     and not (m.responsavel_agente = any (v_agentes));
  return v_n;
end;
$$;
comment on function public.pipeline_etapa_tarefas_agentes_salvar(bigint, bigint, jsonb, uuid) is
  'Salva a lista de tarefas de agente de uma etapa (spec 0035): um por agente ativo do catálogo; o que sai da lista '
  'é desligado, nunca apagado. Só service_role (api-pipeline, depois de conferir que o usuário é admin da empresa).';

-- ACL ------------------------------------------------------------------------------------------------------------
revoke all on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_etapa_tarefas_salvar(bigint, bigint, jsonb, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_etapa_tarefas_agentes_salvar(bigint, bigint, jsonb, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) to service_role;
grant execute on function public.pipeline_etapa_tarefas_salvar(bigint, bigint, jsonb, uuid) to service_role;
grant execute on function public.pipeline_etapa_tarefas_agentes_salvar(bigint, bigint, jsonb, uuid) to service_role;

commit;
