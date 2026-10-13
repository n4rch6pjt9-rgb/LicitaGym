-- LicitaGym: catálogo da empresa, taxonomia da esteira no slug do dicionário (PR #356).
--
-- Por quê: a primeira versão da api-catalogo-ficha gravou catalogo_produtos.no_taxonomia = 'ESTEIRA ERGOMETRICA',
--   um texto que não existe no dicionário v0.3 nem em ontologia_atributos, taxonomia_no_pdm e catalogo_de_para.
--   O nó canônico é o slug esteira_eletrica ("esteira ergométrica" é só sinônimo dele). Em 13/10/2026, só leitura:
--   1 linha com esse valor; catalogo_produto_atributos só tem o atributo 'medida' (os nomes de tela da primeira
--   versão nunca chegaram a produção).
-- O que muda: só dado, 1 linha: no_taxonomia 'ESTEIRA ERGOMETRICA' -> 'esteira_eletrica'. Nenhum DDL, nenhuma ACL.
-- Quem lê: service_role, pela api-catalogo-ficha (a função nova nunca mais grava o texto antigo).
-- Verificar: supabase/tests/catalogo_esteira_slug_check.sql. Idempotente (o update não acha linha na segunda vez).

begin;

set local lock_timeout = '5s';

update public.catalogo_produtos
   set no_taxonomia = 'esteira_eletrica'
 where no_taxonomia = 'ESTEIRA ERGOMETRICA';

commit;
