-- Aderência técnica produto × item (plano 2, 06/10/2026).
--
-- O que cria:
--   1) ontologia_atributos: a mesma lista de atributos no nó da taxonomia (esteira elétrica e piso emborrachado);
--   2) licitacao_item_requisitos: exigência do item com documento, página e trecho. Linha validada é imutável
--      (nenhuma coluna material muda, nem o status); extração nova em conflito vira outra linha com status
--      'conflito'. O documento citado tem de ser da mesma licitação do item;
--   3) catalogo_produto_atributos: a ficha do produto nos mesmos nomes de atributo;
--   4) catalogo_de_para ganha os vereditos nao_comprovado, supera, ausente e ambiguo, a lista de eliminatórios
--      e a trava: falha ou lacuna eliminatória não pode ser atende, parcial nem supera. v_catalogo_viabilidade
--      passa a usar só atende, parcial e supera na referência de preço;
--   5) classificar_aderencia(): o rótulo do conjunto, sem percentual.
--
-- Quem lê: authenticated (exigência de edital e ontologia são dado público; atributo de produto é ficha, não preço).
-- Quem escreve: service_role. classificar_aderencia é função pura, execute só service_role.
-- Aditiva. O merge na main aplica em produção.
-- Verificação: supabase/tests/aderencia_tecnica_check.sql.

begin;

set local lock_timeout = '10s';

-- 1) Ontologia ----------------------------------------------------------------------------------------------------
create table if not exists public.ontologia_atributos (
  no_taxonomia text not null,
  atributo     text not null,
  eliminatorio boolean not null default false,
  sentido      text not null default 'minimo' check (sentido in ('minimo', 'maximo', 'igual', 'texto')),
  primary key (no_taxonomia, atributo)
);

comment on table public.ontologia_atributos is
  'Atributos comparáveis de um nó da taxonomia. O mesmo nome vale no requisito do item e na ficha do produto. eliminatorio não pode ser diluído por contagem alta.';

insert into public.ontologia_atributos (no_taxonomia, atributo, eliminatorio, sentido) values
  ('esteira_eletrica', 'motor_hp_min', true, 'minimo'),
  ('esteira_eletrica', 'velocidade_kmh_min', false, 'minimo'),
  ('esteira_eletrica', 'capacidade_usuario_kg_min', true, 'minimo'),
  ('esteira_eletrica', 'inclinacao', false, 'texto'),
  ('esteira_eletrica', 'area_corrida', false, 'texto'),
  ('esteira_eletrica', 'certificacoes', true, 'texto'),
  ('piso_emborrachado', 'material', true, 'texto'),
  ('piso_emborrachado', 'espessura_mm_min', true, 'minimo'),
  ('piso_emborrachado', 'densidade', false, 'texto'),
  ('piso_emborrachado', 'absorcao_impacto', false, 'texto'),
  ('piso_emborrachado', 'dimensao', false, 'texto'),
  ('piso_emborrachado', 'certificacoes', true, 'texto')
on conflict (no_taxonomia, atributo) do nothing;

-- 2) Requisito do item ---------------------------------------------------------------------------------------------
create table if not exists public.licitacao_item_requisitos (
  id                 bigint generated always as identity primary key,
  licitacao_item_id  bigint not null references public.licitacao_itens (id) on delete cascade,
  atributo           text not null,
  valor_num          numeric,
  valor_texto        text,
  natureza           text not null check (natureza in ('fato', 'analise', 'inferencia')),
  metodo             text not null check (metodo in ('regra', 'modelo', 'cliente')),
  documento_id       bigint references public.licitacao_documentos (id) on delete set null,
  pagina             int,
  trecho             text,
  status_validacao   text not null default 'extraido'
                       check (status_validacao in ('extraido', 'validado', 'conflito', 'abstencao')),
  created_at         timestamptz not null default now(),
  check (valor_num is not null or valor_texto is not null or status_validacao = 'abstencao')
);

create unique index if not exists licitacao_item_requisitos_validado_idx
  on public.licitacao_item_requisitos (licitacao_item_id, atributo)
  where status_validacao = 'validado';

create index if not exists licitacao_item_requisitos_item_idx
  on public.licitacao_item_requisitos (licitacao_item_id);

comment on table public.licitacao_item_requisitos is
  'Exigência técnica de um item, com página e trecho. status validado não é atualizado: conflito é outra linha.';

-- Requisito validado é imutável: nenhuma coluna material muda (nem o status, para não "desvalidar" e depois mudar).
-- Conflito ou correção é outra linha. Única exceção: documento_id virar null pelo on delete set null do documento
-- (o documento foi apagado; o trecho e a página ficam). Documento citado tem de ser da mesma licitação do item.
create or replace function public.licitacao_item_requisitos_nao_sobrescreve()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.status_validacao = 'validado'
     and (new.licitacao_item_id, new.atributo, new.valor_num, new.valor_texto, new.natureza, new.metodo,
          new.pagina, new.trecho, new.status_validacao)
         is distinct from
         (old.licitacao_item_id, old.atributo, old.valor_num, old.valor_texto, old.natureza, old.metodo,
          old.pagina, old.trecho, old.status_validacao)
       or (tg_op = 'UPDATE' and old.status_validacao = 'validado'
           and new.documento_id is distinct from old.documento_id and new.documento_id is not null) then
    raise exception 'requisito validado não é alterado: registre outra linha' using errcode = '22023';
  end if;
  if new.documento_id is not null
     and (tg_op = 'INSERT' or new.documento_id is distinct from old.documento_id
          or new.licitacao_item_id is distinct from old.licitacao_item_id)
     and not exists (
       select 1
         from public.licitacao_documentos d
         join public.licitacao_itens i on i.licitacao_id = d.licitacao_id
        where d.id = new.documento_id and i.id = new.licitacao_item_id
     ) then
    raise exception 'documento % não é da licitação do item %', new.documento_id, new.licitacao_item_id
      using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists licitacao_item_requisitos_nao_sobrescreve on public.licitacao_item_requisitos;
create trigger licitacao_item_requisitos_nao_sobrescreve
  before insert or update on public.licitacao_item_requisitos
  for each row execute function public.licitacao_item_requisitos_nao_sobrescreve();

-- 3) Ficha do produto nos mesmos nomes -----------------------------------------------------------------------------
create table if not exists public.catalogo_produto_atributos (
  produto_id  bigint not null references public.catalogo_produtos (id) on delete cascade,
  atributo    text not null,
  valor_num   numeric,
  valor_texto text,
  primary key (produto_id, atributo),
  check (valor_num is not null or valor_texto is not null)
);

comment on table public.catalogo_produto_atributos is
  'Característica do produto no mesmo atributo de ontologia_atributos. Não guarda preço.';

-- 4) Veredito do de-para -------------------------------------------------------------------------------------------
alter table public.catalogo_de_para
  add column if not exists atributos_eliminatorios text[] not null default '{}';

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'catalogo_de_para_aderencia_check') then
    alter table public.catalogo_de_para drop constraint catalogo_de_para_aderencia_check;
  end if;
  alter table public.catalogo_de_para add constraint catalogo_de_para_aderencia_check
    check (aderencia = any (array[
      'atende', 'parcial', 'nao_atende', 'supera', 'nao_comprovado', 'ausente', 'ambiguo'
    ]));
  if exists (select 1 from pg_constraint where conname = 'catalogo_de_para_eliminatorio_check') then
    alter table public.catalogo_de_para drop constraint catalogo_de_para_eliminatorio_check;
  end if;
  alter table public.catalogo_de_para add constraint catalogo_de_para_eliminatorio_check
    check (
      not (
        aderencia = any (array['atende', 'parcial', 'supera'])
        and (
          atributos_falha && atributos_eliminatorios
          or atributos_nao_informados && atributos_eliminatorios
        )
      )
      and (aderencia <> 'atende' or cardinality(atributos_falha) = 0)
      and (aderencia <> 'supera' or (cardinality(atributos_falha) = 0 and cardinality(atributos_nao_informados) = 0))
    );
end
$$;

comment on column public.catalogo_de_para.atributos_eliminatorios is
  'Atributos cuja falha ou lacuna impede atende, parcial e supera.';

-- 4b) Viabilidade só com veredito de casamento ---------------------------------------------------------------------
-- Os vereditos novos (nao_comprovado, ausente, ambiguo) não são casamento com o produto: não entram na mediana de
-- preço nem em n_itens. Antes a view só excluía nao_atende. Corpo igual ao de 20261002220000, só o filtro muda.
create or replace view public.v_catalogo_viabilidade
with (security_invoker = true)
as
 WITH ref AS (
         SELECT d.produto_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r.valor_unitario_homologado::double precision)) FILTER (WHERE r.valor_unitario_homologado > 0::numeric) AS med_hom,
            count(r.valor_unitario_homologado) FILTER (WHERE r.valor_unitario_homologado > 0::numeric) AS n_hom,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (COALESCE(pi.valor_unitario_estimado, li.valor_unitario_estimado)::double precision)) FILTER (WHERE COALESCE(pi.valor_unitario_estimado, li.valor_unitario_estimado) > 0::numeric) AS med_est,
            count(*) AS n_itens
           FROM catalogo_de_para d
             LEFT JOIN pca_itens pi ON pi.id = d.pca_item_id
             LEFT JOIN licitacao_itens li ON li.id = d.licitacao_item_id
             LEFT JOIN licitacao_resultados r ON r.licitacao_id = li.licitacao_id AND r.numero_item = li.numero_item
          WHERE d.status <> 'rejeitado'::text AND d.aderencia = ANY (ARRAY['atende'::text, 'parcial'::text, 'supera'::text])
          GROUP BY d.produto_id
        )
 SELECT p.tenant_id,
    p.id AS produto_id,
    p.codigo,
    p.nome,
    p.no_taxonomia,
    pr.preco_tabela,
    pr.desconto_max_pct,
    ref.n_itens,
    ref.n_hom,
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END AS preco_referencia,
        CASE
            WHEN ref.n_hom >= 3 THEN 'homologado'::text
            ELSE 'estimado'::text
        END AS base_referencia,
    round(100::numeric * (1::double precision -
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END / pr.preco_tabela::double precision)::numeric, 2) AS desconto_necessario_pct,
    (100::double precision * (1::double precision -
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END / pr.preco_tabela::double precision)) <= pr.desconto_max_pct::double precision AS viavel
   FROM catalogo_produtos p
     JOIN ref ON ref.produto_id = p.id
     LEFT JOIN LATERAL ( SELECT c.preco_tabela,
            c.desconto_max_pct
           FROM catalogo_precos c
          WHERE c.produto_id = p.id AND c.vigencia_inicio <= CURRENT_DATE AND (c.vigencia_fim IS NULL OR c.vigencia_fim >= CURRENT_DATE)
          ORDER BY c.vigencia_inicio DESC
         LIMIT 1) pr ON true;

comment on view public.v_catalogo_viabilidade is
  'Desconto necessário = 1 - referência/tabela. Viável quando desconto necessário <= desconto máximo do tenant. Só de-para atende, parcial ou supera entra na referência.';

-- 5) Rótulo do conjunto, sem percentual ---------------------------------------------------------------------------
create or replace function public.classificar_aderencia(
  p_atende int,
  p_supera int,
  p_nao_atende int,
  p_nao_comprovado int,
  p_ausente int,
  p_ambiguo int,
  p_falha text[],
  p_nao_informados text[],
  p_eliminatorios text[]
) returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p_falha, '{}') && coalesce(p_eliminatorios, '{}') then 'nao_atende'
    when coalesce(p_nao_informados, '{}') && coalesce(p_eliminatorios, '{}') then 'nao_comprovado'
    when coalesce(p_nao_atende, 0) > 0 then 'parcial'
    when coalesce(p_ambiguo, 0) > 0 then 'ambiguo'
    when coalesce(p_nao_comprovado, 0) > 0 then 'nao_comprovado'
    when coalesce(p_supera, 0) > 0 and coalesce(p_atende, 0) = 0 then 'supera'
    when coalesce(p_atende, 0) + coalesce(p_supera, 0) > 0 then 'atende'
    else 'ausente'
  end
$$;

-- 6) ACL -----------------------------------------------------------------------------------------------------------
alter table public.ontologia_atributos enable row level security;
alter table public.licitacao_item_requisitos enable row level security;
alter table public.catalogo_produto_atributos enable row level security;

drop policy if exists ontologia_atributos_select on public.ontologia_atributos;
create policy ontologia_atributos_select on public.ontologia_atributos for select to authenticated using (true);
drop policy if exists licitacao_item_requisitos_select on public.licitacao_item_requisitos;
create policy licitacao_item_requisitos_select on public.licitacao_item_requisitos for select to authenticated using (true);
drop policy if exists catalogo_produto_atributos_select on public.catalogo_produto_atributos;
create policy catalogo_produto_atributos_select on public.catalogo_produto_atributos for select to authenticated using (true);

revoke all on table public.ontologia_atributos, public.licitacao_item_requisitos, public.catalogo_produto_atributos from anon, PUBLIC;
revoke all on table public.ontologia_atributos, public.licitacao_item_requisitos, public.catalogo_produto_atributos from authenticated;
grant select on table public.ontologia_atributos, public.licitacao_item_requisitos, public.catalogo_produto_atributos to authenticated;
grant all on table public.ontologia_atributos, public.licitacao_item_requisitos, public.catalogo_produto_atributos to service_role;

revoke all on function public.classificar_aderencia(int, int, int, int, int, int, text[], text[], text[]) from PUBLIC, anon, authenticated;
grant execute on function public.classificar_aderencia(int, int, int, int, int, int, text[], text[], text[]) to service_role;
revoke all on function public.licitacao_item_requisitos_nao_sobrescreve() from PUBLIC, anon, authenticated;
grant execute on function public.licitacao_item_requisitos_nao_sobrescreve() to service_role;

commit;
