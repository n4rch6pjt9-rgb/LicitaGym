-- Pipeline comercial das oportunidades (Dashboard #29), decisões do Marcelo em 04/10/2026:
--   * o pipeline é da EQUIPE: uma etapa por licitação, compartilhada por todos, com tenant_id (o banco ainda não
--     liga usuário a empresa; hoje há um tenant, Konnen) e registro de quem moveu;
--   * as 13 etapas do Kanban são o PADRÃO, mas são configuráveis (criar, renomear, reordenar, excluir) por admin;
--   * o card move direto para qualquer etapa ("Mover para…"), além das setas.
--
-- O que cria:
--   1) pipeline_etapas        etapas por tenant (fase, ordem, desfecho, exige_motivo); as 13 padrão são semeadas
--                             para cada tenant ativo, sem sobrescrever o que o admin editar;
--   2) pipeline_oportunidades a licitação no pipeline: uma linha por (tenant, licitação), etapa atual, motivo;
--   3) pipeline_historico     cada entrada, mudança de etapa e saída (base para taxa de participação/vitória);
--   4) pipeline_mover()       adiciona/move/remove em lote numa transação, gravando o histórico (serializado por
--                             tenant); pipeline_etapa_excluir() exclui etapa vazia, ou move as oportunidades antes;
--                             pipeline_contagem() conta por etapa; pipeline_semear_etapas() + gatilho em tenants.
-- Quem lê e escreve: só service_role (Edge Function api-pipeline; o JWT do usuário identifica e autoriza).
-- Verificação: supabase/tests/pipeline_oportunidades_check.sql.
-- Aditiva: não altera nem apaga dado existente. O merge na main aplica em produção (integração Supabase).

begin;

set local lock_timeout = '10s';

-- 1) Etapas -------------------------------------------------------------------------------------------------------
create table if not exists public.pipeline_etapas (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references public.tenants (id) on delete cascade,
  nome         text not null,
  fase         text not null,
  ordem        integer not null,
  desfecho     text,
  exige_motivo boolean not null default false,
  padrao       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  constraint pipeline_etapas_nome_chk check (char_length(btrim(nome)) between 1 and 60),
  constraint pipeline_etapas_fase_chk check (fase in ('prospeccao', 'proposta', 'disputa', 'conclusao')),
  constraint pipeline_etapas_desfecho_chk check (desfecho is null or desfecho in ('vencida', 'perdida', 'descartada')),
  constraint pipeline_etapas_tenant_nome_key unique (tenant_id, nome),
  constraint pipeline_etapas_tenant_id_key unique (tenant_id, id)
);
create index if not exists pipeline_etapas_tenant_ordem_idx on public.pipeline_etapas (tenant_id, ordem);

comment on table public.pipeline_etapas is
  'Etapas do pipeline comercial por tenant (Dashboard #29). As 13 padrão (padrao = true) são semeadas por migration; '
  'o admin cria, renomeia, reordena e exclui pela api-pipeline. desfecho marca etapas finais (vencida/perdida/descartada).';

-- Semente: as 13 etapas do Kanban. on conflict do nothing: não desfaz edição do admin. A mesma função roda para os
-- tenants que já existem (abaixo) e, por gatilho, para cada tenant criado depois.
create or replace function public.pipeline_semear_etapas(p_tenant bigint)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with ins as (
    insert into public.pipeline_etapas (tenant_id, nome, fase, ordem, desfecho, exige_motivo, padrao)
    select p_tenant, e.nome, e.fase, e.ordem, e.desfecho, e.exige_motivo, true
      from (values
        ('Nova',                 'prospeccao',  10, null::text,  false),
        ('Triagem',              'prospeccao',  20, null,        false),
        ('Em análise',           'prospeccao',  30, null,        false),
        ('Interessante',         'prospeccao',  40, null,        false),
        ('Qualificação',         'proposta',    50, null,        false),
        ('Preparando proposta',  'proposta',    60, null,        false),
        ('Documentação',         'proposta',    70, null,        false),
        ('Proposta enviada',     'disputa',     80, null,        false),
        ('Disputa',              'disputa',     90, null,        false),
        ('Aguardando resultado', 'disputa',    100, null,        false),
        ('Vencida',              'conclusao',  110, 'vencida',   false),
        ('Perdida',              'conclusao',  120, 'perdida',   false),
        ('Descartada',           'conclusao',  130, 'descartada', true)
      ) as e (nome, fase, ordem, desfecho, exige_motivo)
    on conflict on constraint pipeline_etapas_tenant_nome_key do nothing
    returning 1
  )
  select count(*)::integer from ins
$$;

select public.pipeline_semear_etapas(t.id) from public.tenants t where t.ativo;

create or replace function public.pipeline_semear_etapas_trg()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.pipeline_semear_etapas(new.id);
  return new;
end
$$;

drop trigger if exists tenants_pipeline_semear_etapas on public.tenants;
create trigger tenants_pipeline_semear_etapas
  after insert on public.tenants
  for each row execute function public.pipeline_semear_etapas_trg();

-- 2) Oportunidades no pipeline -------------------------------------------------------------------------------------
create table if not exists public.pipeline_oportunidades (
  tenant_id      bigint not null references public.tenants (id) on delete cascade,
  licitacao_id   bigint not null references public.licitacoes_externas (id) on delete cascade,
  etapa_id       bigint not null,
  motivo         text,
  responsavel    uuid,
  adicionada_por uuid not null,
  adicionada_em  timestamptz not null default now(),
  atualizada_por uuid not null,
  atualizada_em  timestamptz not null default now(),
  constraint pipeline_oportunidades_pkey primary key (tenant_id, licitacao_id),
  -- a etapa tem de ser do mesmo tenant; excluir etapa com oportunidades é bloqueado (NO ACTION, checado no fim do
  -- comando: excluir o tenant inteiro ainda cascateia etapas e oportunidades juntas); pipeline_etapa_excluir move antes
  constraint pipeline_oportunidades_etapa_fkey foreign key (tenant_id, etapa_id)
    references public.pipeline_etapas (tenant_id, id),
  constraint pipeline_oportunidades_motivo_chk check (motivo is null or char_length(motivo) <= 500)
);
create index if not exists pipeline_oportunidades_etapa_idx on public.pipeline_oportunidades (tenant_id, etapa_id);
create index if not exists pipeline_oportunidades_licitacao_idx on public.pipeline_oportunidades (licitacao_id);

comment on table public.pipeline_oportunidades is
  'Licitações no pipeline comercial da equipe (Dashboard #29): etapa atual por (tenant, licitação). Escrita só pela '
  'api-pipeline (pipeline_mover), que grava o histórico.';

-- 3) Histórico ----------------------------------------------------------------------------------------------------
create table if not exists public.pipeline_historico (
  id           bigint generated always as identity primary key,
  tenant_id    bigint not null references public.tenants (id) on delete cascade,
  licitacao_id bigint references public.licitacoes_externas (id) on delete set null, -- auditoria fica se a licitação sumir
  etapa_de     bigint,          -- null = entrou no pipeline
  etapa_para   bigint,          -- null = saiu do pipeline
  nome_de      text,            -- nome da etapa na hora (a etapa pode ser renomeada ou excluída depois)
  nome_para    text,
  motivo       text,
  user_id      uuid not null,
  em           timestamptz not null default now()
);
create index if not exists pipeline_historico_licitacao_idx on public.pipeline_historico (tenant_id, licitacao_id, em desc);
create index if not exists pipeline_historico_licitacao_fk_idx on public.pipeline_historico (licitacao_id);

comment on table public.pipeline_historico is
  'Cada entrada, mudança de etapa e saída do pipeline (Dashboard #29), com o nome da etapa na hora. Base para medir '
  'participação e vitória. Só inserção, pela pipeline_mover/pipeline_etapa_excluir.';

-- 4) Funções ------------------------------------------------------------------------------------------------------
-- Uma versão anterior deste arquivo (nunca aplicada) tinha a assinatura de 5 argumentos; garante que não sobra.
drop function if exists public.pipeline_mover(bigint, bigint[], bigint, text, uuid);

-- Adiciona, move ou remove (p_etapa null) várias licitações de uma vez, numa transação, com histórico.
-- Devolve quantas linhas mudaram (mover para a mesma etapa não conta nem gera histórico).
-- p_so_novos = true: só adiciona quem ainda não está no pipeline (não move quem já está), de forma atômica.
-- Serializado por tenant (advisory lock da transação): duas chamadas simultâneas não travam entre si (deadlock) nem
-- gravam histórico a partir de um retrato velho da etapa atual. Volume baixo; o custo é desprezível.
create or replace function public.pipeline_mover(
  p_tenant     bigint,
  p_licitacoes bigint[],
  p_etapa      bigint,
  p_motivo     text,
  p_user       uuid,
  p_so_novos   boolean default false
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_etapa   public.pipeline_etapas%rowtype;
  v_motivo  text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_n       integer := 0;
  r         record;
begin
  if p_user is null then
    raise exception 'pipeline_mover: usuário obrigatório' using errcode = '22023';
  end if;
  if p_licitacoes is null or cardinality(p_licitacoes) = 0 then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));

  if p_etapa is not null then
    select * into v_etapa from public.pipeline_etapas where id = p_etapa and tenant_id = p_tenant;
    if not found then
      raise exception 'pipeline_mover: etapa não encontrada' using errcode = 'P0002';
    end if;
    if v_etapa.exige_motivo and v_motivo is null then
      raise exception 'pipeline_mover: a etapa "%" exige motivo', v_etapa.nome using errcode = '22023';
    end if;
  end if;

  for r in
    select l.id as licitacao_id, po.etapa_id as etapa_atual, ea.nome as nome_atual
      from (select distinct id from unnest(p_licitacoes) as u (id)) u
      join public.licitacoes_externas l on l.id = u.id
      left join public.pipeline_oportunidades po on po.tenant_id = p_tenant and po.licitacao_id = l.id
      left join public.pipeline_etapas ea on ea.id = po.etapa_id
     order by l.id
  loop
    continue when p_so_novos and r.etapa_atual is not null;
    if p_etapa is null then
      continue when r.etapa_atual is null;
      delete from public.pipeline_oportunidades where tenant_id = p_tenant and licitacao_id = r.licitacao_id;
    else
      continue when r.etapa_atual is not distinct from p_etapa;
      insert into public.pipeline_oportunidades as po
             (tenant_id, licitacao_id, etapa_id, motivo, adicionada_por, atualizada_por)
      values (p_tenant, r.licitacao_id, p_etapa, case when v_etapa.exige_motivo then v_motivo end, p_user, p_user)
      on conflict on constraint pipeline_oportunidades_pkey do update
         set etapa_id = excluded.etapa_id, motivo = excluded.motivo,
             atualizada_por = excluded.atualizada_por, atualizada_em = now();
    end if;
    insert into public.pipeline_historico (tenant_id, licitacao_id, etapa_de, etapa_para, nome_de, nome_para, motivo, user_id)
    values (p_tenant, r.licitacao_id, r.etapa_atual, p_etapa, r.nome_atual, v_etapa.nome, v_motivo, p_user);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- Exclui uma etapa. Com oportunidades nela, exige p_mover_para (outra etapa do mesmo tenant) e as move antes,
-- com histórico. Não deixa o tenant sem nenhuma etapa. Devolve quantas oportunidades foram movidas.
create or replace function public.pipeline_etapa_excluir(
  p_tenant     bigint,
  p_etapa      bigint,
  p_mover_para bigint,
  p_user       uuid
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_ids   bigint[];
  v_movidas integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));
  if not exists (select 1 from public.pipeline_etapas where id = p_etapa and tenant_id = p_tenant) then
    raise exception 'pipeline_etapa_excluir: etapa não encontrada' using errcode = 'P0002';
  end if;
  if (select count(*) from public.pipeline_etapas where tenant_id = p_tenant) <= 1 then
    raise exception 'pipeline_etapa_excluir: o pipeline precisa de pelo menos uma etapa' using errcode = '22023';
  end if;
  select array_agg(licitacao_id) into v_ids
    from public.pipeline_oportunidades where tenant_id = p_tenant and etapa_id = p_etapa;
  if v_ids is not null then
    if p_mover_para is null or p_mover_para = p_etapa then
      raise exception 'pipeline_etapa_excluir: a etapa tem % oportunidade(s); informe para qual etapa movê-las', cardinality(v_ids)
        using errcode = '22023';
    end if;
    v_movidas := public.pipeline_mover(p_tenant, v_ids, p_mover_para, 'Etapa excluída', p_user);
  end if;
  delete from public.pipeline_etapas where id = p_etapa and tenant_id = p_tenant;
  return v_movidas;
end
$$;

-- Quantas oportunidades há em cada etapa do tenant (a api conta no banco, sem trazer as linhas).
create or replace function public.pipeline_contagem(p_tenant bigint)
returns table (etapa_id bigint, total bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select po.etapa_id, count(*) from public.pipeline_oportunidades po where po.tenant_id = p_tenant group by po.etapa_id
$$;

-- 5) RLS e ACL (padrão do catálogo: só service_role) --------------------------------------------------------------
alter table public.pipeline_etapas enable row level security;
alter table public.pipeline_oportunidades enable row level security;
alter table public.pipeline_historico enable row level security;

revoke all on table public.pipeline_etapas, public.pipeline_oportunidades, public.pipeline_historico
  from anon, authenticated, PUBLIC;
grant all on table public.pipeline_etapas, public.pipeline_oportunidades, public.pipeline_historico to service_role;
revoke all on sequence public.pipeline_etapas_id_seq, public.pipeline_historico_id_seq from anon, authenticated, PUBLIC;
grant usage, select on sequence public.pipeline_etapas_id_seq, public.pipeline_historico_id_seq to service_role;

revoke execute on function public.pipeline_mover(bigint, bigint[], bigint, text, uuid, boolean) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_etapa_excluir(bigint, bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_contagem(bigint) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_semear_etapas(bigint) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_semear_etapas_trg() from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_mover(bigint, bigint[], bigint, text, uuid, boolean) to service_role;
grant execute on function public.pipeline_etapa_excluir(bigint, bigint, bigint, uuid) to service_role;
grant execute on function public.pipeline_contagem(bigint) to service_role;
grant execute on function public.pipeline_semear_etapas(bigint) to service_role;

commit;
