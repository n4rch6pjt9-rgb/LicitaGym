-- #262 (P1), spec specs/0002-marcas-cnpj-valido.md. Follow-up de #148/#228; refaz o que o #236 tentou (revertido no #241).
--
-- Contexto (medição só leitura em produção, 09/10/2026):
--   1. private.cnpj_valido (20261005160000) calcula os DV sobre os dígitos 1-8 e 1-9 e compara com as posições 9 e 10.
--      Dos 2.706 CNPJs de 14 dígitos em precos_praticados_itens aceita 102; vendas elegíveis 1.133 de 25.465. Com o
--      módulo 11 da Receita (DV1 sobre os 12 primeiros dígitos, DV2 sobre os 13) são 2.706 e 25.459. Nenhum CNPJ
--      inválido é aceito hoje. Também não tinha search_path fixo (advisor function_search_path_mutable).
--   2. private.marca_normalizar colapsava a frase repetida uma vez só: 'X X X X' -> 'X X', e normalizar de novo
--      dava 'X'. Agora repete até o ponto fixo (idempotente). Pela #262, 0 das 25.465 marcas de hoje mudam.
--   3. private.marca_resolver: entre aliases regex, o manual (revisao_manual) vence a semente mesmo se o padrão da
--      semente for mais longo. Exato e prefixo continuam como antes (prefixo mais longo vence).
--
-- O #236 falhou no db push com 42P13 ("cannot change name of input parameter"): create or replace não renomeia
-- parâmetro. Aqui os nomes são os de produção (cnpj_bruto; p_valor; p_marca, p_cnpj) e uma pré-checagem aborta
-- antes de qualquer DDL se a assinatura for outra. Owner, grants e volatilidade ficam iguais.
-- Só create or replace (aditivo, idempotente). As views dependentes leem as funções na hora: sem backfill.
-- Verificação: supabase/tests/marcas_resolvedor_acl_check.sql (blocos 7 e 8), marcas_resolvedor_views_check.sql
-- (casos A, D, E, N, O, P), advisors_warn_security_check.sql; depois do merge, skill verificar-producao + get_advisors.

begin;

set local lock_timeout = '5s';

-- 0) Pré-checagem: assinaturas iguais às de produção (senão 42P13 no meio da migration)
do $pre$
declare
  v_div text;
begin
  select string_agg(format('%s: esperado (%s), atual (%s)', e.fn, e.args, coalesce(pg_get_function_identity_arguments(to_regprocedure(e.fn)), 'ausente')), '; ')
    into v_div
    from (values ('private.cnpj_valido(text)', 'cnpj_bruto text'),
                 ('private.marca_normalizar(text)', 'p_valor text'),
                 ('private.marca_resolver(text,text)', 'p_marca text, p_cnpj text')) as e(fn, args)
   where to_regprocedure(e.fn) is null
      or pg_get_function_identity_arguments(to_regprocedure(e.fn)) <> e.args;
  if v_div is not null then
    raise exception '20261009030000: assinatura divergente, nada foi alterado: %', v_div
      using hint = 'create or replace não renomeia parâmetro (42P13, #236). Ajuste a migration ao que está no banco.';
  end if;
end $pre$;

-- 1) CNPJ: módulo 11 da Receita --------------------------------------------------------------------------------
create or replace function private.cnpj_valido(cnpj_bruto text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  with d as (select regexp_replace(coalesce(cnpj_bruto, ''), '[^0-9]', '', 'g') as v)
  select case
           -- 14 dígitos, nem todos iguais (00000000000000 passa no módulo 11 e não existe; os outros já caem no DV)
           when d.v !~ '^[0-9]{14}$' or d.v ~ '^([0-9])\1{13}$' then false
           else (
             select (case when x.s1 % 11 < 2 then 0 else 11 - x.s1 % 11 end) = substr(d.v, 13, 1)::int
                and (case when x.s2 % 11 < 2 then 0 else 11 - x.s2 % 11 end) = substr(d.v, 14, 1)::int
               from (select
                       (select sum(substr(d.v, i, 1)::int * (array[5,4,3,2,9,8,7,6,5,4,3,2])[i])
                          from generate_series(1, 12) as i) as s1,
                       (select sum(substr(d.v, i, 1)::int * (array[6,5,4,3,2,9,8,7,6,5,4,3,2])[i])
                          from generate_series(1, 13) as i) as s2) as x)
         end
    from d
$fn$;

comment on function private.cnpj_valido(text) is
  'CNPJ (com ou sem máscara) -> true se tem 14 dígitos, não são todos iguais e os dois DV conferem pelo módulo 11 da Receita (DV1 sobre os 12 primeiros dígitos, DV2 sobre os 13). NULL, vazio ou outro tamanho -> false. Só CNPJ numérico: o alfanumérico da Receita dá false (follow-up da #262). EXECUTE só service_role.';

-- 2) Normalização idempotente ----------------------------------------------------------------------------------
create or replace function private.marca_normalizar(p_valor text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  with recursive base as (
    select btrim(regexp_replace(
             regexp_replace(
               regexp_replace(
                 upper(translate(p_valor,
                   'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
                   'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY')),
                 '[^A-Z0-9&]+', ' ', 'g'),
               '(^| )LTDA(?= |$)', ' ', 'g'),
             ' +', ' ', 'g')) as s
  ),
  -- 'X X' -> 'X' até não mudar mais: 'X X X X' -> 'X X' -> 'X'. Cada passo divide o tamanho por 2: 32 passos sobram.
  colapso(s, passo) as (
    select b.s, 0 from base b
    union all
    select regexp_replace(c.s, '^(.+) \1$', '\1'), c.passo + 1
      from colapso c
     where c.s ~ '^(.+) \1$' and c.passo < 32
  )
  select nullif(c.s, '') from colapso c order by c.passo desc limit 1
$fn$;

comment on function private.marca_normalizar(text) is
  'Marca -> forma normalizada: maiúsculas, sem acento, sem LTDA, pontuação vira espaço, espaços colapsados, frase repetida colapsada até o ponto fixo (idempotente: normalizar(normalizar(x)) = normalizar(x)); vazio -> NULL. Repetição ímpar (X X X) fica como está. EXECUTE só service_role.';

-- 3) Resolvedor: entre regex, manual vence semente -------------------------------------------------------------
create or replace function private.marca_resolver(p_marca text, p_cnpj text)
returns table (marca_norm text, marca text, metodo text, curada boolean, alias_id bigint)
language sql
stable
set search_path = ''
as $fn$
  with n as (select private.marca_normalizar(p_marca) as v)
  select n.v, r.marca, r.metodo, r.curada, r.alias_id
    from n
    cross join lateral (
      select c.marca, c.metodo, c.curada, c.alias_id
        from (
          select a.marca,
                 case when a.tipo = 'nao_marca' then 'nao_marca' else 'alias_' || a.modo end as metodo,
                 -- curada = resolvida por alias que aponta marca (semente ou manual; revisao_manual não entra)
                 a.tipo <> 'nao_marca' as curada, a.id as alias_id,
                 1 as grupo, a.cnpj_escopo is null as global,
                 case a.modo when 'exato' then 0 when 'prefixo' then 1 else 2 end as ordem_modo,
                 length(a.valor_norm) as tamanho, a.revisao_manual as manual
            from public.marca_aliases a
           where n.v is not null
             and a.ativo
             and btrim(a.valor_norm) <> ''  -- defesa extra: padrão vazio nunca casa (a constraint já recusa)
             and (a.cnpj_escopo is null or a.cnpj_escopo = p_cnpj)
             and case a.modo
                   when 'exato' then a.valor_norm = n.v
                   when 'prefixo' then n.v = a.valor_norm or left(n.v, length(a.valor_norm) + 1) = a.valor_norm || ' '
                   else n.v ~ a.valor_norm
                 end
          union all
          -- sem alias: vazio, código de modelo/medida ou prefixo COD/MOD/REF -> não conta. Código/medida = começa
          -- com até 4 letras + dígito E (não tem palavra de 5+ letras OU tem medida: 10KG, 75CM, 60X30). Assim
          -- "3 SECONDS FITNESS", "3G FITNESS" e "D1FITNESS" ficam como marca; "1130PC", "R55V5", "LLM014" não.
          select null, case when n.v is null or length(n.v) < 2 then 'vazio' else 'codigo_ou_medida' end,
                 false, null, 2, true, 0, 0, false
            from n
           where n.v is null or length(n.v) < 2
              or (n.v ~ '^[A-Z]{0,4} ?[0-9]'
                  and (n.v !~ '[A-Z]{5,}' or n.v ~ '[0-9] ?(KG|KGS|CM|MM|MT|ML|LT|X)( |$|[0-9])'))
              or n.v ~ '^(COD|MOD|MODELO|REF)( |$)'
          union all
          select n.v, 'bruta', false, null, 3, true, 0, 0, false
            from n
        ) c
       -- #262: entre regex (ordem_modo 2), manual vem antes do tamanho; exato e prefixo seguem tamanho desc
       order by c.grupo, c.global, c.ordem_modo, (c.ordem_modo = 2 and c.manual) desc, c.tamanho desc, c.manual desc,
                c.alias_id
       limit 1
    ) r
$fn$;

comment on function private.marca_resolver(text, text) is
  'Marca bruta + CNPJ -> (marca_norm, marca canônica ou NULL, metodo, curada, alias_id). Ordem: escopo do CNPJ > global; exato > prefixo mais longo > regex (manual > semente, depois o mais longo); sem alias: vazio/código/medida -> NULL, senão a string normalizada (curada=false). curada = resolvida por alias (semente ou manual), não revisada por pessoa. EXECUTE só service_role.';

-- 4) ACL (igual à de produção; create or replace já preserva, aqui fica explícito)
revoke all on function private.cnpj_valido(text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.cnpj_valido(text) to service_role;
revoke all on function private.marca_normalizar(text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.marca_normalizar(text) to service_role;
revoke all on function private.marca_resolver(text, text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.marca_resolver(text, text) to service_role;

-- 5) Pós-checagem: os aliases existentes continuam válidos nos CHECKs que usam marca_normalizar (CHECK não é
-- revalidado sozinho quando a função muda); e a função nova responde ao caso conhecido.
do $pos$
declare
  v_n bigint;
begin
  if to_regclass('public.marca_aliases') is not null then
    select count(*) into v_n
      from public.marca_aliases a
     where not (
             (a.marca is null or (private.marca_normalizar(a.marca) is not null and a.marca = private.marca_normalizar(a.marca)))
         and ((a.modo in ('exato', 'prefixo') and private.marca_normalizar(a.valor_norm) is not null
                and a.valor_norm = private.marca_normalizar(a.valor_norm))
              or (a.modo = 'regex' and not ('' ~ a.valor_norm))));
    if v_n > 0 then
      raise exception '20261009030000: % linha(s) de marca_aliases deixariam de passar nos CHECKs com a função nova', v_n;
    end if;
  end if;
  if private.cnpj_valido('11.222.333/0001-81') is not true or private.cnpj_valido('11222333000180') is not false then
    raise exception '20261009030000: cnpj_valido não confere com o módulo 11 nos casos conhecidos';
  end if;
end $pos$;

commit;
