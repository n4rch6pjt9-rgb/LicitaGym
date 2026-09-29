-- 26/09/2026 — BI: perfil do equipamento por item, marca normalizada, fabricante × revenda e view de resultados.
-- Origem: licitagym-coletor-sistema-s@8925abf (20260926150000_bi_perfil_equipamento.sql), nunca aplicada;
-- renumerada em 29/09/2026 para depois de 20260929140000 e com a ACL da view acrescentada no fim.
-- Idempotente. Depende de 20260925120000 (sistema S) e 20260926120000 (fornecedores/lances).

alter table public.licitacao_itens
  add column if not exists familia_equipamento text,   -- equipamentos_fitness.musculacao|cardio|peso_livre|... ou avaliacao_fisica
  add column if not exists fonte_carga         text,   -- placas (bateria) | anilhas | motor | ... (quando o texto diz)
  add column if not exists perfil_metodo       text,   -- dicionario | regra_perfil
  add column if not exists perfil_confianca    text;   -- alta | media | baixa

alter table public.licitacao_resultados
  add column if not exists marca_normalizada text;

alter table public.fornecedores
  add column if not exists fabricante boolean;          -- CNAE principal nas divisões 10–33 (indústria)
update public.fornecedores
   set fabricante = (cnae_principal is not null and left(lpad(cnae_principal::text, 7, '0'), 2)::int between 10 and 33)
 where fabricante is null;

-- Uma linha por proposta ranqueada, com tudo que o BI precisa para responder "quem ganhou o quê, com que marca,
-- por quanto e contra quem". Vencedor = troféu do portal (1 por item encerrado).
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
       r.valor_proposta             as valor_unit,
       r.valor_total_homologado,
       case when i.valor_unitario_estimado > 0 then round(1 - r.valor_proposta / i.valor_unitario_estimado, 4) end
                                    as desconto_vs_referencia
from public.licitacao_resultados r
join public.licitacao_itens i       on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
join public.licitacoes_externas l   on l.id = r.licitacao_id
left join public.fornecedores f     on f.cnpj = r.fornecedor_cnpj;

-- ACL explícita (mesmo modelo de 20260929130000_acl_sistema_s_catalogos): authenticated só SELECT.
revoke all on table public.v_bi_resultados_itens from anon, authenticated, PUBLIC;
grant select on table public.v_bi_resultados_itens to authenticated;
grant all on table public.v_bi_resultados_itens to service_role;
