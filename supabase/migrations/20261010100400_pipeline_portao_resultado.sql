-- Portão de GO/NO-GO e resultado do próprio cliente no pipeline (planos 5 e 6, 06/10/2026).
--
-- O Kanban continua livre nas 13 etapas padrão (decisão de 04/10: o card move para qualquer etapa).
-- exige_portao nasce false. Quando um admin liga o portão de uma etapa, entrar nela exige decisão
-- humana GO ou GO condicionado. A recomendação não é a decisão e não há coluna de pontuação.
-- No desfecho, pipeline_registrar_resultado grava produto e preço ofertado em centavos, sem apagar
-- o vencedor público que já está em licitacao_resultados.
-- Quem lê e escreve: só service_role. Aditiva. O merge na main aplica em produção.
-- Verificação: supabase/tests/pipeline_portao_resultado_check.sql.

begin;

set local lock_timeout = '10s';

alter table public.pipeline_etapas
  add column if not exists exige_portao boolean not null default false;

comment on column public.pipeline_etapas.exige_portao is
  'Quando true, pipeline_oportunidades só entra nesta etapa se houver decisão humana GO ou GO condicionado. As 13 etapas padrão nascem false.';

alter table public.pipeline_oportunidades
  add column if not exists produto_id bigint references public.catalogo_produtos (id),
  add column if not exists preco_ofertado_centavos bigint,
  add column if not exists motivo_perda text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pipeline_oportunidades_preco_chk') then
    alter table public.pipeline_oportunidades add constraint pipeline_oportunidades_preco_chk
      check (preco_ofertado_centavos is null or preco_ofertado_centavos > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pipeline_oportunidades_motivo_perda_chk') then
    alter table public.pipeline_oportunidades add constraint pipeline_oportunidades_motivo_perda_chk
      check (motivo_perda is null or char_length(motivo_perda) <= 500);
  end if;
end $$;

comment on column public.pipeline_oportunidades.preco_ofertado_centavos is
  'Preço ofertado pelo tenant, em centavos inteiros. Não é o preço homologado do vencedor.';

create table if not exists public.tenant_regras_comerciais (
  tenant_id      bigint primary key references public.tenants (id) on delete cascade,
  margem_min_pct numeric(5, 2),
  regioes        text[] not null default '{}',
  prazo_min_dias integer,
  check (margem_min_pct is null or (margem_min_pct >= 0 and margem_min_pct <= 100)),
  check (prazo_min_dias is null or prazo_min_dias >= 0)
);

comment on table public.tenant_regras_comerciais is
  'Regras comerciais do cliente (margem, regiões, prazo). Não são pontuação. Sigiloso: só service_role.';

create table if not exists public.decisoes_comerciais (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references public.tenants (id) on delete cascade,
  licitacao_id  bigint not null references public.licitacoes_externas (id) on delete cascade,
  decisao       text not null check (decisao in ('go', 'go_condicionado', 'no_go', 'monitorar')),
  motivos       text[] not null,
  recomendacao  text check (recomendacao is null or recomendacao in ('go', 'go_condicionado', 'no_go', 'monitorar')),
  decidido_por  uuid,
  created_at    timestamptz not null default now()
);

create index if not exists decisoes_comerciais_licitacao_idx
  on public.decisoes_comerciais (tenant_id, licitacao_id, created_at desc);

comment on table public.decisoes_comerciais is
  'Decisão humana de participar, separada da recomendação. Não há coluna de score. decidido_por nulo é só recomendação e não abre portão.';

create or replace function public.recomendar_participacao(
  p_eliminatorio_falhou boolean,
  p_lacuna_eliminatoria boolean,
  p_abaixo_do_piso boolean,
  p_prazo_viavel boolean,
  p_documentacao_ok boolean,
  p_edital_aberto boolean
) returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when not coalesce(p_edital_aberto, false) then
      jsonb_build_object('decisao', 'monitorar', 'motivos', jsonb_build_array('Não há oportunidade acionável com prazo de propostas aberto.'))
    when coalesce(p_eliminatorio_falhou, false) or coalesce(p_abaixo_do_piso, false) then
      jsonb_build_object(
        'decisao', 'no_go',
        'motivos', (
          select coalesce(jsonb_agg(m), '[]'::jsonb) from (
            select 'Requisito eliminatório não atendido.' as m where coalesce(p_eliminatorio_falhou, false)
            union all
            select 'Margem mínima do cliente não atingida.' where coalesce(p_abaixo_do_piso, false)
          ) s
        )
      )
    when coalesce(p_lacuna_eliminatoria, false) or not coalesce(p_prazo_viavel, false) or not coalesce(p_documentacao_ok, false) then
      jsonb_build_object(
        'decisao', 'go_condicionado',
        'motivos', (
          select coalesce(jsonb_agg(m), '[]'::jsonb) from (
            select 'Requisito eliminatório sem comprovação.' as m where coalesce(p_lacuna_eliminatoria, false)
            union all
            select 'Prazo logístico não verificado como viável.' where not coalesce(p_prazo_viavel, false)
            union all
            select 'Documentação do cliente não verificada.' where not coalesce(p_documentacao_ok, false)
          ) s
        )
      )
    else
      jsonb_build_object(
        'decisao', 'go',
        'motivos', jsonb_build_array('Nenhum requisito eliminatório falhou e as condições informadas estão cobertas.')
      )
  end
$$;

create or replace function public.pipeline_oportunidades_portao()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_exige boolean;
  v_decisao text;
begin
  select exige_portao into v_exige from public.pipeline_etapas where id = new.etapa_id;
  if coalesce(v_exige, false) then
    select d.decisao into v_decisao
      from public.decisoes_comerciais d
     where d.tenant_id = new.tenant_id
       and d.licitacao_id = new.licitacao_id
       and d.decidido_por is not null
     order by d.created_at desc
     limit 1;
    if v_decisao is null or v_decisao not in ('go', 'go_condicionado') then
      raise exception 'a etapa exige decisão humana GO ou GO condicionado' using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists pipeline_oportunidades_portao on public.pipeline_oportunidades;
create trigger pipeline_oportunidades_portao
  before insert or update of etapa_id on public.pipeline_oportunidades
  for each row execute function public.pipeline_oportunidades_portao();

create or replace function public.pipeline_registrar_resultado(
  p_tenant bigint,
  p_licitacao bigint,
  p_produto bigint,
  p_preco_centavos bigint,
  p_motivo text,
  p_user uuid
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_desfecho text;
begin
  if p_user is null then
    raise exception 'usuário obrigatório' using errcode = '22023';
  end if;
  if p_preco_centavos is not null and p_preco_centavos <= 0 then
    raise exception 'preço ofertado em centavos inteiros positivos' using errcode = '22023';
  end if;
  select e.desfecho into v_desfecho
    from public.pipeline_oportunidades po
    join public.pipeline_etapas e on e.id = po.etapa_id and e.tenant_id = po.tenant_id
   where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao;
  if not found then
    raise exception 'oportunidade não está no pipeline' using errcode = 'P0002';
  end if;
  if v_desfecho is null then
    raise exception 'produto e preço só são gravados no desfecho' using errcode = '22023';
  end if;
  -- Produto de outro tenant não entra no resultado deste tenant. Produto sem tenant (catálogo compartilhado) entra.
  if p_produto is not null and not exists (
       select 1 from public.catalogo_produtos cp
        where cp.id = p_produto and (cp.tenant_id = p_tenant or cp.tenant_id is null)
     ) then
    raise exception 'produto % não é do tenant %', p_produto, p_tenant using errcode = '42501';
  end if;
  update public.pipeline_oportunidades
     set produto_id = p_produto,
         preco_ofertado_centavos = p_preco_centavos,
         motivo_perda = nullif(btrim(coalesce(p_motivo, '')), ''),
         atualizada_por = p_user,
         atualizada_em = now()
   where tenant_id = p_tenant and licitacao_id = p_licitacao;
end
$$;

alter table public.tenant_regras_comerciais enable row level security;
alter table public.decisoes_comerciais enable row level security;

revoke all on table public.tenant_regras_comerciais, public.decisoes_comerciais from public, anon, authenticated;
grant select, insert, update, delete on table public.tenant_regras_comerciais, public.decisoes_comerciais to service_role;

revoke all on function public.recomendar_participacao(boolean, boolean, boolean, boolean, boolean, boolean) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_oportunidades_portao() from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_registrar_resultado(bigint, bigint, bigint, bigint, text, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.recomendar_participacao(boolean, boolean, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.pipeline_oportunidades_portao() to service_role;
grant execute on function public.pipeline_registrar_resultado(bigint, bigint, bigint, bigint, text, uuid) to service_role;

commit;
