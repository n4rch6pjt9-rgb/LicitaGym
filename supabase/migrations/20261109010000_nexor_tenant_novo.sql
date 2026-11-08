-- Nexor, Fase 0 (spec 0042): tenant novo nasce com as 14 etapas e as tarefas Nexor.
--
-- Por quê: o gatilho de tenant novo semeia as 13 etapas da Konnen e tarefas da 14.133. As 14 etapas NX
-- (processo_fases, norma 'NX') e os 23 modelos NX (PR #467) não chegam a nenhum tenant, e as 10 tarefas-apelido
-- (NX-T02, T05, T13, T14, T16, T17, T18, T19, T22, T24) não têm etapa NX.
--
-- O que muda:
--   pipeline_etapas.fase_codigo           etapa NX aponta para A01…R14 (FK processo_fases); etapas existentes = null.
--   public.nexor_etapa_tarefas_padrao     tarefas padrão por etapa NX, gerada da planilha (Pipeline_Etapas +
--                                         Tarefas_Default) por scripts/import-spec.ts --bloco=etapa-tarefas.
--   pipeline_semear_etapas_nx/_tarefas_nx semente NX; o gatilho de tenant novo passa a usá-las.
--   pipeline_etapa_tarefas_criar          tarefa de catálogo com prazo_horas_apos_etapa nasce com prazo calculado;
--                                         com responsavel_padrao nasce com esse responsável (agente inativo → admin);
--                                         modelo NX nasce em qualquer regulamento informado (os da 14.133 seguem só
--                                         14.133/14.981). Modelo sem esses campos (14.133, Konnen) segue igual.
--
-- Quem lê e escreve: escrita só por migration; leitura service_role (api-pipeline). Tenants existentes (Konnen) não
-- mudam: as funções antigas continuam lá e nada é reaplicado nelas.
--
-- Verificar: supabase/tests/nexor_tenant_novo_check.sql; tests/supabase/scripts/import_spec_test.ts (bloco gerado).
-- Idempotente.

begin;

-- 1) Etapa → fase NX ------------------------------------------------------------------------------------------------
alter table public.pipeline_etapas
  add column if not exists fase_codigo text;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pipeline_etapas'::regclass and conname = 'pipeline_etapas_fase_codigo_fkey') then
    alter table public.pipeline_etapas add constraint pipeline_etapas_fase_codigo_fkey
      foreign key (fase_codigo) references public.processo_fases (codigo) on delete restrict;
  end if;
end $$;

create index if not exists pipeline_etapas_fase_codigo_idx on public.pipeline_etapas (fase_codigo)
  where fase_codigo is not null;

comment on column public.pipeline_etapas.fase_codigo is
  'Etapa NX (processo_fases, norma NX) que esta etapa do tenant representa. null nas etapas criadas antes da spec 0042 '
  '(Konnen) e nas criadas à mão pelo admin.';

-- 2) Tarefas padrão por etapa NX (gerada da planilha) ---------------------------------------------------------------
create table if not exists public.nexor_etapa_tarefas_padrao (
  etapa_codigo  text not null references public.processo_fases (codigo) on delete restrict,
  tarefa_codigo text not null references public.tarefas_catalogo (codigo) on delete restrict,
  apelido       text not null check (apelido ~ '^NX-T[0-9]{2}$'),
  ordem         integer not null check (ordem > 0),
  primary key (etapa_codigo, tarefa_codigo)
);
create index if not exists nexor_etapa_tarefas_padrao_tarefa_idx on public.nexor_etapa_tarefas_padrao (tarefa_codigo);

comment on table public.nexor_etapa_tarefas_padrao is
  'Tarefas que nascem em cada etapa NX do tenant novo (specs/nexor_spec.xlsx, Pipeline_Etapas + Tarefas_Default). '
  'tarefa_codigo é o modelo NX ou, nos apelidos, o modelo da 14.133 do de-para aprovado. Escrita só por migration.';

alter table public.nexor_etapa_tarefas_padrao enable row level security;
revoke all on table public.nexor_etapa_tarefas_padrao from anon, authenticated, service_role, public;
grant select on table public.nexor_etapa_tarefas_padrao to service_role;

-- >>> gerado por scripts/import-spec.ts --bloco=etapa-tarefas: não editar à mão
insert into public.nexor_etapa_tarefas_padrao (etapa_codigo, tarefa_codigo, apelido, ordem) values
  ('A01', 'NX.GEN.A01.DAT.001-2', 'NX-T01', 10),
  ('A01', '14133-F01-T01', 'NX-T02', 20),
  ('A01', 'NX.GEN.A01.DAT.003-8', 'NX-T03', 30),
  ('A01', 'NX.GEN.A01.DAT.027-4', 'NX-T27', 40),
  ('A02', 'NX.GEN.A02.PAR.004-2', 'NX-T04', 10),
  ('A02', '14133-F01-T04', 'NX-T05', 20),
  ('A03', 'NX.GEN.A03.PAR.006-8', 'NX-T06', 10),
  ('A03', 'NX.GEN.A03.OBJ.007-5', 'NX-T07', 20),
  ('A03', 'NX.GEN.A03.PAR.008-4', 'NX-T08', 30),
  ('A03', 'NX.GEN.A03.VAL.029-4', 'NX-T29', 40),
  ('A04', 'NX.GEN.A04.GER.010-1', 'NX-T10', 10),
  ('A04', 'NX.GEN.A04.EXE.030-6', 'NX-T30', 20),
  ('A04', 'NX.GEN.A04.EXE.031-4', 'NX-T31', 30),
  ('P05', 'NX.GEN.P05.HJU.009-5', 'NX-T09', 10),
  ('P06', 'NX.GEN.P06.JUL.011-9', 'NX-T11', 10),
  ('P06', 'NX.GEN.P06.EXE.012-8', 'NX-T12', 20),
  ('P06', '14133-F01-T10', 'NX-T13', 30),
  ('P06', 'NX.GEN.P06.EXE.032-2', 'NX-T32', 40),
  ('P07', '14133-F01-T09', 'NX-T14', 10),
  ('P07', 'NX.GEN.P07.AMO.015-1', 'NX-T15', 20),
  ('S09', '14133-F02-T04', 'NX-T17', 10),
  ('S10', '14133-F04-T01', 'NX-T16', 10),
  ('S11', '14133-F05-T01', 'NX-T18', 10),
  ('S11', '14133-F05-T02', 'NX-T18', 11),
  ('R12', 'NX.GEN.R12.CTR.020-0', 'NX-T20', 10),
  ('R12', 'NX.GEN.R12.SAN.021-7', 'NX-T21', 20),
  ('R12', '14133-F08-T01', 'NX-T22', 30),
  ('R12', 'NX.GEN.R12.EXE.023-8', 'NX-T23', 40),
  ('R12', '14133-F12-T02', 'NX-T24', 50),
  ('R12', 'NX.GEN.R12.GER.025-3', 'NX-T25', 60),
  ('R12', 'NX.GEN.R12.EXE.028-8', 'NX-T28', 70),
  ('R12', 'NX.GEN.R12.CTR.033-1', 'NX-T33', 80),
  ('R13', '14133-F06-T04', 'NX-T19', 10),
  ('R14', 'NX.GEN.R14.GER.026-1', 'NX-T26', 10)
on conflict (etapa_codigo, tarefa_codigo) do update set apelido = excluded.apelido, ordem = excluded.ordem;
-- <<< fim do bloco gerado (tarefas padrão por etapa NX)


-- 3) Semente NX do tenant novo --------------------------------------------------------------------------------------
-- Grupo da etapa NX (letra do código) → fase do Kanban: A Análise → prospeccao, P Preparação → proposta, S Sessão
-- pública → disputa, R Resultado → conclusao. Desfecho e motivo vêm da Pipeline_Etapas: R12 Ata e execução (homologação
-- a favor) = vencida, R13 Perdida = perdida, R14 Descartada = descartada, "exige motivo".
create or replace function public.pipeline_semear_etapas_nx(p_tenant bigint)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with ins as (
    insert into public.pipeline_etapas (tenant_id, nome, fase, ordem, desfecho, exige_motivo, padrao, fase_codigo)
    select p_tenant, f.nome,
           case left(f.codigo, 1) when 'A' then 'prospeccao' when 'P' then 'proposta'
                                  when 'S' then 'disputa' when 'R' then 'conclusao' end,
           f.ordem * 10,
           case f.codigo when 'R12' then 'vencida' when 'R13' then 'perdida' when 'R14' then 'descartada' end,
           f.codigo = 'R14',
           true,
           f.codigo
      from public.processo_fases f
     where f.norma = 'NX'
    on conflict on constraint pipeline_etapas_tenant_nome_key do nothing
    returning 1
  )
  select count(*)::integer from ins
$$;
comment on function public.pipeline_semear_etapas_nx(bigint) is
  'Spec 0042: as 14 etapas NX (processo_fases, norma NX) no tenant. on conflict do nothing: não desfaz edição do admin.';

create or replace function public.pipeline_semear_tarefas_nx(p_tenant bigint)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with ins as (
    insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, tarefa_codigo, ordem)
    select p_tenant, e.id, 'catalogo', n.tarefa_codigo, n.ordem
      from public.nexor_etapa_tarefas_padrao n
      join public.pipeline_etapas e on e.tenant_id = p_tenant and e.fase_codigo = n.etapa_codigo
      join public.tarefas_catalogo tc on tc.codigo = n.tarefa_codigo and tc.ativo
    on conflict (etapa_id, tarefa_codigo) where origem = 'catalogo' do nothing
    returning 1
  )
  select count(*)::integer from ins
$$;
comment on function public.pipeline_semear_tarefas_nx(bigint) is
  'Spec 0042: tarefas padrão de cada etapa NX (nexor_etapa_tarefas_padrao). Reaplicar não duplica nem desfaz edição.';

-- O gatilho de tenant novo passa a semear NX. As funções da semente antiga ficam (a Konnen já foi semeada).
create or replace function public.pipeline_semear_etapas_trg()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Semente antiga (13 etapas + tarefas da 14.133) só quando a sessão pede explicitamente: os checks SQL do modelo da
  -- Konnen usam isso. A api-tenant (PostgREST) não define essa configuração, então tenant criado pelo app nasce NX.
  -- Nunca pôr nexor.semente_pipeline em ALTER DATABASE/ROLE ... SET: todo tenant novo voltaria ao modelo antigo.
  if current_setting('nexor.semente_pipeline', true) = 'lei14133' then
    perform public.pipeline_semear_etapas(new.id);
    perform public.pipeline_semear_tarefas(new.id);
  else
    perform public.pipeline_semear_etapas_nx(new.id);
    perform public.pipeline_semear_tarefas_nx(new.id);
  end if;
  return new;
end
$$;

-- 4) Responsável de tarefa de catálogo a partir do modelo -----------------------------------------------------------
-- responsavel_padrao (só modelos NX): 'papel:<admin|operacao>' ou 'agente:<nome>', combinável com ' + '. Vale o
-- primeiro. agente:precos → preco (código de agentes_catalogo). Agente inexistente ou inativo → papel admin (R-14).
create or replace function public.tarefa_responsavel_do_modelo(p_padrao text)
returns table (responsavel_tipo text, responsavel_papel text, responsavel_agente text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with primeiro as (
    select split_part(btrim(split_part(coalesce(p_padrao, ''), '+', 1)), ':', 1) as tipo,
           split_part(btrim(split_part(coalesce(p_padrao, ''), '+', 1)), ':', 2) as valor
  ),
  agente as (
    select a.codigo
      from primeiro p
      join public.agentes_catalogo a
        on a.ativo and a.codigo = case p.valor when 'precos' then 'preco' else p.valor end
     where p.tipo = 'agente'
  )
  select case when exists (select 1 from agente) then 'agente' else 'papel' end,
         case when p.tipo = 'papel' and p.valor in ('admin', 'operacao') then p.valor else 'admin' end,
         (select codigo from agente)
    from primeiro p
$$;
comment on function public.tarefa_responsavel_do_modelo(text) is
  'Spec 0042: responsável de uma tarefa de catálogo pelo responsavel_padrao do modelo. Sem padrão: papel admin (regra '
  'de antes). Agente inativo ou desconhecido: papel admin, nunca responsável inválido.';

-- 5) Criar as tarefas da etapa: prazo e responsável do modelo NX; NX em qualquer regulamento informado -------------
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
  v_so_nx       boolean := false;
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
    -- Spec 0042: modelo NX é genérico e nasce em qualquer regulamento informado; o da 14.133 não.
    v_so_nx := true;
    -- O aviso continua como antes (estado final da pendência), salvo na etapa que só tem modelo NX: ali nada
    -- deixou de nascer.
    if exists (select 1 from public.pipeline_etapa_tarefas m
                 join public.tarefas_catalogo c on c.codigo = m.tarefa_codigo
                where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
                  and c.norma <> 'NX')
       or not exists (select 1 from public.pipeline_etapa_tarefas m
                        join public.tarefas_catalogo c on c.codigo = m.tarefa_codigo
                       where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
                         and c.norma = 'NX') then
      v_bloqueio := 'regulamento_sem_catalogo';
    end if;
  end if;

  if v_bloqueio is null or v_so_nx then
    v_contexto := public.tarefas_contexto_certame(p_licitacao);
    with modelo as (
      select m.id as modelo_id, m.tarefa_codigo, m.ativo
        from public.pipeline_etapa_tarefas m
       where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo'
    ),
    alvo as (
      select distinct on (c.codigo) c.codigo, c.prazo_unidade, c.condicao, c.prazo_horas_apos_etapa,
             c.responsavel_padrao, coalesce(mo.modelo_id, mp.modelo_id) as modelo_id
        from public.tarefas_catalogo c
        left join modelo mo on mo.tarefa_codigo = c.codigo and mo.ativo
        left join modelo mp on mp.tarefa_codigo = c.parent_codigo and mp.ativo
       where c.ativo
         and (not v_so_nx or c.norma = 'NX')
         and (mo.tarefa_codigo is not null or mp.tarefa_codigo is not null)
         -- filha desligada no modelo desta etapa não nasce pela mãe
         and not exists (select 1 from modelo off where off.tarefa_codigo = c.codigo and not off.ativo)
       order by c.codigo
    ),
    avaliado as (
      select a.*, public.catalogo_condicao_avaliar(a.condicao, v_contexto) as aplicavel,
             r.responsavel_tipo, r.responsavel_papel, r.responsavel_agente
        from alvo a
        cross join lateral public.tarefa_responsavel_do_modelo(a.responsavel_padrao) r
    ),
    gravadas as (
      insert into public.tarefas_equipe as te (
        tenant_id, licitacao_id, origem, tarefa_codigo, condicao_verificada, contexto, prazo_situacao, prazo_em,
        responsavel_papel, responsavel_tipo, responsavel_agente,
        criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome
      )
      select p_tenant, p_licitacao, 'catalogo', v.codigo, v.aplicavel, v_contexto,
             -- Spec 0042: SLA interno do modelo NX conta da entrada na etapa; sem ele, a regra de antes.
             case when v.prazo_horas_apos_etapa is not null then 'calculado'
                  else public.tarefas_prazo_situacao(v.prazo_unidade) end,
             case when v.prazo_horas_apos_etapa is not null
                  then v_desde + make_interval(hours => v.prazo_horas_apos_etapa) end,
             v.responsavel_papel, v.responsavel_tipo, v.responsavel_agente,
             p_user, p_user, p_etapa, v.modelo_id, v_etapa_nome
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
       and (not v_so_nx or c.norma = 'NX')
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

-- 6) Empresa reativada (antes: sempre a semente antiga) -------------------------------------------------------------
-- Sem etapa: recebe a mesma semente de uma empresa nova (NX, salvo nexor.semente_pipeline = 'lei14133'). Com etapa NX:
-- as tarefas padrão NX. Sem etapa NX (Konnen): a semente antiga, como antes. A antiga casa etapa pelo nome e, numa
-- empresa NX, poria tarefas da Konnen em "Triagem" e "Perdida" (mesmo nome nas duas sementes).
create or replace function public.tenants_reativada_semear()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.pipeline_etapas e where e.tenant_id = new.id) then
    if current_setting('nexor.semente_pipeline', true) = 'lei14133' then
      perform public.pipeline_semear_etapas(new.id);
    else
      perform public.pipeline_semear_etapas_nx(new.id);
    end if;
  end if;
  if exists (select 1 from public.pipeline_etapas e where e.tenant_id = new.id and e.fase_codigo is not null) then
    perform public.pipeline_semear_tarefas_nx(new.id);
  else
    perform public.pipeline_semear_tarefas(new.id);
  end if;
  -- cards que ficaram em Triagem enquanto a empresa estava inativa ganham pedido de preparação (mesma regra do
  -- backfill da 20261011160000; um pedido aberto por empresa e licitação)
  insert into private.job_queue (job_type, payload)
  select 'preparar_triagem', jsonb_build_object('tenant_id', po.tenant_id::text, 'licitacao_id', po.licitacao_id::text,
                                                'fonte', l.fonte)
    from public.pipeline_oportunidades po
    join public.pipeline_etapas e on e.id = po.etapa_id and e.tenant_id = po.tenant_id and lower(btrim(e.nome)) = 'triagem'
    left join public.licitacoes_externas l on l.id = po.licitacao_id
   where po.tenant_id = new.id
  on conflict ((payload ->> 'tenant_id'), (payload ->> 'licitacao_id'))
    where job_type = 'preparar_triagem' and status in ('pending', 'processing')
  do nothing;
  return null;
end;
$$;
comment on function public.tenants_reativada_semear() is
  'Empresa reativada: sem etapa recebe a semente de empresa nova (NX); com etapa NX, as tarefas padrão NX; sem etapa '
  'NX, o modelo antigo nas etapas que existem (spec 0018). Não recria etapa excluída. Spec 0042.';
revoke all on function public.tenants_reativada_semear() from public, anon, authenticated;

revoke execute on function public.pipeline_semear_etapas_nx(bigint) from public, anon, authenticated;
revoke execute on function public.pipeline_semear_tarefas_nx(bigint) from public, anon, authenticated;
revoke execute on function public.tarefa_responsavel_do_modelo(text) from public, anon, authenticated;
revoke execute on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.pipeline_semear_etapas_nx(bigint) to service_role;
grant execute on function public.pipeline_semear_tarefas_nx(bigint) to service_role;
grant execute on function public.tarefa_responsavel_do_modelo(text) to service_role;
grant execute on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) to service_role;

commit;
