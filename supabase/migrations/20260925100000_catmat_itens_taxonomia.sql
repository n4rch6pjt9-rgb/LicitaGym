-- LicitaGym: taxonomia de descrições CATMAT em 6 blocos
-- caracteristica · unidade · peso · cor · formato · adicionais
-- Mesmo mapa de coletor/taxonomia.py (bloco_da_caracteristica). Rodar no SQL Editor.

-- 1) Mapa editável: característica CATMAT -> bloco (sobrepõe a regra automática)
create table if not exists public.taxonomia_mapa_caracteristica (
  nome_caracteristica text primary key,
  bloco text not null check (bloco in ('caracteristica','unidade','peso','cor','formato','adicionais')),
  obs text,
  updated_at timestamptz default now()
);
alter table public.taxonomia_mapa_caracteristica enable row level security;
drop policy if exists taxonomia_mapa_select on public.taxonomia_mapa_caracteristica;
create policy taxonomia_mapa_select on public.taxonomia_mapa_caracteristica for select to authenticated using (true);

-- 2) Regra automática (igual ao Python)
create or replace function public.taxonomia_bloco(nome text)
returns text language sql immutable as $$
  select case
    when n ~ 'fornecimento' or n in ('unidade','unidade fornecimento','embalagem') then 'unidade'
    when n ~ '^cor' then 'cor'
    when n in ('forma','formato') or n ~ '^(forma|formato) ' then 'formato'
    when n = 'peso' or (n ~ '^peso ' and n !~ 'imersao') then 'peso'
    when n ~ '^(tipo|material|revestimento|aplicacao|uso|acabamento|estrutura|modelo|tratamento|composicao|funcao|funcoes|sistema|componentes|resistencia|densidade|nome)\M' then 'caracteristica'
    else 'adicionais' end
  from (select lower(translate(coalesce(nome,''),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
        'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')) as n) x
$$;

-- 3) Uma linha por item com os 6 blocos (jsonb) + colunas planas mais usadas
create or replace view public.catmat_itens_taxonomia with (security_invoker = true) as
with c as (
  select k.codigo_item, k.nome_caracteristica, k.nome_valor_caracteristica as valor, k.sigla_unidade_medida as un,
         coalesce(m.bloco, public.taxonomia_bloco(k.nome_caracteristica)) as bloco
  from public.catmat_item_caracteristicas k
  left join public.taxonomia_mapa_caracteristica m using (nome_caracteristica)
  where coalesce(k.status, true)
    and upper(coalesce(k.nome_valor_caracteristica,'')) not in ('', 'NÃO APLICÁVEL', 'NAO APLICAVEL', 'N/A')
)
select i.codigo_item, i.codigo_pdm, i.nome_pdm, i.descricao_item, i.status_item,
  (select jsonb_object_agg(nome_caracteristica, valor || coalesce(' '||un,'')) from c where c.codigo_item=i.codigo_item and bloco='caracteristica') as caracteristica,
  (select jsonb_agg(distinct u.nome_unidade_fornecimento) from public.catmat_pdm_unidades u where u.codigo_pdm::text = i.codigo_pdm) as unidade_fornecimento,
  (select replace(valor, ',', '.')::numeric from c where c.codigo_item=i.codigo_item and upper(nome_caracteristica)='PESO' and valor ~ '^\d+([.,]\d+)?$' limit 1) as peso,
  (select coalesce(un,'KG') from c where c.codigo_item=i.codigo_item and upper(nome_caracteristica)='PESO' limit 1) as unidade_peso,
  (select valor from c where c.codigo_item=i.codigo_item and upper(nome_caracteristica)='COR' limit 1) as cor,
  (select valor from c where c.codigo_item=i.codigo_item and upper(nome_caracteristica) in ('FORMA','FORMATO') limit 1) as formato,
  (select jsonb_object_agg(nome_caracteristica, valor || coalesce(' '||un,'')) from c where c.codigo_item=i.codigo_item
     and (bloco='adicionais' or (bloco in ('cor','formato','peso') and upper(nome_caracteristica) not in ('COR','FORMA','FORMATO','PESO')))) as adicionais
from public.catmat_itens i;

comment on view public.catmat_itens_taxonomia is
  'Itens CATMAT decompostos em caracteristica/unidade/peso/cor/formato/adicionais (ver coletor/taxonomia.py)';

-- 4) Itens de licitação/contratação recebem a taxonomia calculada pelo coletor
--    (python3 -m coletor.aplicar_taxonomia). Coluna nova, anulável: não afeta o app atual.
alter table public.licitacao_itens    add column if not exists taxonomia jsonb;
alter table public.contratacoes_itens add column if not exists taxonomia jsonb;
create index if not exists idx_licitens_tax_tipo on public.licitacao_itens ((taxonomia->'plano'->>'tipo_produto'));
create index if not exists idx_contritens_tax_tipo on public.contratacoes_itens ((taxonomia->'plano'->>'tipo_produto'));
