-- LicitaGym: tipo de órgão secretaria_esporte (grupo "Esporte e lazer") no filtro "Tipo de órgão".
-- Aprovado pelo Marcelo em 02/10/2026 (rascunho 20261002235000, renumerado em 03/10 para depois da última migration
-- da main, 20261003180000; nenhuma migration posterior a 20260930130100 alterou as funções/dicionários usados aqui).
-- Roda DEPOIS de 20260930130100_orgaos_uasgs_filtros (PR 1b), que criou os
-- dicionários orgao_tipos/orgao_tipo_regras e as funções fn_classifica_orgao/fn_classifica_uasg/
-- fn_orgaos_uasgs_classificar usadas aqui. Não muda estrutura nem função: só dicionário + reclassificação.
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
--   reclassificação    public.fn_orgaos_uasgs_classificar() (override > regras > padrão; idempotente). Sem UPDATE
--                      avulso. Com orgaos/uasgs carregados (12 mil/45 mil) leva ~6 min de CPU: statement_timeout
--                      local de 30 min (o lote 40 da carga usa 20 min; no teste local com a máquina
--                      sobrecarregada, 20 min não bastaram).
--
-- Não toca estrutura, função, grant, supabase/functions/** nem escopo_termos/orgao_tipo_override. Idempotente: o
-- remanejamento de ordem só roda se o tipo ainda não existe; seeds com "on conflict do nothing"; a 2ª chamada de
-- fn_orgaos_uasgs_classificar() altera 0 linhas.
-- Verificação (só leitura; erra se algo falhar): supabase/tests/orgao_tipo_secretaria_esporte_check.sql e
-- supabase/tests/orgaos_uasgs_filtros_check.sql (contagens e md5 dos dicionários atualizados aqui).

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';
-- Reclassificação de 12 mil órgãos e 45 mil UASGs (~6 min de CPU medidos no teste da carga).
set local statement_timeout = '30min';

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

-- 3) Reclassifica órgãos e UASGs pelas funções do PR 1b (override > regras > padrão; esfera/poder canônicos) ----
select * from public.fn_orgaos_uasgs_classificar();

commit;
