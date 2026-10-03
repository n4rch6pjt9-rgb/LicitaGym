-- LicitaGym: tipo de órgão secretaria_esporte (grupo "Esporte e lazer") no filtro "Tipo de órgão".
-- Aprovado pelo Marcelo em 02/10/2026. Número: rascunho 20261002235000 -> 20261003203000 -> 20261003234000 (03/10, depois
-- de 20261003230000_orgaos_classificar_escopo_separado (#185, já em prod) e de 20261003233000 (#148)). Nenhuma migration
-- posterior a 20260930130100 alterou fn_classifica_orgao/fn_classifica_uasg/fn_orgaos_uasgs_classificar nem os
-- dicionários usados aqui (a 20261003230000 só separa os jobs e mexe no escopo).
-- Roda DEPOIS de 20260930130100_orgaos_uasgs_filtros (PR 1b), que criou os
-- dicionários orgao_tipos/orgao_tipo_regras e as funções fn_classifica_orgao/fn_classifica_uasg/
-- fn_orgaos_uasgs_classificar usadas aqui. Não muda estrutura nem função: só dicionário + reclassificação das candidatas.
--
-- O que faz:
--   orgao_tipos        + secretaria_esporte -> grupo esporte_lazer ("Esporte e lazer"), logo depois de Saúde
--                      (ordem_grupo 8, ordem 34); os grupos/tipos seguintes andam uma posição (Outros continua por
--                      último: 16/54). Esfera e poder não são colunas do dicionário: saem de fn_esfera_canon
--                      (natureza > Compras > PNCP: secretaria municipal = M, estadual = E/D, Ministério = F) e de
--                      fn_poder_canon (grupo fora de legislativo/judiciário/privados/paraestatais = E). Nada muda nelas.
--   orgao_tipo_regras  + 2 regras:
--     órgão  645  logo depois de saúde (630) e educação (640) e antes de prefeitura (650), fundos (800-880),
--                 autarquias/fundações por natureza ou tipo de administração (890-960) e das genéricas de secretaria
--                 municipal/estadual (970-1060). Casa ESPORTE(S), ESPORTIVO(A), DESPORTO(S), PARADESPORTO,
--                 PARAESPORTE, abreviação "ESPORT" e "ESP(.) (E) LAZER"/"ES LAZER" sobre fn_norm_nome(nome).
--                 Exclui nome de entidade privada (ASSOCIAÇÃO, CLUBE, LIGA, FEDERAÇÃO, GRÊMIO, SOCIEDADE, COMITÊ,
--                 ONG/OSC, EMPRESA, COMPANHIA), loteria, ensino (EDU*, ESCOLA, COLÉGIO, UNIVERSIDADE, FACULDADE) e
--                 SAÚDE: secretaria mista de educação e esporte continua secretaria_educacao (por extenso já vencia
--                 na 640; abreviada, "SEC. EST. EDUC. CULTURA E ESPORTE", não vira esporte e fica como hoje).
--                 Entram fundação, autarquia, fundo, superintendência e instituto públicos de esporte (FUNDAÇÃO
--                 MUNICIPAL DE ESPORTES, PARANÁ ESPORTE, FUNDESPORTE): são o comprador da política de esporte no
--                 município/estado (mesma demanda de material esportivo e academia) e o tipo é único por órgão; a
--                 forma jurídica continua em natureza_juridica/codigo_tipo_administracao. É o mesmo critério de
--                 secretaria_fundo_saude (secretaria + fundo). Entra também o Ministério do Esporte (esfera F).
--                 Entidade privada não chega aqui: as regras 270/280 (tipo de administração 15, natureza 2/3/4)
--                 vêm antes, e a exclusão por nome cobre o resto.
--     UASG  1170  depois das de segurança, hospital e IF (1090-1160). Só sob órgão dono dos grupos
--                 executivo_municipal ou executivo_estadual (UASG "SECRETARIA MUNICIPAL DE ESPORTES" de uma
--                 prefeitura, "SECRETARIA DO ESPORTE" de um governo de estado). Fica de fora sob executivo_federal:
--                 lá estão os ~460 convenentes privados do órgão 44444 (Transferência voluntária/SICONV) com nome
--                 de associação esportiva; as UASGs do Ministério do Esporte herdam o tipo do órgão. Universidade,
--                 educação e Forças Armadas também ficam de fora (centro de educação física, comissão de desportos
--                 herdam o tipo do dono). fn_classifica_uasg não lê nome_regex_exclui, então a exclusão de nome
--                 privado/ensino/saúde vai num lookahead negativo no próprio nome_regex.
--   reclassificação    SÓ das linhas candidatas, com as mesmas funções e fórmulas de fn_orgaos_uasgs_classificar()
--                      (override > regras > padrão; grupo, esfera e poder canônicos), sem reavaliar 57 mil linhas:
--                        órgão: nome normalizado casa o termo da regra 645 (a única forma de a regra nova mudar um
--                               órgão) e já classificado (classificado_em não nulo);
--                        UASG:  nome casa o termo (a 1170 exige o mesmo termo) ou o órgão pai é candidato (o tipo do
--                               pai muda), e já classificada.
--                      Linha ainda não classificada fica para o job diário licitagym-orgaos-classificar (05:03 BRT,
--                      fn_orgaos_uasgs_classificar() completa). A esfera usa orgaos.uf já gravado pela última
--                      classificação (o tipo novo não muda a localização). Equivalência: depois desta migration,
--                      fn_orgaos_uasgs_classificar() completa altera 0 linhas (teste local sobre a carga real).
--                      seguranca_defesa_uasgs é recalculado só nos órgãos pais das UASGs candidatas.
--
-- Não toca estrutura, função, grant, supabase/functions/** nem escopo_termos/orgao_tipo_override. Idempotente: o
-- remanejamento de ordem só roda se o tipo ainda não existe; seeds com "on conflict do nothing"; a 2ª chamada de
-- reaplicação altera 0 linhas, e a 1ª chamada seguinte de fn_orgaos_uasgs_classificar() também.
-- Verificação (só leitura; erra se algo falhar): supabase/tests/orgao_tipo_secretaria_esporte_check.sql e
-- supabase/tests/orgaos_uasgs_filtros_check.sql (contagens e md5 dos dicionários atualizados aqui).

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';
-- Só candidatas (dezenas de órgãos, centenas de UASGs): segundos. Teto curto para não segurar a transação.
set local statement_timeout = '2min';

-- 1) Tipo novo: grupo esporte_lazer logo depois de Saúde (7). Remaneja a ordem só na 1ª execução. ---------------
do $$
begin
  if not exists (select 1 from public.orgao_tipos where tipo_orgao = 'secretaria_esporte') then
    update public.orgao_tipos set ordem_grupo = ordem_grupo + 1 where ordem_grupo >= 8;
    update public.orgao_tipos set ordem = ordem + 1 where ordem >= 34;
  end if;
end $$;

INSERT INTO public.orgao_tipos (tipo_orgao, grupo_tipo, rotulo, grupo_rotulo, ordem_grupo, ordem) VALUES
  ('secretaria_esporte', 'esporte_lazer', 'Secretaria/fundação de esporte e lazer', 'Esporte e lazer', 8, 34)
on conflict (tipo_orgao) do nothing;

-- 2) Regras (menor prioridade vence; condições não nulas da linha são AND) ------------------------------------
INSERT INTO public.orgao_tipo_regras (prioridade, nivel, tipo_orgao, nome_regex, nome_regex_exclui, codigos_orgao, codigos_orgao_vinculado, tipos_administracao, aceita_tipo_adm_nulo, naturezas, natureza_regex, esferas, grupos_orgao_pai, aceita_grupo_pai_nulo, observacao) VALUES
  (645, 'orgao', 'secretaria_esporte',
   '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y',
   '\y(ASSOC\w*|CLUBE|LIGA|FEDERAC\w*|CONFEDERAC\w*|GREMIO|AGREMIACAO|SOCIEDADE|COMITE|ONG|OSC|EMPRESA|COMPANHIA|LOTERIA\w*|EDU\w*|ESCOLA|COLEGIO|UNIVERSIDADE|FACULDADE|SAUDE)\y',
   NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false,
   'secretaria/fundacao/autarquia/fundo/ministerio de esporte; depois de saude (630) e educacao (640), antes das genericas de secretaria (970-1060)'),
  (1170, 'uasg', 'secretaria_esporte',
   '^(?!.*\y(ASSOC\w*|CLUBE|LIGA|FEDERAC\w*|CONFEDERAC\w*|GREMIO|AGREMIACAO|SOCIEDADE|COMITE|ONG|OSC|EMPRESA|COMPANHIA|LOTERIA\w*|EDU\w*|ESCOLA|COLEGIO|UNIVERSIDADE|FACULDADE|SAUDE)\y).*(\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y)',
   NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['executivo_municipal','executivo_estadual']::text[], false,
   'UASG de esporte sob prefeitura/governo/secretaria (nao federal: convenentes SICONV); exclusao no lookahead')
on conflict (nivel, prioridade) do nothing;

-- 3) Reclassifica só as candidatas (mesma lógica de fn_orgaos_uasgs_classificar; override > regras > padrão) -------
-- 3a) órgãos candidatos: termo de esporte no nome (condição positiva da regra 645), já classificados
with c as (
  select o.id,
         coalesce(ov.tipo_orgao, cl.tipo_orgao) as tipo,
         case when ov.tipo_orgao is not null then 'override' when cl.regra_id is null then 'padrao' else 'regra' end as origem,
         case when ov.tipo_orgao is null then cl.regra_id end as regra_id
    from public.orgaos o
    left join public.orgao_tipo_override ov on ov.nivel = 'orgao' and ov.chave = o.codigo_orgao::text
    cross join lateral public.fn_classifica_orgao(coalesce(o.nome_orgao, o.razao_social), o.natureza_juridica,
                        coalesce(o.esfera, o.pncp_esfera), o.codigo_tipo_administracao, o.codigo_orgao, o.codigo_orgao_vinculado) cl
   where o.classificado_em is not null
     and public.fn_norm_nome(coalesce(o.nome_orgao, o.razao_social)) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
), n as (
  select c.*, t.grupo_tipo,
         public.fn_esfera_canon(o.natureza_juridica, o.esfera, o.pncp_esfera, o.uf, c.tipo) as esf,
         public.fn_poder_canon(c.tipo, o.natureza_juridica) as pod
    from c join public.orgaos o on o.id = c.id join public.orgao_tipos t on t.tipo_orgao = c.tipo
)
update public.orgaos o
   set tipo_orgao = n.tipo, grupo_tipo = n.grupo_tipo, tipo_orgao_origem = n.origem, tipo_orgao_regra_id = n.regra_id,
       esfera_canon = n.esf, poder_canon = n.pod, classificado_em = now()
  from n
 where o.id = n.id
   and (o.tipo_orgao, o.grupo_tipo, o.tipo_orgao_origem, o.tipo_orgao_regra_id, o.esfera_canon, o.poder_canon)
       is distinct from (n.tipo, n.grupo_tipo, n.origem, n.regra_id, n.esf, n.pod);

-- 3b) UASGs candidatas: termo no nome ou pai candidato (o tipo do pai já é o novo, gravado em 3a), já classificadas
with cand as (
  select u.id from public.uasgs u
   where u.classificado_em is not null and public.fn_norm_nome(u.nome_uasg) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
  union
  select u.id from public.uasgs u join public.orgaos o on o.id = u.orgao_id
   where u.classificado_em is not null
     and public.fn_norm_nome(coalesce(o.nome_orgao, o.razao_social)) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
), c as (
  select u.id, o.tipo_orgao as tipo_pai, o.esfera_canon as esf_pai, o.natureza_juridica,
         ov.tipo_orgao as tipo_ov, cl.tipo_orgao as tipo_cl, cl.regra_id
    from cand
    join public.uasgs u on u.id = cand.id
    left join public.orgaos o on o.id = u.orgao_id
    left join public.orgao_tipo_override ov on ov.nivel = 'uasg' and ov.chave = u.codigo_uasg
    cross join lateral public.fn_classifica_uasg(u.nome_uasg, o.tipo_orgao) cl
), n as (
  select c.id, coalesce(c.tipo_ov, c.tipo_cl) as tipo, t.grupo_tipo,
         case when c.tipo_ov is not null then 'override' when c.regra_id is not null then 'regra_uasg' else 'herdado' end as origem,
         case when c.tipo_ov is null then c.regra_id end as regra_id,
         coalesce(c.esf_pai, 'N') as esf,
         public.fn_poder_canon(coalesce(c.tipo_ov, c.tipo_cl), c.natureza_juridica) as pod
    from c join public.orgao_tipos t on t.tipo_orgao = coalesce(c.tipo_ov, c.tipo_cl)
)
update public.uasgs u
   set tipo_orgao = n.tipo, grupo_tipo = n.grupo_tipo, tipo_orgao_origem = n.origem, tipo_orgao_regra_id = n.regra_id,
       esfera_canon = n.esf, poder_canon = n.pod, classificado_em = now()
  from n
 where u.id = n.id
   and (u.tipo_orgao, u.grupo_tipo, u.tipo_orgao_origem, u.tipo_orgao_regra_id, u.esfera_canon, u.poder_canon)
       is distinct from (n.tipo, n.grupo_tipo, n.origem, n.regra_id, n.esf, n.pod);

-- 3c) seguranca_defesa_uasgs só dos órgãos pais das UASGs candidatas (UASG de segurança pode passar a herdar esporte)
update public.orgaos o set seguranca_defesa_uasgs = s.n
  from (select o2.id, count(u.id) filter (where u.seguranca_defesa and u.ativo)::int as n
          from public.orgaos o2 left join public.uasgs u on u.orgao_id = o2.id
         where o2.id in (select u3.orgao_id from public.uasgs u3
                          where u3.orgao_id is not null and public.fn_norm_nome(u3.nome_uasg) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y')
            or public.fn_norm_nome(coalesce(o2.nome_orgao, o2.razao_social)) ~ '\y(PARA)?D?ESPORT|\yESP?( E)? LAZER\y'
         group by o2.id) s
 where o.id = s.id and o.seguranca_defesa_uasgs is distinct from s.n;

commit;
