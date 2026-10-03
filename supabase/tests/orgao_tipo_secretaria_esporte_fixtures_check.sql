-- =============================================================================
-- Casos sintéticos PONTA A PONTA da migration 20261003234000_orgao_tipo_secretaria_esporte (banco LOCAL de teste).
--
-- Roda a rotina de escrita real, public.fn_orgaos_uasgs_classificar(), sobre órgãos/UASGs 100% fictícios (códigos
-- 99999xx, nomes "FICTÍCIO") e overrides fictícios. Tudo fica dentro de begin; ... rollback;. Tem uma trava: aborta se
-- public.orgaos tiver mais de 100 linhas, ou seja, nunca roda em produção nem em banco com carga, porque a
-- classificação percorre a tabela inteira.
-- Uso: banco descartável só com as migrations (sem carga):
--   psql "$DB_LOCAL" -v ON_ERROR_STOP=1 -f supabase/tests/orgao_tipo_secretaria_esporte_fixtures_check.sql
-- Saída esperada: NOTICE "orgao_tipo_secretaria_esporte_fixtures_check: N checagens, 0 falhas" e ROLLBACK.
--
-- Casos:
--   O1  secretaria municipal de esportes                -> secretaria_esporte (regra 645, origem regra)
--     U11 unidade administrativa sob O1                  -> herda secretaria_esporte (pai vira esporte)
--     U12 hospital sob O1                                -> hospital (1150, sem restrição de grupo, vence)
--     U13 batalhão de PM sob O1                          -> herda secretaria_esporte (1100 exige grupo de segurança/estadual)
--     U14 "DIVISAO DE ESPORTES" sob O1 com override UASG -> secretaria_municipal (override vence a regra e a herança)
--   O2  fundação de esportes com override de órgão      -> autarquia_fundacao_municipal (override; não pode mudar)
--     U21 "SECRETARIA DE ESPORTES" sob O2                -> secretaria_esporte (1170: pai override é executivo_municipal)
--   O3  secretaria mista educação e esportes            -> secretaria_educacao (640 vence 645)
--     U31 "COORDENACAO DE ESPORTES" sob O3               -> herda secretaria_educacao (1170 não vale para grupo educacao)
--   O4  prefeitura fictícia                              -> prefeitura
--     U41 "SECRETARIA MUNICIPAL DE ESPORTES E LAZER"     -> secretaria_esporte (1170, origem regra_uasg)
--     U42 "ASSOCIACAO DESPORTIVA FICTICIA"               -> herda prefeitura (exclusão de entidade privada no lookahead)
--   O5  órgão federal (natureza 1015), UASG de esporte -> U51 herda ministerio_orgao_federal (1170 fora do federal)
--   O6  "OSCIP ESPORTE PARA TODOS FICTÍCIA", sem tipo de administração nem natureza -> outros|padrao (exclusão OSC(IP)?S?)
--   O7  "OSC ESPORTE E CIDADANIA FICTÍCIA", idem          -> outros|padrao
--   O8  "SECRETARIA MUNICIPAL DE ESPORTES" (controle +)  -> secretaria_esporte|regra
--     U43 "OSCIP ESPORTE PARA TODOS FICTICIA" sob O4     -> herda prefeitura (lookahead OSC(IP)?S?)
--     U44 "OSC ESPORTE E CIDADANIA FICTICIA" sob O4      -> herda prefeitura
--     U45 "SECRETARIA MUNICIPAL DE ESPORTES" sob O4      -> secretaria_esporte (controle +, regra_uasg)
--     U46 "SEC MUN DE ESPORTES DE OSCARLANDIA FICTICIA"  -> secretaria_esporte (OSCAR não é OSC)
--   I   2ª chamada de fn_orgaos_uasgs_classificar()      -> 0/0 (idempotente)
--   G   secretaria_esporte com grupo esporte_lazer e poder E
-- =============================================================================

begin;

do $$
declare
  n int := 0;
  f int := 0;
  v record;
  r record;
begin
  if (select count(*) from public.orgaos) > 100 then
    raise exception 'orgao_tipo_secretaria_esporte_fixtures_check: public.orgaos tem mais de 100 linhas; só roda em banco local de teste';
  end if;
  if not exists (select 1 from public.orgao_tipos where tipo_orgao = 'secretaria_esporte') then
    raise exception 'orgao_tipo_secretaria_esporte_fixtures_check: migration 20261003234000 não aplicada';
  end if;

  insert into public.orgaos (codigo_orgao, nome_orgao, natureza_juridica, esfera, codigo_tipo_administracao, compras_raw, compras_payload_hash)
  values
    (9999901, 'SECRETARIA MUNICIPAL DE ESPORTES DE CIDADE FICTÍCIA', null, 'M', 12, '{}'::jsonb, 'fixture'),
    (9999902, 'FUNDAÇÃO MUNICIPAL DE ESPORTES FICTÍCIA', '1120', 'M', 14, '{}'::jsonb, 'fixture'),
    (9999903, 'SECRETARIA MUNICIPAL DE EDUCAÇÃO E ESPORTES FICTÍCIA', null, 'M', 12, '{}'::jsonb, 'fixture'),
    (9999904, 'PREFEITURA MUNICIPAL DE CIDADE FICTÍCIA', null, 'M', 12, '{}'::jsonb, 'fixture'),
    (9999905, 'ÓRGÃO FEDERAL FICTÍCIO', '1015', 'F', 1, '{}'::jsonb, 'fixture'),
    (9999906, 'OSCIP ESPORTE PARA TODOS FICTÍCIA', null, null, null, '{}'::jsonb, 'fixture'),
    (9999907, 'OSC ESPORTE E CIDADANIA FICTÍCIA', null, null, null, '{}'::jsonb, 'fixture'),
    (9999908, 'SECRETARIA MUNICIPAL DE ESPORTES', null, 'M', 12, '{}'::jsonb, 'fixture');

  insert into public.uasgs (codigo_uasg, nome_uasg, orgao_id, sigla_uf, ativo, raw, payload_hash)
  select x.codigo, x.nome, o.id, 'SP', true, '{}'::jsonb, 'fixture'
    from (values
      ('999911', 'DIVISAO ADMINISTRATIVA FICTICIA', 9999901),
      ('999912', 'HOSPITAL MUNICIPAL FICTICIO', 9999901),
      ('999913', 'BATALHAO DE POLICIA MILITAR FICTICIO', 9999901),
      ('999914', 'DIVISAO DE ESPORTES FICTICIA', 9999901),
      ('999921', 'SECRETARIA DE ESPORTES FICTICIA', 9999902),
      ('999931', 'COORDENACAO DE ESPORTES FICTICIA', 9999903),
      ('999941', 'SECRETARIA MUNICIPAL DE ESPORTES E LAZER FICTICIA', 9999904),
      ('999942', 'ASSOCIACAO DESPORTIVA FICTICIA', 9999904),
      ('999943', 'OSCIP ESPORTE PARA TODOS FICTICIA', 9999904),
      ('999944', 'OSC ESPORTE E CIDADANIA FICTICIA', 9999904),
      ('999945', 'SECRETARIA MUNICIPAL DE ESPORTES', 9999904),
      ('999946', 'SEC MUN DE ESPORTES DE OSCARLANDIA FICTICIA', 9999904),
      ('999951', 'COORDENACAO DE ESPORTES FICTICIA FEDERAL', 9999905)) x(codigo, nome, codigo_orgao)
    join public.orgaos o on o.codigo_orgao = x.codigo_orgao;

  insert into public.orgao_tipo_override (nivel, chave, tipo_orgao, motivo) values
    ('orgao', '9999902', 'autarquia_fundacao_municipal', 'fixture: override manual não pode mudar'),
    ('uasg',  '999914',  'secretaria_municipal',         'fixture: override manual de UASG');

  perform public.fn_orgaos_uasgs_classificar();

  for v in
    select * from (values
      ('orgao', '9999901', 'secretaria_esporte|regra'),
      ('orgao', '9999902', 'autarquia_fundacao_municipal|override'),
      ('orgao', '9999903', 'secretaria_educacao|regra'),
      ('orgao', '9999904', 'prefeitura|regra'),
      ('orgao', '9999905', 'ministerio_orgao_federal|regra'),
      ('orgao', '9999906', 'outros|padrao'),
      ('orgao', '9999907', 'outros|padrao'),
      ('orgao', '9999908', 'secretaria_esporte|regra'),
      ('uasg',  '999911',  'secretaria_esporte|herdado'),
      ('uasg',  '999912',  'hospital|regra_uasg'),
      ('uasg',  '999913',  'secretaria_esporte|herdado'),
      ('uasg',  '999914',  'secretaria_municipal|override'),
      ('uasg',  '999921',  'secretaria_esporte|regra_uasg'),
      ('uasg',  '999931',  'secretaria_educacao|herdado'),
      ('uasg',  '999941',  'secretaria_esporte|regra_uasg'),
      ('uasg',  '999942',  'prefeitura|herdado'),
      ('uasg',  '999943',  'prefeitura|herdado'),
      ('uasg',  '999944',  'prefeitura|herdado'),
      ('uasg',  '999945',  'secretaria_esporte|regra_uasg'),
      ('uasg',  '999946',  'secretaria_esporte|regra_uasg'),
      ('uasg',  '999951',  'ministerio_orgao_federal|herdado')) x(nivel, chave, esperado)
  loop
    n := n + 1;
    select case when v.nivel = 'orgao'
                then (select o.tipo_orgao || '|' || o.tipo_orgao_origem from public.orgaos o where o.codigo_orgao = v.chave::int)
                else (select u.tipo_orgao || '|' || u.tipo_orgao_origem from public.uasgs u where u.codigo_uasg = v.chave) end as atual
      into r;
    if r.atual is distinct from v.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v.nivel, v.chave, v.esperado, r.atual;
    end if;
  end loop;

  -- G: grupo/poder do tipo novo
  n := n + 1;
  if exists (select 1 from (select grupo_tipo, poder_canon from public.orgaos where tipo_orgao = 'secretaria_esporte'
                            union all select grupo_tipo, poder_canon from public.uasgs where tipo_orgao = 'secretaria_esporte') x
              where grupo_tipo is distinct from 'esporte_lazer' or poder_canon is distinct from 'E') then
    f := f + 1; raise notice 'FALHA [G] secretaria_esporte com grupo/poder inconsistente';
  end if;

  -- I: idempotência
  n := n + 1;
  select * into r from public.fn_orgaos_uasgs_classificar();
  if r.orgaos_alterados <> 0 or r.uasgs_alteradas <> 0 then
    f := f + 1; raise notice 'FALHA [I] 2ª classificação alterou %/%', r.orgaos_alterados, r.uasgs_alteradas;
  end if;

  raise notice 'orgao_tipo_secretaria_esporte_fixtures_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'orgao_tipo_secretaria_esporte_fixtures_check FALHOU: % de % checagens', f, n;
  end if;
end $$;

rollback;
