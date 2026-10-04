-- Objeto canônico das licitações (Dashboard, revisão de 04/10/2026): a coluna "Objeto da contratação" deixa de
-- ser a cópia do texto da API e passa a mostrar uma categoria canônica, em maiúsculas e curta, igual para todas as
-- fontes (PNCP, Sistema S). Decisões do Marcelo: "REGISTRO DE PREÇO" é selo ao lado (é modalidade, aparece em ~550
-- das 1.654 licitações, em todas as categorias), não categoria; o filtro de descrição usa este catálogo + CATMAT.
--
-- O que cria:
--   1) objeto_categorias: catálogo editável (slug, nome em maiúsculas, ordem de precedência, padrão e exceção em
--      regex sobre o texto normalizado). A primeira categoria, pela ordem, cujo padrão casa e a exceção não casa,
--      vence; nenhuma = 'outros'. 11 categorias semeadas, mais "outros" quando nenhuma casa (academia ao ar livre, fisioterapia e playground vieram da
--      curadoria da segmentação do Licitanet, medidas na base em 04/10) (on conflict do nothing: não desfaz edição);
--   2) objeto_normalizar() (maiúsculas sem acento) e objeto_classificar() (slug da categoria);
--   3) licitacoes_externas.objeto_categoria / objeto_registro_preco, mantidas por gatilho quando o objeto muda,
--      e preenchidas agora para as linhas existentes (o gatilho de licitacao_match só reage a mudança de objeto,
--      então o preenchimento não reabre casamentos);
--   4) objeto_reclassificar(): recalcula tudo depois de editar o catálogo;
--   5) a view licitacoes_externas_prioridade_efetiva ganha as duas colunas no fim (mesma definição de
--      20261003170000; create or replace só acrescenta colunas).
-- Medido em produção (só leitura, 04/10): % que casa com PDM da classe 7830 (core) por categoria — material
-- esportivo 97,8%; equipamento de musculação 85,4%; aquisição de material 61,1%; equipamento permanente 57,1%;
-- serviço de manutenção 52,2%; reforma 25,0%; credenciamento 22,2%. Base para o modelo probabilístico futuro.
-- Quem lê/escreve: service_role (Edge Function api-dashboard-oportunidades). Aditiva; o merge aplica em produção.

begin;

set local lock_timeout = '10s';

-- 1) Catálogo ------------------------------------------------------------------------------------------------------
create table if not exists public.objeto_categorias (
  slug       text primary key,
  nome       text not null,
  ordem      integer not null,
  padrao     text not null,
  exceto     text,
  ativo      boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint objeto_categorias_slug_chk check (slug ~ '^[a-z][a-z0-9_]*$' and slug <> 'outros'),
  constraint objeto_categorias_nome_chk check (nome = upper(nome) and char_length(nome) between 3 and 60)
);

comment on table public.objeto_categorias is
  'Catálogo canônico do objeto da licitação (maiúsculas, curto). padrao/exceto são regex sobre objeto_normalizar(objeto); '
  'vence a menor ordem que casa. Sem categoria = outros. Depois de editar: select public.objeto_reclassificar().';

insert into public.objeto_categorias (slug, nome, ordem, padrao, exceto) values
  ('credenciamento',          'CREDENCIAMENTO',                          10, 'CREDENCIAMENTO', null),
  ('servico_manutencao',      'SERVIÇO DE MANUTENÇÃO',                   20, '(MANUTENCAO|REPARO|CONSERTO|TAPECARIA|LOCACAO)', '(AQUISI|AUISI|COMPRA|FORNECIMENTO)'),
  ('reforma_geral',           'REFORMA GERAL',                           30, '(REFORMA|CONSTRUC|\mOBRAS?\M|EMPREITADA|PAVIMENTA)', '(AQUISI|AUISI|COMPRA|FORNECIMENTO)'),
  ('academia_ar_livre',       'AQUISIÇÃO DE ACADEMIA AO AR LIVRE',       35, '(AR LIVRE|TERCEIRA IDADE|\mATI\M|ACADEMIAS? DA SAUDE|ACADEMIAS? DE SAUDE)', null),
  ('equipamento_musculacao',  'AQUISIÇÃO DE EQUIPAMENTO DE MUSCULAÇÃO',  40, '(MUSCULACAO|ACADEMIA|GINASTICA|FITNESS|ERGOMETR|ESTEIRA|LEG PRESS|PILATES|CROSSFIT|FUNCIONAL)', null),
  ('equipamento_fisioterapia','AQUISIÇÃO DE EQUIPAMENTO DE FISIOTERAPIA', 42, '(FISIOTERAP|REABILITA)', null),
  ('piso_esportivo',          'AQUISIÇÃO DE PISO ESPORTIVO',             45, '(\mPISOS?\M|EMBORRACHAD|GRAMA SINTETICA|TATAME)', null),
  ('playground',              'AQUISIÇÃO DE PLAYGROUND',                 48, '(PLAYGROUND|PARQUE INFANTIL|BRINQUEDO)', null),
  ('material_esportivo',      'AQUISIÇÃO DE MATERIAL ESPORTIVO',         50, '(ESPORTIV|DESPORTIV)', null),
  ('equipamento_permanente',  'AQUISIÇÃO DE EQUIPAMENTO PERMANENTE',     60, 'PERMANENTE', null),
  ('aquisicao_material',      'AQUISIÇÃO DE MATERIAL',                   70, '(AQUISI|AUISI|COMPRA|FORNECIMENTO|MATERI)', null)
on conflict (slug) do nothing;

-- 2) Funções -------------------------------------------------------------------------------------------------------
create or replace function public.objeto_normalizar(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select translate(upper(coalesce(p, '')), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'AAAAAEEEEIIIIOOOOOUUUUC')
$$;

create or replace function public.objeto_classificar(p_objeto text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select c.slug
      from public.objeto_categorias c
     where c.ativo
       and public.objeto_normalizar(p_objeto) ~ c.padrao
       and (c.exceto is null or public.objeto_normalizar(p_objeto) !~ c.exceto)
     order by c.ordem, c.slug
     limit 1
  ), 'outros')
$$;

-- 3) Colunas e gatilho ---------------------------------------------------------------------------------------------
alter table public.licitacoes_externas
  add column if not exists objeto_categoria text,
  add column if not exists objeto_registro_preco boolean not null default false;

create index if not exists licitacoes_externas_objeto_categoria_idx on public.licitacoes_externas (objeto_categoria);

create or replace function public.licitacoes_externas_objeto_canonico_trg()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.objeto is distinct from old.objeto or new.objeto_categoria is null then
    new.objeto_categoria := public.objeto_classificar(new.objeto);
    new.objeto_registro_preco := public.objeto_normalizar(new.objeto) ~ 'REGISTRO DE PRECO';
  end if;
  return new;
end
$$;

drop trigger if exists licitacoes_externas_objeto_canonico on public.licitacoes_externas;
create trigger licitacoes_externas_objeto_canonico
  before insert or update on public.licitacoes_externas
  for each row execute function public.licitacoes_externas_objeto_canonico_trg();

-- 4) Recalcular tudo (depois de editar o catálogo) e preencher as linhas existentes ----------------------------------
create or replace function public.objeto_reclassificar()
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with mudou as (
    update public.licitacoes_externas l
       set objeto_categoria = public.objeto_classificar(l.objeto),
           objeto_registro_preco = public.objeto_normalizar(l.objeto) ~ 'REGISTRO DE PRECO'
     where l.objeto_categoria is distinct from public.objeto_classificar(l.objeto)
        or l.objeto_registro_preco is distinct from (public.objeto_normalizar(l.objeto) ~ 'REGISTRO DE PRECO')
    returning 1
  )
  select count(*)::integer from mudou
$$;

select public.objeto_reclassificar();

-- 5) View das oportunidades: as duas colunas novas no fim -----------------------------------------------------------
create or replace view public.licitacoes_externas_prioridade_efetiva
with (security_invoker = true) as
select
  l.id,
  l.fonte,
  l.modulo,
  l.id_externo,
  l.codigo_externo,
  l.numero_processo,
  l.processo_norm,
  l.numero_edital,
  l.objeto,
  l.unidade_compradora,
  l.modalidade,
  l.fase,
  l.situacao,
  l.data_inicio,
  l.data_fim,
  l.valor_total,
  l.orgao_cnpj,
  l.orgao_nome,
  l.municipio,
  l.uf,
  l.data_publicacao,
  l.data_homologacao,
  l.categoria_escopo,
  l.interesse_borracha,
  case
    when e.encerramento is not null then 'historico'
    when j.prazo_encerrado then 'monitorar'
    else l.prioridade
  end as prioridade,
  l.termos_busca,
  l.created_at,
  l.updated_at,
  l.last_synced_at,
  l.prioridade as prioridade_gravada,
  case
    when e.encerramento is not null then e.encerramento
    when j.prazo_encerrado then 'prazo_encerrado'
  end as prioridade_motivo,
  c.canonica_id,
  c.eh_canonica,
  l.objeto_categoria,
  l.objeto_registro_preco
from public.licitacoes_externas l
join public.licitacoes_pncp_canonica c on c.id = l.id
cross join lateral (
  select case
    when l.data_homologacao is not null then 'data_homologacao'
    when exists (select 1 from public.licitacao_resultados r where r.licitacao_id = l.id) then 'resultado'
    when lower(coalesce(l.raw ->> 'tem_resultado', '')) in ('true', 't', '1', 'sim') then 'tem_resultado'
    when lower(coalesce(l.raw ->> 'cancelado', '')) in ('true', 't', '1', 'sim') then 'cancelado'
    when coalesce(nullif(l.situacao, ''), l.raw ->> 'situacao_nome', '')
         ~* '(revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|adjudicad|conclu[ií]d|finalizad)'
      then 'situacao'
  end as encerramento
) e
cross join lateral (
  select (
    l.prioridade = 'leads'
    and coalesce(private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia'), l.data_fim) <= now()
  ) is true as prazo_encerrado
) j;

-- 6) RLS e ACL --------------------------------------------------------------------------------------------------------
alter table public.objeto_categorias enable row level security;
revoke all on table public.objeto_categorias from anon, authenticated, PUBLIC;
grant all on table public.objeto_categorias to service_role;

revoke execute on function public.objeto_normalizar(text) from PUBLIC, anon, authenticated;
revoke execute on function public.objeto_classificar(text) from PUBLIC, anon, authenticated;
revoke execute on function public.objeto_reclassificar() from PUBLIC, anon, authenticated;
revoke execute on function public.licitacoes_externas_objeto_canonico_trg() from PUBLIC, anon, authenticated;
grant execute on function public.objeto_normalizar(text) to service_role;
grant execute on function public.objeto_classificar(text) to service_role;
grant execute on function public.objeto_reclassificar() to service_role;

commit;
