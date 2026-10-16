-- =============================================================================
-- v_bi_resultados_itens: valor unitário do resultado do PNCP
--
-- Por quê: a view lia o valor unitário só de licitacao_resultados.valor_proposta, que só o coletor do Paradigma
-- (Sistema S) grava (o lance de cada proposta). O resultado do PNCP grava valor_unitario_homologado e deixa
-- valor_proposta nulo. Medido em produção em 16/10/2026 (só leitura): 0 de 11.093 linhas da view com valor_unit,
-- e valor_unitario_homologado preenchido em todas as linhas de licitacao_resultados (fonte pncp).
--
-- O que muda (só a definição da view, nenhuma tabela nem dado):
--   valor_unit             = valor_proposta quando houver (lance do Paradigma, como hoje); senão o
--                            valor_unitario_homologado, só quando > 0 (zero ou nulo não é preço: fica ausente,
--                            a mesma regra da api-precos).
--   desconto_vs_referencia = calculado sobre esse mesmo valor_unit.
--   valor_unitario_homologado (coluna nova, no fim): o homologado como veio da fonte, para quem precisa separar
--                            homologado de lance.
-- Colunas existentes mantêm nome, ordem e tipo (create or replace view).
--
-- Quem lê: nenhuma Edge Function lê esta view hoje (grep em supabase/functions). O BI do Dashboard ainda não tem
-- função de leitura (Dashboard #35).
-- ACL: reafirma a de 20260929140100 (authenticated SELECT, service_role ALL); a revogação de authenticated é a #178,
-- fora desta migration.
-- Verificar: supabase/tests/bi_resultados_valor_unit_check.sql; em produção,
--   select count(*) filter (where valor_unit is not null), count(*) from public.v_bi_resultados_itens;
-- =============================================================================

begin;

create or replace view public.v_bi_resultados_itens
with (security_invoker = true) as
select l.id                         as licitacao_id,
       l.fonte, l.numero_edital, l.orgao_nome, l.uf as uf_orgao, l.objeto,
       l.data_homologacao,
       i.numero_item,
       i.catalogo_codigo_item       as codigo_produto,
       i.descricao                  as descricao_item,
       i.familia_equipamento,
       i.no_taxonomia,
       i.fonte_carga,
       i.quantidade,
       i.valor_unitario_estimado    as valor_referencia_unit,
       i.situacao                   as situacao_item,
       r.ranking, r.vencedor, r.situacao as situacao_proposta,
       r.fornecedor_nome, r.fornecedor_cnpj,
       f.razao_social               as razao_social_receita,
       f.fabricante,
       case when f.fabricante then 'fabricante' when f.cnpj is not null then 'comercio/revenda' end as tipo_fornecedor,
       f.cnae_principal, f.cnae_principal_descricao, f.uf as uf_fornecedor, f.municipio as municipio_fornecedor, f.porte,
       r.marca, r.marca_normalizada, r.modelo,
       v.valor_unit,
       r.valor_total_homologado,
       case when i.valor_unitario_estimado > 0 then round(1 - v.valor_unit / i.valor_unitario_estimado, 4) end
                                    as desconto_vs_referencia,
       r.valor_unitario_homologado
from public.licitacao_resultados r
cross join lateral (
  select coalesce(r.valor_proposta,
                  case when r.valor_unitario_homologado > 0 then r.valor_unitario_homologado end) as valor_unit
) v
join public.licitacao_itens i       on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
join public.licitacoes_externas l   on l.id = r.licitacao_id
join public.licitacoes_pncp_canonica cn on cn.id = l.id and cn.eh_canonica
left join public.fornecedores f     on f.cnpj = r.fornecedor_cnpj;

revoke all on table public.v_bi_resultados_itens from anon, authenticated, PUBLIC;
grant select on table public.v_bi_resultados_itens to authenticated;
grant all on table public.v_bi_resultados_itens to service_role;

comment on view public.v_bi_resultados_itens is
  'Resultados por item (só compras canônicas). valor_unit = lance (valor_proposta, Paradigma) quando houver, senão valor_unitario_homologado > 0 (PNCP); zero ou nulo fica ausente. desconto_vs_referencia sobre valor_unit. valor_unitario_homologado como veio da fonte. security_invoker.';

commit;
