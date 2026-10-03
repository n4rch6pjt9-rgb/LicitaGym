-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261004003000_orgao_tipo_secretaria_esporte.
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
--   prioridade:    unique (nivel, prioridade); regra de prioridade menor que 645/1170 vence (hospital, saúde, educação,
--                  privado por tipo de adm./natureza, Forças Armadas), maior perde (prefeitura, fundação, fundo, secretaria).
--   grupo_pai:     UASG sob pai secretaria_esporte/educação/universidade/segurança/nulo/Forças Armadas não usa a 1170;
--                  sob executivo municipal/estadual usa.
--   override:      linhas com override mantêm o tipo do override (dados); nenhum override para o tipo novo.
--   dados:         nenhum órgão/UASG com nome de esporte ficou com tipo diferente do que as regras dão hoje (a
--                  reclassificação rodou; só linhas já classificadas, as demais ficam para o job das 05:03) e todo secretaria_esporte tem grupo esporte_lazer e poder E.

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
          ('ESPORTE CLUBE FICTÍCIO', null, 'M', null, 'outros'),
          -- OSC/OSCIP sem tipo de administração nem natureza (review Codex P2 no #184): exclusão OSC(IP)?S?
          ('OSCIP ESPORTE PARA TODOS', null, null, null, 'outros'),
          ('OSCIP ESPORTE PARA TODOS FICTÍCIA', null, 'M', null, 'outros'),
          ('OSC ESPORTE E CIDADANIA FICTÍCIA', null, null, null, 'outros'),
          ('OSCIPS DE ESPORTE FICTÍCIAS', null, null, null, 'outros'),
          -- controles positivos: secretaria de esporte sem sufixo e município com OSCAR no nome (não é OSC)
          ('SECRETARIA MUNICIPAL DE ESPORTES', null, 'M', 12, 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE ESPORTES', null, null, null, 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE ESPORTES DE OSCARLÂNDIA FICTÍCIA', null, 'M', 12, 'secretaria_esporte')) x(nome, natureza, esfera, tipo_adm, esperado)
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
          ('QUALQUER UNIDADE', 'secretaria_esporte', 'secretaria_esporte'),
          -- OSC/OSCIP sob prefeitura/governo (lookahead OSC(IP)?S?) e controles positivos
          ('OSCIP ESPORTE PARA TODOS', 'prefeitura', 'prefeitura'),
          ('OSCIP ESPORTE PARA TODOS', 'governo_estadual', 'governo_estadual'),
          ('OSC ESPORTE E CIDADANIA FICTICIA', 'prefeitura', 'prefeitura'),
          ('SECRETARIA MUNICIPAL DE ESPORTES', 'prefeitura', 'secretaria_esporte'),
          ('SECRETARIA MUNICIPAL DE ESPORTES DE OSCARLANDIA FICTICIA', 'prefeitura', 'secretaria_esporte')) x(nome, pai, esperado)
      union all
      select 'comportamento', 'fn_esfera_canon(M/E/F) e fn_poder_canon de secretaria_esporte', 'M/E/F/E',
             public.fn_esfera_canon('1031', 'M', null, 'SP', 'secretaria_esporte') || '/' ||
             public.fn_esfera_canon(null, 'E', null, 'PR', 'secretaria_esporte') || '/' ||
             public.fn_esfera_canon(null, 'F', null, 'DF', 'secretaria_esporte') || '/' ||
             public.fn_poder_canon('secretaria_esporte', null)
      union all
      -- prioridade: sem empate (unique (nivel, prioridade)) e a 645/1170 são únicas no seu nível
      select 'prioridade', 'unique (nivel, prioridade) em orgao_tipo_regras', '1',
             (select count(*)::text from pg_index i
               where i.indrelid = 'public.orgao_tipo_regras'::regclass and i.indisunique
                 and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                       where a.attrelid = i.indrelid and a.attnum = any (i.indkey)) = array['nivel', 'prioridade'])
      union all
      select 'prioridade', 'regras com prioridade 645 (órgão) / 1170 (UASG): sem empate', '1/1',
             (select count(*) filter (where nivel = 'orgao' and prioridade = 645) || '/' ||
                     count(*) filter (where nivel = 'uasg' and prioridade = 1170) from public.orgao_tipo_regras)
      union all
      -- prioridade de órgão: regra de prioridade MENOR que 645 vence; MAIOR perde (nomes sintéticos)
      select 'prioridade', 'fn_classifica_orgao(' || x.nome || ' nat=' || coalesce(x.natureza, '-') || ' adm=' || coalesce(x.tipo_adm::text, '-') || ')',
             x.esperado, (public.fn_classifica_orgao(x.nome, x.natureza, x.esfera, x.tipo_adm, x.codigo, null)).tipo_orgao
        from (values
          -- menor que 645 vence
          ('HOSPITAL MUNICIPAL DO ESPORTE DE CIDADE FICTÍCIA', null, 'M', 12, null, 'hospital'),                         -- 620
          ('SECRETARIA MUNICIPAL DE SAÚDE E ESPORTES DE CIDADE FICTÍCIA', null, 'M', 12, null, 'secretaria_fundo_saude'),  -- 630
          ('SECRETARIA DE ESTADO DE EDUCAÇÃO E DESPORTO FICTÍCIA', null, 'E', 11, null, 'secretaria_educacao'),           -- 640
          ('INSTITUTO DE ESPORTES FICTÍCIO', null, 'M', 15, null, 'entidade_privada'),                                    -- 270 (adm 15)
          ('INSTITUTO DE ESPORTES FICTÍCIO', '3999', 'M', null, null, 'entidade_privada'),                                -- 280 (natureza 3)
          ('CENTRO DE DESPORTOS DO EXERCITO FICTÍCIO', null, 'F', 1, null, 'forcas_armadas_exercito'),                    -- 340
          ('COMISSAO DE DESPORTOS FICTÍCIA', null, 'F', 1, 52121, 'forcas_armadas_exercito'),                              -- 10 (código)
          -- maior que 645 perde
          ('PREFEITURA MUNICIPAL DE CIDADE FICTÍCIA - SECRETARIA DE ESPORTES', null, 'M', 12, null, 'secretaria_esporte'), -- 650
          ('FUNDAÇÃO DE ESPORTES DE CIDADE FICTÍCIA', '1120', 'M', 14, null, 'secretaria_esporte'),                       -- 940/950
          ('FUNDO MUNICIPAL DE ESPORTES DE CIDADE FICTÍCIA', '1333', 'M', 7, null, 'secretaria_esporte'),                 -- 820/850/880
          ('SUPERINTENDÊNCIA DE DESPORTOS DO ESTADO FICTÍCIO', '1112', 'E', 13, null, 'secretaria_esporte'),              -- 910/920
          ('SECRETARIA DE ESTADO DO ESPORTE FICTÍCIA', '1023', 'E', 11, null, 'secretaria_esporte')                        -- 990-1060
        ) x(nome, natureza, esfera, tipo_adm, codigo, esperado)
      union all
      -- grupo do órgão-pai na UASG (fn_classifica_uasg(nome, tipo do pai)): 1170 só sob executivo_municipal/estadual
      select 'grupo_pai', 'fn_classifica_uasg(' || x.nome || ' / ' || coalesce(x.pai, 'NULL') || ')', x.esperado,
             (public.fn_classifica_uasg(x.nome, x.pai)).tipo_orgao
        from (values
          -- pai que vira secretaria_esporte (grupo esporte_lazer): herda, salvo regra sem restrição de grupo
          ('DIVISAO DE ESPORTES', 'secretaria_esporte', 'secretaria_esporte'),
          ('ASSOCIACAO DESPORTIVA FICTICIA', 'secretaria_esporte', 'secretaria_esporte'),
          ('BATALHAO DE POLICIA MILITAR FICTICIO', 'secretaria_esporte', 'secretaria_esporte'),  -- 1100 exige grupo de segurança/estadual
          ('HOSPITAL MUNICIPAL DO ESPORTE', 'secretaria_esporte', 'hospital'),                 -- 1150 sem restrição de grupo
          -- pai educação (secretaria mista continua educação): 1170 não vale para o grupo educacao
          ('COORDENACAO DE ESPORTES', 'secretaria_educacao', 'secretaria_educacao'),
          ('SECRETARIA MUNICIPAL DE EDUCACAO E ESPORTES', 'secretaria_educacao', 'secretaria_educacao'),
          ('DEPARTAMENTO DE DESPORTOS', 'universidade_estadual_municipal', 'universidade_estadual_municipal'),
          -- pai executivo municipal/estadual: 1170 vale
          ('DIVISAO DE ESPORTES', 'secretaria_municipal', 'secretaria_esporte'),
          ('DIVISAO DE ESPORTES', 'fundo_municipal', 'secretaria_esporte'),
          ('SUPERINTENDENCIA DE ESPORTES', 'subprefeitura', 'secretaria_esporte'),
          ('COORDENADORIA DE ESPORTES', 'secretaria_estadual', 'secretaria_esporte'),
          -- grupo fora da lista, pai nulo e Forças Armadas
          ('DIVISAO DE ESPORTES', 'secretaria_seguranca_publica', 'secretaria_seguranca_publica'),
          ('SECRETARIA DE ESPORTES', null, 'outros'),
          ('COMISSAO DE DESPORTOS DO EXERCITO', 'forcas_armadas_exercito', 'forcas_armadas_exercito'),
          -- prioridade de UASG: menor que 1170 vence mesmo sob prefeitura/governo
          ('HOSPITAL DO ESPORTE FICTICIO', 'prefeitura', 'hospital'),                                  -- 1150
          ('BATALHAO DE POLICIA MILITAR - DESPORTOS', 'governo_estadual', 'policia_militar')         -- 1100
        ) x(nome, pai, esperado)
      union all
      -- override manual: nunca muda (dados reais; o caso sintético ponta a ponta está em
      -- orgao_tipo_secretaria_esporte_fixtures_check.sql, banco local)
      select 'override', 'órgãos com override e tipo/origem diferente do override', '0',
             (select count(*)::text from public.orgaos o join public.orgao_tipo_override ov
                on ov.nivel = 'orgao' and ov.chave = o.codigo_orgao::text
               where o.classificado_em is not null
                 and (o.tipo_orgao is distinct from ov.tipo_orgao or o.tipo_orgao_origem is distinct from 'override'))
      union all
      select 'override', 'UASGs com override e tipo/origem diferente do override', '0',
             (select count(*)::text from public.uasgs u join public.orgao_tipo_override ov
                on ov.nivel = 'uasg' and ov.chave = u.codigo_uasg
               where u.classificado_em is not null
                 and (u.tipo_orgao is distinct from ov.tipo_orgao or u.tipo_orgao_origem is distinct from 'override'))
      union all
      select 'override', 'nenhum override aponta para secretaria_esporte (a migration não cria override)', '0',
             (select count(*)::text from public.orgao_tipo_override where tipo_orgao = 'secretaria_esporte')
      union all
      -- dados: reclassificação aplicada (só linhas com nome de esporte, barato; sem override)
      select 'dados', 'órgãos classificados com nome de esporte e tipo diferente das regras', '0',
             (select count(*)::text from public.orgaos o
               where public.fn_norm_nome(coalesce(o.nome_orgao, o.razao_social)) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
                 and coalesce(o.tipo_orgao_origem, '') <> 'override' and o.classificado_em is not null
                 and o.tipo_orgao is distinct from (public.fn_classifica_orgao(coalesce(o.nome_orgao, o.razao_social),
                       o.natureza_juridica, coalesce(o.esfera, o.pncp_esfera), o.codigo_tipo_administracao, o.codigo_orgao,
                       o.codigo_orgao_vinculado)).tipo_orgao)
      union all
      select 'dados', 'UASGs classificadas com nome de esporte e tipo diferente das regras', '0',
             (select count(*)::text from public.uasgs u left join public.orgaos o on o.id = u.orgao_id
               where public.fn_norm_nome(u.nome_uasg) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
                 and coalesce(u.tipo_orgao_origem, '') <> 'override' and u.classificado_em is not null
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
