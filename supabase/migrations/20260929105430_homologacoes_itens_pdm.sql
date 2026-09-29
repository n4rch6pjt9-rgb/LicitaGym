-- Recuperado de supabase_migrations.schema_migrations em 2026-09-29 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.
-- Procedência: aplicada direto no projeto ifaiagegyicjzlpskafh via MCP (apply_migration) em 29/09/2026
-- 07:54:30 BRT (versão 20260929105430 = horário UTC), 1 statement. O corpo abaixo é o statements[1] de
-- schema_migrations (md5 5ee55c7510aed00592fd5b6514d1a56d, conferido no banco no L0 de 29/09/2026) com UMA mudança
-- para replay limpo (banco novo / supabase db reset): o "insert ... values" das 40 regras de catmat_pdm_palavras virou
-- "insert ... select ... from (values ...) v where exists (catmat_pdms com o mesmo codigo_pdm)", com as mesmas 40
-- linhas e os mesmos valores e mantendo "on conflict do nothing". Motivo: num banco novo catmat_pdms está vazia (é
-- carregada pela função de importação, não por seed) e a FK codigo_pdm -> catmat_pdms quebraria o replay; lá a tabela
-- nasce vazia, o que é esperado. Fora isso, o corpo é byte a byte o statement registrado.
-- Produção não é afetada: a versão já consta em schema_migrations, e supabase db push e a integração GitHub pulam
-- este arquivo.
-- Ajustes de permissão/índice deste objeto: 20260929145232_l3_permissoes_fornecedores_pdm.sql (migration nova).

create or replace function public.norm_txt(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(translate(coalesce(t,''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
    'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))
$$;

-- Regras de palavra-chave item -> PDM CATMAT (para itens sem código de catálogo no PNCP)
create table if not exists public.catmat_pdm_palavras (
  id bigint generated always as identity primary key,
  codigo_pdm integer not null references public.catmat_pdms(codigo_pdm) on delete cascade,
  padrao text not null,            -- regex POSIX aplicada sobre norm_txt(descricao)
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (codigo_pdm, padrao)
);
alter table public.catmat_pdm_palavras enable row level security;
create policy catmat_pdm_palavras_select on public.catmat_pdm_palavras for select to authenticated using (true);
comment on table public.catmat_pdm_palavras is 'Curadoria: regex (sobre norm_txt da descrição do item) que classifica itens de licitação em PDMs CATMAT quando o PNCP não traz catalogoCodigoItem.';

-- Replay: só insere regras cujo PDM existe em catmat_pdms (banco novo: nenhuma). No remoto já foi aplicado com values.
insert into public.catmat_pdm_palavras (codigo_pdm, padrao)
select v.codigo_pdm, v.padrao from (values
 (18481,'grama(do)? sintetic'),
 (12550,'tapete[^.]{0,40}borracha|borracha[^.]{0,20}tapete'),
 (745,'capacho'),
 (758,'\mtapetes?\M'),
 (18452,'tatame'),
 (10779,'piso[s]? (sintetic|emborrachad|de borracha|esportiv|vinilic)'),
 (757,'revestimento (de |para )?piso'),
 (746,'carpete'),
 (11503,'\mredes? (de )?(protecao|futsal|futebol|volei|voleibol|basquete|tenis|esportiv|handebol)|rede esportiva|redes? para (trave|gol|traves)'),
 (2976,'bambole|arcos? (para|de) ginastica'),
 (8166,'\mhalter'),
 (5341,'colchonete'),
 (1400,'corda de pular'),
 (3522,'bicicleta ergometric|bike (de )?spinning'),
 (7115,'esteira (eletric|ergometric)'),
 (10462,'parque infantil|playground'),
 (6929,'escorregador|escorregadeira'),
 (7921,'gangorra'),
 (3233,'\mbalanco'),
 (4308,'cama elastica|trampolim'),
 (9634,'tenis de mesa|pingue.?pongue|ping.?pong|futmesa'),
 (9629,'pebolim|\mtoto\M'),
 (9632,'sinuca|bilhar'),
 (1199,'\mapitos?\M'),
 (18453,'saco (de )?pancada'),
 (2640,'academia (ao ar livre|de ginastica)|aparelhos? de musculacao|estacao de musculacao|leg press|\msupino'),
 (17574,'aparelhos? (de|para) ginastica'),
 (2638,'tornozeleira|caneleira de peso|\manilhas?\M|kettlebell|elastico (extensor|de resistencia)|mini ?band'),
 (3431,'\mbastao|bastoes'),
 (16229,'banco sueco'),
 (15625,'fita (de |para )?marcacao'),
 (15677,'raia antimarola|\mraias? (de|para) piscina'),
 (11132,'prancha (de |para )?natacao|prancha de eva'),
 (17733,'rolo (de )?espuma|foam roller'),
 (14647,'estrado modular'),
 (15172,'fita (de )?ginastica ritmica'),
 (15285,'\mmacas? (de |para )?ginastica'),
 (3869,'inflavel'),
 (5349,'colete (salva|de piscina|flutua)'),
 (6827,'equipamentos? para ginasio')
) as v(codigo_pdm, padrao)
where exists (select 1 from public.catmat_pdms p where p.codigo_pdm = v.codigo_pdm)
on conflict do nothing;

-- Itens homologados com PDM (código de catálogo quando existe; senão palavra-chave)
create or replace view public.homologacoes_itens
with (security_invoker = true) as
select
  r.id as resultado_id,
  r.fornecedor_cnpj,
  r.licitacao_id,
  r.numero_item,
  l.uf,
  l.orgao_cnpj,
  l.modalidade,
  i.descricao as item_descricao,
  i.catalogo_codigo_item,
  r.valor_total_homologado,
  coalesce(ci.codigo_pdm::integer, kw.codigo_pdm) as codigo_pdm,
  p.nome_pdm,
  case when ci.codigo_pdm is not null then 'catalogo' when kw.codigo_pdm is not null then 'palavra_chave' end as pdm_metodo
from public.licitacao_resultados r
join public.licitacoes_externas l on l.id = r.licitacao_id
left join public.licitacao_itens i on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
left join public.catmat_itens ci on ci.codigo_item::text = i.catalogo_codigo_item
left join lateral (
  select w.codigo_pdm from public.catmat_pdm_palavras w
  where ci.codigo_pdm is null and w.ativo and public.norm_txt(i.descricao) ~ w.padrao
  order by length(w.padrao) desc limit 1
) kw on true
left join public.catmat_pdms p on p.codigo_pdm = coalesce(ci.codigo_pdm::integer, kw.codigo_pdm);

revoke all on public.homologacoes_itens from anon, authenticated;
comment on view public.homologacoes_itens is 'Item homologado × fornecedor × PDM CATMAT (catálogo ou regra catmat_pdm_palavras). Base do filtro PDM/item/UF de fornecedores.';