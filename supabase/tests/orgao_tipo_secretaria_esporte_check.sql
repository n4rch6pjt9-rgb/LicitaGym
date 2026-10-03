-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261003203000_orgao_tipo_secretaria_esporte.
-- Só SELECT nos dicionários, em orgaos/uasgs e chamadas das funções PURAS (fn_classifica_orgao, fn_classifica_uasg,
-- fn_esfera_canon, fn_poder_canon, fn_norm_nome) sobre literais sintéticos. Não chama fn_orgaos_uasgs_classificar().
-- Executar após aplicar a migration (1a e 1b também aplicadas), ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/orgao_tipo_secretaria_esporte_check.sql
-- Resultado esperado: NOTICE "orgao_tipo_secretaria_esporte_check: N checagens, 0 falhas" e exit code 0. Sem a
-- migration o tipo e as regras não existem e o script termina com RAISE EXCEPTION (exit code <> 0).
--
-- O que confere:
--   dicionário:    secretaria_esporte -> esporte_lazer ("Esporte e lazer"), ordem_grupo 8 / ordem 34; ordem 1..N
--                  sem buraco nem repetição; cada grupo com um só ordem_grupo; Outros por último.
--   regras:        órgão 645 e UASG 1170 de secretaria_esporte, ativas, regex compilam; a de órgão vence as
--                  genéricas de secretaria municipal/estadual (prioridade menor que 970) e perde para saúde/educação.
--   comportamento: nomes sintéticos de secretaria/fundação/fundo de esporte viram secretaria_esporte; educação + esporte
--                  continua educação; associação/clube/liga, "turismo e lazer" e "juventude" sozinhos não viram;
--                  UASG de esporte sob prefeitura/governo vira, sob órgão federal, universidade ou Forças Armadas não;
--                  esfera/poder canônicos do tipo novo.
--   dados:         nenhum órgão/UASG com nome de esporte ficou com tipo diferente do que as regras dão hoje (a
--                  reclassificação rodou) e todo secretaria_esporte tem grupo esporte_lazer e poder E.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  if to_regclass('public.orgao_tipos') is null or to_regclass('public.orgao_tipo_regras') is null
     or to_regprocedure('public.fn_classifica_orgao(text, text, text, integer, integer, integer)') is null
     or to_regprocedure('public.fn_classifica_uasg(text, text)') is null then
    raise exception 'orgao_tipo_secretaria_esporte_check FALHOU: dicionários/funções do PR 1b ausentes';
  end if;

  for v_chk in execute $q$
    with checks(grupo, objeto, esperado, atual) as (
      select 'dicionario', 'secretaria_esporte: grupo/rotulo/grupo_rotulo/ordem_grupo/ordem',
             'esporte_lazer|Secretaria/fundação de esporte e lazer|Esporte e lazer|8|34',
             (select format('%s|%s|%s|%s|%s', grupo_tipo, rotulo, grupo_rotulo, ordem_grupo, ordem)
                from public.orgao_tipos where tipo_orgao = 'secretaria_esporte')
      union all
      select 'dicionario', 'ordem 1..N sem buraco nem repetição', 'ok',
             (select case when count(*) = count(distinct ordem) and min(ordem) = 1 and max(ordem) = count(*) then 'ok'
                          else format('n=%s distintos=%s min=%s max=%s', count(*), count(distinct ordem), min(ordem), max(ordem)) end
                from public.orgao_tipos)
      union all
      select 'dicionario', 'grupos: um ordem_grupo por grupo, 1..G sem repetição', 'ok',
             (select case when bool_and(n_ord = 1) and count(*) = count(distinct og) and min(og) = 1 and max(og) = count(*)
                          then 'ok' else 'grupos inconsistentes' end
                from (select grupo_tipo, count(distinct ordem_grupo) n_ord, min(ordem_grupo) og
                        from public.orgao_tipos group by grupo_tipo) g)
      union all
      select 'dicionario', 'Outros por último', 'outros',
             (select tipo_orgao from public.orgao_tipos order by ordem_grupo desc, ordem desc limit 1)
      union all
      select 'dicionario', 'Saúde antes de Esporte e lazer antes de Legislativo', 'saude<esporte_lazer<legislativo',
             (select string_agg(grupo_tipo, '<' order by og) from (select grupo_tipo, min(ordem_grupo) og from public.orgao_tipos
                where grupo_tipo in ('saude', 'esporte_lazer', 'legislativo') group by grupo_tipo) g)
      union all
      select 'regras', 'secretaria_esporte: nivel/prioridade ativas', 'orgao/645,uasg/1170',
             (select string_agg(nivel || '/' || prioridade, ',' order by prioridade)
                from public.orgao_tipo_regras where tipo_orgao = 'secretaria_esporte' and ativo)
      union all
      select 'regras', 'UASG 1170: grupos do órgão dono', '{executivo_municipal,executivo_estadual}',
             (select grupos_orgao_pai::text from public.orgao_tipo_regras where nivel = 'uasg' and prioridade = 1170)
      union all
      select 'regras', 'órgão 645 vence as genéricas de secretaria e perde para saúde/educação', 'ok',
             (select case when max(prioridade) filter (where tipo_orgao in ('secretaria_fundo_saude', 'secretaria_educacao') and nome_regex is not null)
                               < min(prioridade) filter (where tipo_orgao = 'secretaria_esporte')
                           and min(prioridade) filter (where tipo_orgao = 'secretaria_esporte')
                               < min(prioridade) filter (where tipo_orgao in ('secretaria_municipal', 'secretaria_estadual', 'prefeitura',
                                                                          'autarquia_fundacao_municipal', 'autarquia_fundacao_estadual', 'fundo_municipal'))
                          then 'ok' else 'ordem errada' end
                from public.orgao_tipo_regras where nivel = 'orgao')
      union all
      -- classificação de órgão (nomes sintéticos; esfera de entrada como viria do Compras)
      select 'comportamento', 'fn_classifica_orgao(' || x.nome || ')', x.esperado,
             (public.fn_classifica_orgao(x.nome, x.natureza, x.esfera, x.tipo_adm, null, null)).tipo_orgao
        from (values
          ('SECRETARIA MUNICIPAL DE ESPORTES DE CIDADE FICTÍCIA', null, 'M', 12, 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE ESPORTE DE CIDADE FICTÍCIA', null, 'M', 12, 'secretaria_esporte'),
          ('SEC. DE ESPORTES E LAZER', null, 'M', 12, 'secretaria_esporte'),
          ('SECRETARIA DE ESTADO DO ESPORTE', null, 'E', 11, 'secretaria_esporte'),
          ('FUNDAÇÃO MUNICIPAL DE ESPORTES DE CIDADE FICTÍCIA', '1120', 'M', 4, 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE JUVENTUDE, ESPORTE E LAZER', null, 'M', 12, 'secretaria_esporte'),
          ('SECRETARIA DE ESTADO DA JUVENTUDE, ESP. E LAZER', null, 'E', 11, 'secretaria_esporte'),
          ('FUNDO MUNICIPAL DE DESPORTO E LAZER', '1333', 'M', 7, 'secretaria_esporte'),
          ('MINISTÉRIO DO ESPORTE', null, 'F', 1, 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE EDUCAÇÃO E ESPORTES', null, 'M', 12, 'secretaria_educacao'),
          ('SECRETARIA EST. EDUC. CULTURA E ESPORTE', null, 'E', 11, 'secretaria_estadual'),
          ('SECRETARIA MUNICIPAL DE TURISMO E LAZER', null, 'M', 12, 'secretaria_municipal'),
          ('SECRETARIA MUNICIPAL DA JUVENTUDE', null, 'M', 12, 'secretaria_municipal'),
          ('ASSOCIAÇÃO DESPORTIVA FICTÍCIA', null, 'M', null, 'outros'),
          ('ESPORTE CLUBE FICTÍCIO', null, 'M', null, 'outros')) x(nome, natureza, esfera, tipo_adm, esperado)
      union all
      select 'comportamento', 'fn_classifica_uasg(' || x.nome || ' / ' || x.pai || ')', x.esperado,
             (public.fn_classifica_uasg(x.nome, x.pai)).tipo_orgao
        from (values
          ('SECRETARIA MUNICIPAL DE ESPORTES E LAZER', 'prefeitura', 'secretaria_esporte'),
          ('SECRETARIA DO ESPORTE E LAZER', 'governo_estadual', 'secretaria_esporte'),
          ('FUNDAÇÃO MUNICIPAL DE ESPORTES', 'governo_estadual', 'secretaria_esporte'),
          ('ASSOCIACAO DESPORTIVA FICTICIA', 'governo_estadual', 'governo_estadual'),
          ('SECRETARIA DE EDUCACAO E ESPORTES', 'governo_estadual', 'governo_estadual'),
          ('ASSOCIACAO ESPORTIVA FICTICIA', 'ministerio_orgao_federal', 'ministerio_orgao_federal'),
          ('SECRETARIA NACIONAL DE ESPORTE', 'ministerio_orgao_federal', 'ministerio_orgao_federal'),
          ('CENTRO DE EDUCACAO FISICA E DESPORTOS', 'universidade_federal', 'universidade_federal'),
          ('COMISSAO DE DESPORTOS DA MARINHA', 'forcas_armadas_marinha', 'forcas_armadas_marinha'),
          ('QUALQUER UNIDADE', 'secretaria_esporte', 'secretaria_esporte')) x(nome, pai, esperado)
      union all
      select 'comportamento', 'fn_esfera_canon(M/E/F) e fn_poder_canon de secretaria_esporte', 'M/E/F/E',
             public.fn_esfera_canon('1031', 'M', null, 'SP', 'secretaria_esporte') || '/' ||
             public.fn_esfera_canon(null, 'E', null, 'PR', 'secretaria_esporte') || '/' ||
             public.fn_esfera_canon(null, 'F', null, 'DF', 'secretaria_esporte') || '/' ||
             public.fn_poder_canon('secretaria_esporte', null)
      union all
      -- dados: reclassificação aplicada (só linhas com nome de esporte, barato; sem override)
      select 'dados', 'órgãos com nome de esporte e tipo diferente das regras', '0',
             (select count(*)::text from public.orgaos o
               where public.fn_norm_nome(coalesce(o.nome_orgao, o.razao_social)) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
                 and coalesce(o.tipo_orgao_origem, '') <> 'override'
                 and o.tipo_orgao is distinct from (public.fn_classifica_orgao(coalesce(o.nome_orgao, o.razao_social),
                       o.natureza_juridica, coalesce(o.esfera, o.pncp_esfera), o.codigo_tipo_administracao, o.codigo_orgao,
                       o.codigo_orgao_vinculado)).tipo_orgao)
      union all
      select 'dados', 'UASGs com nome de esporte e tipo diferente das regras', '0',
             (select count(*)::text from public.uasgs u left join public.orgaos o on o.id = u.orgao_id
               where public.fn_norm_nome(u.nome_uasg) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
                 and coalesce(u.tipo_orgao_origem, '') <> 'override'
                 and u.tipo_orgao is distinct from (public.fn_classifica_uasg(u.nome_uasg, o.tipo_orgao)).tipo_orgao)
      union all
      select 'dados', 'secretaria_esporte com grupo/poder inconsistente (orgaos+uasgs)', '0',
             (select (count(*) filter (where grupo_tipo is distinct from 'esporte_lazer' or poder_canon is distinct from 'E'))::text
                from (select grupo_tipo, poder_canon from public.orgaos where tipo_orgao = 'secretaria_esporte'
                      union all
                      select grupo_tipo, poder_canon from public.uasgs where tipo_orgao = 'secretaria_esporte') x)
    )
    select * from checks order by grupo, objeto $q$
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  -- regex das regras novas compilam no ARE
  n := n + 1;
  begin
    perform 1 from public.orgao_tipo_regras r, unnest(array[r.nome_regex, r.nome_regex_exclui]) x
     where r.tipo_orgao = 'secretaria_esporte' and x is not null and '' ~ x;
  exception when others then
    f := f + 1;
    raise notice 'FALHA [regras] regex de secretaria_esporte inválida: %', sqlerrm;
  end;

  raise notice 'orgao_tipo_secretaria_esporte_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'orgao_tipo_secretaria_esporte_check FALHOU: % de % checagens', f, n;
  end if;
end $$;
