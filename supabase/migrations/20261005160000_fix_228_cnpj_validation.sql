-- Fix #228: validar CNPJ com checksum em v_marca_ocorrencias
-- Problema: CNPJ 00000000000000 passa pela regex ^[0-9]{14}$ mas é inválido por checksum
-- Solução: criar função private.cnpj_valido(text) que valida formato + checksum
-- Impacto: v_marca_ocorrencias.entra_ranking rejeita CNPJs inválidos no ranking de fornecedor
-- Escrita: migration (sistema); Leitura: views (service_role)
-- Verificar: supabase/tests/marcas_resolvedor_views_check.sql case N (CNPJ inválido)

begin;

-- 1) Função para validar CNPJ com checksum (RFC 10291)
-- Input: CNPJ com ou sem formatação (12.345.678/0001-90 ou 12345678000190)
-- Output: true se válido (formato 14 dígitos + checksum correto), false c.c.
create or replace function private.cnpj_valido(cnpj_bruto text)
returns boolean
language sql
immutable
parallel safe
as $$
with clean as (
  select regexp_replace(coalesce(cnpj_bruto, ''), '[^0-9]', '', 'g') as cnpj_limpo
),
valida as (
  select
    c.cnpj_limpo,
    length(c.cnpj_limpo) = 14 as tem_14_digitos,
    -- Rejeitar CNPJ de zeros (00000000000000)
    c.cnpj_limpo ~ '^[0-9]{14}$' and c.cnpj_limpo != '00000000000000' as nao_eh_zeros,
    -- Primeiro dígito verificador (peso 5 a 2)
    (substring(c.cnpj_limpo, 1, 1)::int * 5 +
     substring(c.cnpj_limpo, 2, 1)::int * 4 +
     substring(c.cnpj_limpo, 3, 1)::int * 3 +
     substring(c.cnpj_limpo, 4, 1)::int * 2 +
     substring(c.cnpj_limpo, 5, 1)::int * 9 +
     substring(c.cnpj_limpo, 6, 1)::int * 8 +
     substring(c.cnpj_limpo, 7, 1)::int * 7 +
     substring(c.cnpj_limpo, 8, 1)::int * 6) % 11 as resto1,
    -- Segundo dígito verificador (peso 6 a 2)
    (substring(c.cnpj_limpo, 1, 1)::int * 6 +
     substring(c.cnpj_limpo, 2, 1)::int * 5 +
     substring(c.cnpj_limpo, 3, 1)::int * 4 +
     substring(c.cnpj_limpo, 4, 1)::int * 3 +
     substring(c.cnpj_limpo, 5, 1)::int * 2 +
     substring(c.cnpj_limpo, 6, 1)::int * 9 +
     substring(c.cnpj_limpo, 7, 1)::int * 8 +
     substring(c.cnpj_limpo, 8, 1)::int * 7 +
     substring(c.cnpj_limpo, 9, 1)::int * 6) % 11 as resto2
  from clean c
),
checksum as (
  select
    v.*,
    (case when v.resto1 < 2 then 0 else 11 - v.resto1 end) as digito1_esperado,
    (case when v.resto2 < 2 then 0 else 11 - v.resto2 end) as digito2_esperado,
    substring(v.cnpj_limpo, 9, 1)::int as digito1_recebido,
    substring(v.cnpj_limpo, 10, 1)::int as digito2_recebido
  from valida v
)
select
  c.tem_14_digitos and
  c.nao_eh_zeros and
  c.digito1_esperado = c.digito1_recebido and
  c.digito2_esperado = c.digito2_recebido
from checksum c;
$$;

comment on function private.cnpj_valido(text) is
  'Valida CNPJ: formato (14 dígitos), rejeita zeros (00000000000000), e checksum (RFC 10291). Imutável, segura para índices e views.';

-- 2) Recriar v_marca_ocorrencias com validação de CNPJ em entra_ranking
-- O único ponto que muda: entra_ranking agora usa private.cnpj_valido() em vez de regex simples
create or replace view public.v_marca_ocorrencias
with (security_invoker = true)
as
with fontes as (
  -- Fonte 1: Pesquisa de Preço do Compras.gov (vencedor do item; uma linha = uma venda)
  select 'precos_praticados'::text as fonte,
         p.id_compra || ':' || p.id_item_compra::text as ref_item,
         p.ni_fornecedor as ni,
         p.marca as marca_bruta,
         p.data_resultado as data_venda,
         p.quantidade * p.preco_unitario as valor
    from public.precos_praticados_itens p
   where p.data_resultado is not null
  -- PONTO DE EXTENSÃO (outro PR, com create or replace view mantendo as colunas):
  --   union all Paradigma/SFIEC: licitacao_resultados com vencedor = true e situacao <> 'Cancelado' (marca, cnpj)
  --   union all catálogo de fabricantes, se virar fonte de "quem vende"
),
-- Resolve cada par (marca, NI) distinto uma vez só. A chave é o próprio par, com NULL e '' distintos: com
-- coalesce(…, '') como chave, NULL e '' do mesmo NI viravam dois pares com a mesma chave e cada venda casava
-- com os dois (ocorrência duplicada).
-- Sem MATERIALIZED de propósito: inline, o filtro por CNPJ desce até fontes e o resolvedor só roda para as vendas
-- daquele CNPJ. Medido com 100 mil vendas sintéticas (95 mil com data, 59 711 pares): v_fornecedor_marcas de 1 CNPJ
-- 0,27 s (311 chamadas) sem MATERIALIZED x 6,3 s (59 711 chamadas) com; a varredura completa custa 10,4 s (uma
-- chamada por venda, 95 015) x 6,8 s com. O uso esperado é por fornecedor; carga em lote deve materializar no
-- consumidor (tabela ou materialized view), não aqui.
pares as (
  select distinct f.marca_bruta, f.ni
    from fontes f
),
resolvidos as (
  select pr.marca_bruta, pr.ni, r.marca_norm, r.marca, r.metodo, r.curada, r.alias_id
    from pares pr
    cross join lateral private.marca_resolver(pr.marca_bruta, pr.ni) r
)
select f.fonte,
       f.ref_item,
       f.ni,
       case when f.ni ~ '^[0-9]{14}$' then 'cnpj' when f.ni ~ '^[0-9]{11}$' then 'cpf' else 'outro' end as ni_tipo,
       f.marca_bruta,
       r.marca_norm,
       r.marca,
       r.metodo,
       r.curada,
       r.alias_id,
       f.data_venda,
       f.valor,
       (private.cnpj_valido(f.ni) and r.marca is not null) as entra_ranking  -- Valida CNPJ com checksum, rejeita 00000000000000
  from fontes f
  join resolvidos r
    on r.marca_bruta is not distinct from f.marca_bruta
   and r.ni is not distinct from f.ni
   and coalesce(r.marca_bruta, '') = coalesce(f.marca_bruta, '')
   and coalesce(r.ni, '') = coalesce(f.ni, '');

comment on view public.v_marca_ocorrencias is
  'Uma linha por item vendido (hoje: precos_praticados_itens com data_resultado) com a marca resolvida por private.marca_resolver. ni_tipo cnpj/cpf/outro; entra_ranking = CNPJ válido (checksum RFC 10291) e marca não nula. Rejeita 00000000000000 e CNPJs com checksum errado. Ponto de extensão para Paradigma e catálogo. security_invoker; SELECT só service_role.';

-- 3) ACL: private.cnpj_valido() é security invoker (usa o mesmo que quem chama)
-- Revoga tudo de novo porque é função nova
revoke all on function private.cnpj_valido(text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.cnpj_valido(text) to service_role;

commit;
