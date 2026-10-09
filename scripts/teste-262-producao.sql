-- Teste do Marcelo para a #262 (regra de 03/10): só leitura, statement_timeout 20 s, nada é gravado.
-- Rode ANTES e DEPOIS do merge, no SQL Editor do Supabase (cole o arquivo inteiro) ou com scripts/teste-262-producao.sh.
--
-- Saída esperada (contagens de 09/10/2026; a base cresce com a coleta, então os números podem subir um pouco):
--   ANTES   md5_cnpj_valido = 8facd335d32286cba681a314a54f6afb | search_path = (vazio) | cnpj_validos = 102
--           | cnpj_14_digitos = 2706 | vendas_no_ranking = 917 (medido na #262 em 08/10) | normalizar_nao_idempotente = 0
--   DEPOIS  md5_cnpj_valido = 93c4f56b407d7712c60be16bf639a8a3 | search_path = search_path="" | cnpj_validos = 2706 (= cnpj_14_digitos)
--           | vendas_no_ranking perto de 18.495 | normalizar_nao_idempotente = 0
begin read only;
set local statement_timeout = '20s';

select md5(pg_get_functiondef('private.cnpj_valido(text)'::regprocedure)) as md5_cnpj_valido,
       coalesce(array_to_string(p.proconfig, ','), '(vazio)') as search_path,
       (select count(*) from (select distinct ni_fornecedor from public.precos_praticados_itens
                               where ni_fornecedor ~ '^[0-9]{14}$') n
         where private.cnpj_valido(n.ni_fornecedor)) as cnpj_validos,
       (select count(distinct ni_fornecedor) from public.precos_praticados_itens
         where ni_fornecedor ~ '^[0-9]{14}$') as cnpj_14_digitos,
       (select count(*) from public.v_marca_ocorrencias where entra_ranking) as vendas_no_ranking,
       (select count(*) from (select distinct marca from public.precos_praticados_itens) m
         where private.marca_normalizar(private.marca_normalizar(m.marca)) is distinct from private.marca_normalizar(m.marca))
         as normalizar_nao_idempotente
  from pg_proc p
 where p.oid = 'private.cnpj_valido(text)'::regprocedure;

rollback;
