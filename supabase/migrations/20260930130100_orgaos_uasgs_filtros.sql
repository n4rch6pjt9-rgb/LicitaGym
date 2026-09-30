-- LicitaGym: filtros de órgão/UASG no estilo Conlicitação (esfera, poder, UF, município IBGE, tipo de órgão)
-- e match com o escopo do projeto (material esportivo, musculação/academia, piso emborrachado).
-- PR 1b do plano órgãos/UASG. Roda DEPOIS de 20260930130000_compras_orgaos_uasgs (PR 1a), de que depende
-- (colunas Compras de orgaos e tabela uasgs). Especificação: FILTROS.md §4 e §5 (29/09/2026).
--
-- O que cria:
--   dicionários  orgao_tipos (53 tipos em 15 grupos; seguranca_defesa gerada), orgao_tipo_regras (116 regras:
--                108 de órgão e 8 de UASG), orgao_tipo_override (5 correções pontuais) e escopo_termos (232 termos:
--                exclusão com janela de 70 caracteres, núcleo por família, adjacente, recreação do PCA). Seeds com
--                "on conflict do nothing". Manutenção só por migration.
--   funções      puras: fn_txt_ascii, fn_norm_item, fn_norm_nome, fn_escopo_item, fn_escopo_pca, fn_classifica_orgao,
--                fn_classifica_uasg, fn_esfera_canon, fn_poder_canon (search_path fixo);
--                rotinas de escrita: fn_orgaos_uasgs_classificar() e fn_escopo_match_atualizar() (idempotentes:
--                a 2ª execução altera 0 linhas). Rodam só pelo pg_cron como postgres (job do PR 3); nenhuma role de
--                API tem EXECUTE nelas.
--   colunas      orgaos: natureza_juridica, pncp_esfera/pncp_poder, pncp_orgao_lido_em, tipo_orgao/grupo_tipo
--                (FK composta para orgao_tipos), tipo_orgao_origem/tipo_orgao_regra_id, esfera_canon/poder_canon,
--                uf/municipio_ibge/localizacao_origem, seguranca_defesa (gerada), seguranca_defesa_uasgs,
--                match_nivel/match_projeto (gerada), match_atualizado_em, classificado_em.
--                uasgs: tipo_orgao/grupo_tipo, tipo_orgao_origem/tipo_orgao_regra_id, esfera_canon/poder_canon,
--                municipio_ibge (gerada de codigo_municipio_ibge), cnpj_cpf_orgao_vinculado_norm (gerada, lpad 14),
--                pncp_municipio_ibge/pncp_conferido_em, seguranca_defesa (gerada), match_nivel/match_projeto (gerada),
--                match_atualizado_em, classificado_em.
--   índices      de filtro em orgaos/uasgs, joins UASG x CNPJ, licitacoes_externas(orgao_cnpj) e ((raw->>'unidade_codigo')).
--   MV           mv_escopo_demanda (licitações+itens+resultados, editais e PCA 7830 no escopo), criada WITH NO DATA:
--                é populada na 1ª execução de fn_escopo_match_atualizar() (PR 3). Até lá v_orgao_match_projeto
--                responde "materialized view has not been populated".
--   views        security_invoker: v_orgao_titular_cnpj, v_orgao_match_projeto, v_licitacoes_filtro (leitura da
--                api-orgaos-uasgs, PR 4, com service_role).
--
-- Acesso (default ACL do schema public dá ALL a anon/authenticated/service_role em objeto novo: REVOKE explícito):
--   anon/authenticated/PUBLIC: nada (tabelas, sequences, MV, views, funções).
--   service_role: SELECT nos dicionários, na MV e nas views; EXECUTE só nas funções puras (as views
--   security_invoker as chamam com o privilégio de quem consulta); sem escrita nos dicionários e sem EXECUTE
--   nas duas rotinas. As colunas novas de orgaos/uasgs herdam o CRUD de service_role da 1a.
--
-- Não escreve dado de órgão/UASG nem de licitação: só estrutura e os seeds dos dicionários. Não toca
-- supabase/functions/**. RLS ligado nos 4 dicionários. Idempotente (pode rodar duas vezes).
-- Verificação (só leitura; erra se algo falhar): supabase/tests/orgaos_uasgs_filtros_check.sql

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';

-- 1) Dicionários --------------------------------------------------------------------------------------------
create table if not exists public.orgao_tipos (
  tipo_orgao        text primary key,
  grupo_tipo        text not null,
  rotulo            text not null,
  grupo_rotulo      text not null,
  ordem_grupo       smallint not null,
  ordem             smallint not null,
  seguranca_defesa  boolean generated always as (grupo_tipo = 'seguranca_defesa') stored,
  constraint orgao_tipos_tipo_grupo_key unique (tipo_orgao, grupo_tipo)
);
comment on table public.orgao_tipos is 'Taxonomia fechada tipo_orgao -> grupo_tipo (filtro "Tipo de órgão"). Alterar só por migration.';

create table if not exists public.orgao_tipo_regras (
  id                       bigint generated always as identity primary key,
  prioridade               integer not null,
  nivel                    text not null,
  tipo_orgao               text not null,
  nome_regex               text,          -- ARE do Postgres sobre fn_norm_nome(nome): MAIÚSCULAS, sem acento/pontuação, sem prefixo "XXX-"
  nome_regex_exclui        text,
  codigos_orgao            integer[],     -- codigo_orgao (SIAFI) do próprio órgão
  codigos_orgao_vinculado  integer[],     -- codigo_orgao_vinculado
  tipos_administracao      integer[],     -- codigo_tipo_administracao do Compras
  aceita_tipo_adm_nulo     boolean not null default false,
  naturezas                text[],        -- codigoNaturezaJuridica (PNCP/Receita), 4 dígitos
  natureza_regex           text,
  esferas                  text[],        -- esfera de entrada (Compras; F implícito se codigo_orgao < 70000)
  grupos_orgao_pai         text[],        -- só nivel uasg: grupo do órgão dono
  aceita_grupo_pai_nulo    boolean not null default false,
  ativo                    boolean not null default true,
  observacao               text,
  created_at               timestamptz not null default now(),
  constraint orgao_tipo_regras_nivel_check check (nivel in ('orgao', 'uasg')),
  constraint orgao_tipo_regras_tipo_orgao_fkey foreign key (tipo_orgao) references public.orgao_tipos (tipo_orgao),
  constraint orgao_tipo_regras_prioridade_key unique (nivel, prioridade),
  constraint orgao_tipo_regras_tem_condicao check (
    nome_regex is not null or codigos_orgao is not null or codigos_orgao_vinculado is not null
    or tipos_administracao is not null or naturezas is not null or natureza_regex is not null)
);
comment on table public.orgao_tipo_regras is 'Regras ordenadas (menor prioridade vence) de classificação de tipo_orgao. Todas as condições não nulas da linha são AND. Alterar só por migration.';

create table if not exists public.orgao_tipo_override (
  id          bigint generated always as identity primary key,
  nivel       text not null,
  chave       text not null,      -- codigo_orgao (texto) ou codigo_uasg
  tipo_orgao  text not null,
  motivo      text not null,
  created_at  timestamptz not null default now(),
  constraint orgao_tipo_override_nivel_check check (nivel in ('orgao', 'uasg')),
  constraint orgao_tipo_override_tipo_orgao_fkey foreign key (tipo_orgao) references public.orgao_tipos (tipo_orgao),
  constraint orgao_tipo_override_key unique (nivel, chave)
);
comment on table public.orgao_tipo_override is 'Correção manual pontual (vence as regras). Ex.: UASGs de apoio da PMESP com nome genérico. Alterar só por migration.';

create table if not exists public.escopo_termos (
  id                 bigint generated always as identity primary key,
  prioridade         integer not null,
  nivel              text not null,
  familia            text,
  padrao             text not null,   -- ARE sobre fn_norm_item(descricao): minúsculas, sem acento, sem HTML
  janela_caracteres  integer,         -- exclusão só nos N primeiros caracteres (70)
  ativo              boolean not null default true,
  observacao         text,
  constraint escopo_termos_prioridade_key unique (prioridade),
  constraint escopo_termos_nivel_check check (nivel in ('exclusao', 'nucleo', 'adjacente', 'recreacao_pca')),
  constraint escopo_termos_familia_check check (familia is null or familia in
    ('musculacao_academia', 'material_esportivo', 'piso_emborrachado', 'superficie_esportiva')),
  constraint escopo_termos_familia_ck check ((nivel in ('nucleo', 'adjacente')) = (familia is not null))
);
comment on table public.escopo_termos is 'Termos do match de itens com o escopo LicitaGym (musculação/academia, material esportivo, piso emborrachado; adjacente = grama sintética/granulado). Alterar só por migration.';

-- 2) Funções puras de normalização e classificação ---------------------------------------------------------
create or replace function public.fn_txt_ascii(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT regexp_replace(
           translate(coalesce(t, ''),
             'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝýÿºª²³¹´¨¸',
             'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNnYyyoa231   '),
           '[^\x01-\x7f]', '', 'g')
$$;

create or replace function public.fn_norm_item(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT regexp_replace(regexp_replace(lower(public.fn_txt_ascii(t)), '<[^>]+>', ' ', 'g'), '\s+', ' ', 'g')
$$;

create or replace function public.fn_norm_nome(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT btrim(regexp_replace(regexp_replace(
           regexp_replace(upper(public.fn_txt_ascii(t)), '^\s*[A-Z]{2,4}\s?-\s?', ''),
           '[^A-Z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- Match de item: (nivel, familia) ou (NULL, NULL). Exclusão dura nos 70 primeiros caracteres vence.
create or replace function public.fn_escopo_item(p_descricao text, OUT nivel text, OUT familia text)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE d text := public.fn_norm_item(p_descricao);
BEGIN
  IF d = '' OR EXISTS (SELECT 1 FROM public.escopo_termos t
                        WHERE t.ativo AND t.nivel = 'exclusao'
                          AND left(d, coalesce(t.janela_caracteres, length(d))) ~ t.padrao) THEN
    RETURN;
  END IF;
  SELECT t.nivel, t.familia INTO nivel, familia
    FROM public.escopo_termos t
   WHERE t.ativo AND t.nivel IN ('nucleo','adjacente') AND d ~ t.padrao
   ORDER BY (t.nivel = 'adjacente'), t.prioridade
   LIMIT 1;
END $$;

-- Item de PCA da classe CATMAT 7830: 'escopo' | 'vazio' (sem descrição, conta pela classe) | 'recreacao' (fora).
create or replace function public.fn_escopo_pca(p_descricao text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN btrim(public.fn_norm_item(p_descricao)) = '' THEN 'vazio'
    WHEN EXISTS (SELECT 1 FROM public.escopo_termos t WHERE t.ativo AND t.nivel = 'recreacao_pca'
                   AND public.fn_norm_item(p_descricao) ~ t.padrao) THEN 'recreacao'
    ELSE 'escopo' END
$$;

create or replace function public.fn_classifica_orgao(
  p_nome text, p_natureza text, p_esfera text, p_tipo_adm integer, p_codigo_orgao integer, p_codigo_vinculado integer,
  OUT tipo_orgao text, OUT regra_id bigint)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  n   text := public.fn_norm_nome(p_nome);
  esf text := CASE WHEN coalesce(p_esfera, '') = '' AND p_codigo_orgao < 70000 THEN 'F' ELSE nullif(p_esfera, '') END;
  nat text := coalesce(p_natureza, '');
BEGIN
  SELECT r.tipo_orgao, r.id INTO tipo_orgao, regra_id
    FROM public.orgao_tipo_regras r
   WHERE r.ativo AND r.nivel = 'orgao'
     AND (r.codigos_orgao IS NULL OR p_codigo_orgao = ANY (r.codigos_orgao))
     AND (r.codigos_orgao_vinculado IS NULL OR p_codigo_vinculado = ANY (r.codigos_orgao_vinculado))
     AND (r.tipos_administracao IS NULL OR p_tipo_adm = ANY (r.tipos_administracao) OR (p_tipo_adm IS NULL AND r.aceita_tipo_adm_nulo))
     AND (r.naturezas IS NULL OR nat = ANY (r.naturezas))
     AND (r.natureza_regex IS NULL OR nat ~ r.natureza_regex)
     AND (r.esferas IS NULL OR esf = ANY (r.esferas))
     AND (r.nome_regex IS NULL OR n ~ r.nome_regex)
     AND (r.nome_regex_exclui IS NULL OR n !~ r.nome_regex_exclui)
   ORDER BY r.prioridade
   LIMIT 1;
  IF tipo_orgao IS NULL THEN tipo_orgao := 'outros'; END IF;
END $$;

-- UASG refina o tipo herdado do órgão (Forças Armadas sempre herdam do Comando).
create or replace function public.fn_classifica_uasg(p_nome_uasg text, p_tipo_orgao_pai text, OUT tipo_orgao text, OUT regra_id bigint)
LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  n text := public.fn_norm_nome(p_nome_uasg);
  g text := (SELECT t.grupo_tipo FROM public.orgao_tipos t WHERE t.tipo_orgao = p_tipo_orgao_pai);
BEGIN
  IF p_tipo_orgao_pai LIKE 'forcas_armadas%' THEN tipo_orgao := p_tipo_orgao_pai; RETURN; END IF;
  SELECT r.tipo_orgao, r.id INTO tipo_orgao, regra_id
    FROM public.orgao_tipo_regras r
   WHERE r.ativo AND r.nivel = 'uasg' AND n ~ r.nome_regex
     AND (r.grupos_orgao_pai IS NULL OR g = ANY (r.grupos_orgao_pai) OR (g IS NULL AND r.aceita_grupo_pai_nulo))
   ORDER BY r.prioridade
   LIMIT 1;
  IF tipo_orgao IS NULL THEN tipo_orgao := coalesce(p_tipo_orgao_pai, 'outros'); END IF;
END $$;

-- Esfera canônica F/E/D/M/N: natureza 1xxx > privado por natureza 3/4 ou tipo > Compras > PNCP > N; E + UF DF = D.
create or replace function public.fn_esfera_canon(p_natureza text, p_esfera_compras text, p_esfera_pncp text, p_uf text, p_tipo_orgao text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  WITH e AS (
    SELECT CASE
      WHEN p_natureza IN ('1015','1040','1074','1104','1139','1163','1252','1287','1317','1341') THEN 'F'
      WHEN p_natureza IN ('1023','1058','1082','1112','1147','1171','1236','1260','1295','1325') THEN 'E'
      WHEN p_natureza IN ('1031','1066','1120','1155','1180','1244','1279','1309','1333') THEN 'M'
      WHEN p_tipo_orgao = 'entidade_privada' THEN 'N'
      WHEN p_tipo_orgao IN ('sistema_s','escola_conselho_escolar','outros') AND left(coalesce(p_natureza,''),1) IN ('3','4') THEN 'N'
      WHEN p_esfera_compras IN ('F','E','D','M') THEN p_esfera_compras
      WHEN p_esfera_pncp    IN ('F','E','D','M') THEN p_esfera_pncp
      ELSE 'N' END AS v)
  SELECT CASE WHEN v = 'E' AND p_uf = 'DF' THEN 'D' ELSE v END FROM e
$$;

-- Poder canônico E/L/J/N (Compras.poder é descartado: 58,8% de concordância).
create or replace function public.fn_poder_canon(p_tipo_orgao text, p_natureza text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN g.grupo_tipo = 'legislativo' OR p_natureza IN ('1040','1058','1066') THEN 'L'
    WHEN g.grupo_tipo = 'judiciario'  OR p_natureza IN ('1074','1082') THEN 'J'
    WHEN (g.grupo_tipo IN ('privados','paraestatais') AND p_tipo_orgao <> 'conselho_profissional')
      OR (p_tipo_orgao = 'escola_conselho_escolar' AND left(coalesce(p_natureza,''),1) = '3')
      OR p_tipo_orgao = 'outros' THEN 'N'
    ELSE 'E' END
  FROM (SELECT (SELECT t.grupo_tipo FROM public.orgao_tipos t WHERE t.tipo_orgao = p_tipo_orgao) AS grupo_tipo) g
$$;

-- 3) Colunas de filtro em orgaos e uasgs (constraints nomeadas no passo 4) ------------------------------------
alter table public.orgaos
  add column if not exists natureza_juridica        text,          -- PNCP /v1/orgaos/{cnpj}.codigoNaturezaJuridica
  add column if not exists pncp_esfera              text,
  add column if not exists pncp_poder               text,
  add column if not exists pncp_orgao_lido_em       timestamptz,
  add column if not exists tipo_orgao               text,
  add column if not exists grupo_tipo               text,
  add column if not exists tipo_orgao_origem        text,
  add column if not exists tipo_orgao_regra_id      bigint,
  add column if not exists esfera_canon             text,
  add column if not exists poder_canon              text,
  add column if not exists uf                       text,
  add column if not exists municipio_ibge           text,
  add column if not exists localizacao_origem       text,
  add column if not exists seguranca_defesa         boolean generated always as (grupo_tipo = 'seguranca_defesa') stored,
  add column if not exists seguranca_defesa_uasgs   integer not null default 0,   -- nº de UASGs do órgão em Segurança e Defesa
  add column if not exists match_nivel              text,
  add column if not exists match_projeto            boolean generated always as (match_nivel in ('comprou', 'planeja')) stored,
  add column if not exists match_atualizado_em      timestamptz,
  add column if not exists classificado_em          timestamptz;

alter table public.uasgs
  add column if not exists tipo_orgao               text,
  add column if not exists grupo_tipo               text,
  add column if not exists tipo_orgao_origem        text,
  add column if not exists tipo_orgao_regra_id      bigint,
  add column if not exists esfera_canon             text,
  add column if not exists poder_canon              text,
  add column if not exists municipio_ibge           text generated always as (
      case when codigo_municipio_ibge between 1100015 and 5300108 then codigo_municipio_ibge::text end) stored,
  add column if not exists cnpj_cpf_orgao_vinculado_norm text generated always as (
      case when regexp_replace(coalesce(cnpj_cpf_orgao_vinculado, ''), '[^0-9]', '', 'g') ~ '^0*$' then null
           else lpad(regexp_replace(cnpj_cpf_orgao_vinculado, '[^0-9]', '', 'g'), 14, '0') end) stored,
  add column if not exists pncp_municipio_ibge      text,          -- conferência (PNCP /orgaos/{cnpj}/unidades)
  add column if not exists pncp_conferido_em        timestamptz,
  add column if not exists seguranca_defesa         boolean generated always as (grupo_tipo = 'seguranca_defesa') stored,
  add column if not exists match_nivel              text,
  add column if not exists match_projeto            boolean generated always as (match_nivel in ('comprou', 'planeja')) stored,
  add column if not exists match_atualizado_em      timestamptz,
  add column if not exists classificado_em          timestamptz;

comment on column public.orgaos.natureza_juridica is 'PNCP /v1/orgaos/{cnpj}.codigoNaturezaJuridica (4 dígitos), gravada pelo coletor (PR 2).';
comment on column public.orgaos.tipo_orgao is 'Tipo de órgão (orgao_tipos). Calculado por fn_orgaos_uasgs_classificar(): override > regras > outros.';
comment on column public.orgaos.esfera_canon is 'F/E/D/M/N: natureza 1xxx > privado > esfera Compras > esfera PNCP > N; E + UF DF = D.';
comment on column public.orgaos.poder_canon is 'E/L/J/N derivado do tipo e da natureza (poder do Compras descartado: 58,8% de concordância).';
comment on column public.orgaos.seguranca_defesa_uasgs is 'Nº de UASGs ativas do órgão classificadas em Segurança e Defesa (ex.: SSP, MJSP).';
comment on column public.orgaos.match_nivel is 'comprou | planeja | adjacente, por fn_escopo_match_atualizar() a partir de mv_escopo_demanda.';
comment on column public.uasgs.municipio_ibge is 'Gerada: codigo_municipio_ibge como texto quando entre 1100015 e 5300108.';
comment on column public.uasgs.cnpj_cpf_orgao_vinculado_norm is 'Gerada: dígitos de cnpj_cpf_orgao_vinculado com lpad 14; NULL se vazio ou só zeros. Join de licitações e PCA com a UASG.';

-- 4) Constraints das colunas novas (nomeadas; criadas só se ainda não existirem) -----------------------------
do $$
declare
  v record;
begin
  for v in
    select * from (values
      ('public.orgaos', 'orgaos_natureza_juridica_check',  $c$check (natureza_juridica ~ '^\d{4}$')$c$),
      ('public.orgaos', 'orgaos_pncp_esfera_check',        $c$check (pncp_esfera in ('F', 'E', 'D', 'M', 'N'))$c$),
      ('public.orgaos', 'orgaos_pncp_poder_check',         $c$check (pncp_poder in ('E', 'L', 'J', 'N'))$c$),
      ('public.orgaos', 'orgaos_tipo_orgao_origem_check',  $c$check (tipo_orgao_origem in ('regra', 'override', 'padrao'))$c$),
      ('public.orgaos', 'orgaos_esfera_canon_check',       $c$check (esfera_canon in ('F', 'E', 'D', 'M', 'N'))$c$),
      ('public.orgaos', 'orgaos_poder_canon_check',        $c$check (poder_canon in ('E', 'L', 'J', 'N'))$c$),
      ('public.orgaos', 'orgaos_uf_check',                 $c$check (uf ~ '^[A-Z]{2}$')$c$),
      ('public.orgaos', 'orgaos_municipio_ibge_check',     $c$check (municipio_ibge ~ '^\d{7}$')$c$),
      ('public.orgaos', 'orgaos_localizacao_origem_check', $c$check (localizacao_origem in ('uasgs_moda', 'unidades_pncp_moda', 'entidade_pncp'))$c$),
      ('public.orgaos', 'orgaos_match_nivel_check',        $c$check (match_nivel in ('comprou', 'planeja', 'adjacente'))$c$),
      ('public.orgaos', 'orgaos_tipo_orgao_regra_id_fkey', $c$foreign key (tipo_orgao_regra_id) references public.orgao_tipo_regras (id) on delete set null$c$),
      ('public.orgaos', 'orgaos_tipo_grupo_fk',            $c$foreign key (tipo_orgao, grupo_tipo) references public.orgao_tipos (tipo_orgao, grupo_tipo)$c$),
      ('public.uasgs',  'uasgs_tipo_orgao_origem_check',   $c$check (tipo_orgao_origem in ('regra_uasg', 'herdado', 'override'))$c$),
      ('public.uasgs',  'uasgs_esfera_canon_check',        $c$check (esfera_canon in ('F', 'E', 'D', 'M', 'N'))$c$),
      ('public.uasgs',  'uasgs_poder_canon_check',         $c$check (poder_canon in ('E', 'L', 'J', 'N'))$c$),
      ('public.uasgs',  'uasgs_pncp_municipio_ibge_check', $c$check (pncp_municipio_ibge ~ '^\d{7}$')$c$),
      ('public.uasgs',  'uasgs_match_nivel_check',         $c$check (match_nivel in ('comprou', 'planeja', 'adjacente'))$c$),
      ('public.uasgs',  'uasgs_tipo_orgao_regra_id_fkey',  $c$foreign key (tipo_orgao_regra_id) references public.orgao_tipo_regras (id) on delete set null$c$),
      ('public.uasgs',  'uasgs_tipo_grupo_fk',             $c$foreign key (tipo_orgao, grupo_tipo) references public.orgao_tipos (tipo_orgao, grupo_tipo)$c$)
    ) x(tabela, nome, def)
  loop
    if not exists (select 1 from pg_constraint where conrelid = v.tabela::regclass and conname = v.nome) then
      execute format('alter table %s add constraint %I %s', v.tabela, v.nome, v.def);
    end if;
  end loop;
end $$;

-- 5) Índices de filtro ------------------------------------------------------------------------------------------
create index if not exists orgaos_grupo_tipo_idx        on public.orgaos (grupo_tipo, tipo_orgao);
create index if not exists orgaos_esfera_poder_idx      on public.orgaos (esfera_canon, poder_canon);
create index if not exists orgaos_uf_municipio_idx      on public.orgaos (uf, municipio_ibge);
create index if not exists orgaos_seg_defesa_idx        on public.orgaos (id) where seguranca_defesa or seguranca_defesa_uasgs > 0;
create index if not exists orgaos_match_idx             on public.orgaos (match_nivel) where match_nivel is not null;
create index if not exists uasgs_grupo_tipo_idx         on public.uasgs (grupo_tipo, tipo_orgao);
create index if not exists uasgs_esfera_poder_idx       on public.uasgs (esfera_canon, poder_canon);
create index if not exists uasgs_uf_municipio_ibge_idx  on public.uasgs (sigla_uf, municipio_ibge);
create index if not exists uasgs_seg_defesa_idx         on public.uasgs (codigo_uasg) where seguranca_defesa;
create index if not exists uasgs_match_idx              on public.uasgs (match_nivel) where match_nivel is not null;
create index if not exists uasgs_cnpj_codigo_idx        on public.uasgs (cnpj_cpf_orgao_norm, codigo_uasg);
create index if not exists uasgs_cnpj_vinc_codigo_idx   on public.uasgs (cnpj_cpf_orgao_vinculado_norm, codigo_uasg);
create index if not exists idx_licext_orgao_cnpj        on public.licitacoes_externas (orgao_cnpj);
create index if not exists idx_licext_unidade_codigo    on public.licitacoes_externas ((raw->>'unidade_codigo'));

-- 6) Demanda no escopo (MV) por CNPJ + unidade + fonte; populada por fn_escopo_match_atualizar() ---------------
create materialized view if not exists public.mv_escopo_demanda as
WITH it AS (
  SELECT l.id AS licitacao_id, l.orgao_cnpj,
         CASE WHEN l.raw->>'unidade_codigo' ~ '^\d{6}$' THEN l.raw->>'unidade_codigo' END AS unidade_codigo,
         coalesce(l.data_publicacao, l.data_inicio) AS data_pub,
         i.valor_total_estimado, e.nivel,
         r.homologado, r.data_res
    FROM public.licitacoes_externas l
    JOIN public.licitacao_itens i ON i.licitacao_id = l.id
    CROSS JOIN LATERAL public.fn_escopo_item(i.descricao) e
    LEFT JOIN LATERAL (SELECT sum(x.valor_total_homologado) AS homologado, max(x.data_resultado) AS data_res
                         FROM public.licitacao_resultados x
                        WHERE x.licitacao_id = i.licitacao_id AND x.numero_item = i.numero_item) r ON true
   WHERE e.nivel IS NOT NULL AND l.orgao_cnpj ~ '^\d{14}$'
), ed AS (
  SELECT c.orgao_cnpj, NULL::text AS unidade_codigo, c.valor_estimado, c.data_publicacao, e.nivel
    FROM public.contratacoes_editais c
    CROSS JOIN LATERAL public.fn_escopo_item(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, '')) e
   WHERE e.nivel IS NOT NULL AND c.orgao_cnpj ~ '^\d{14}$'
), pca AS (
  SELECT p.orgao_cnpj, p.unidade_codigo, i.valor_total_estimado, p.data_publicacao, public.fn_escopo_pca(i.descricao) AS k
    FROM public.pca_itens i JOIN public.pca_planos p ON p.id = i.pca_plano_id
   WHERE i.codigo_classe_catmat = 7830 AND coalesce(i.ativo, true) AND coalesce(p.ativo, true)
)
SELECT orgao_cnpj, unidade_codigo, 'licitacao'::text AS fonte,
       count(DISTINCT licitacao_id) FILTER (WHERE nivel = 'nucleo')           AS processos_nucleo,
       count(DISTINCT licitacao_id)                                            AS processos,
       count(*) FILTER (WHERE nivel = 'nucleo')                                AS itens_nucleo,
       count(*) FILTER (WHERE nivel = 'adjacente')                             AS itens_adjacentes,
       sum(valor_total_estimado)                                               AS valor_estimado,
       sum(homologado)                                                         AS valor_homologado,
       max(data_pub)                                                           AS ultima_publicacao,
       max(data_res)                                                           AS ultimo_resultado
  FROM it GROUP BY orgao_cnpj, unidade_codigo
UNION ALL
SELECT orgao_cnpj, unidade_codigo, 'edital', count(*) FILTER (WHERE nivel = 'nucleo'), count(*),
       NULL, NULL, sum(valor_estimado), NULL, max(data_publicacao), NULL
  FROM ed GROUP BY orgao_cnpj, unidade_codigo
UNION ALL
SELECT orgao_cnpj, unidade_codigo, 'pca', NULL, NULL,
       count(*) FILTER (WHERE k IN ('escopo','vazio')), NULL,
       sum(valor_total_estimado) FILTER (WHERE k IN ('escopo','vazio')), NULL,
       max(data_publicacao)::timestamptz, NULL
  FROM pca GROUP BY orgao_cnpj, unidade_codigo
HAVING count(*) FILTER (WHERE k IN ('escopo','vazio')) > 0
WITH NO DATA;

create unique index if not exists mv_escopo_demanda_key ON public.mv_escopo_demanda (orgao_cnpj, coalesce(unidade_codigo, ''), fonte);

-- 7) Rotinas de escrita (pg_cron como postgres, job do PR 3; sem EXECUTE para roles de API) ------------------
create or replace function public.fn_orgaos_uasgs_classificar(OUT orgaos_alterados integer, OUT uasgs_alteradas integer)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  -- 6.1 localização do órgão: moda das UASGs ativas > moda das unidades PNCP > entidade PNCP
  -- 6.2 tipo: override > regras; esfera/poder canônicos
  WITH loc_u AS (
    SELECT DISTINCT ON (u.orgao_id) u.orgao_id, u.sigla_uf AS uf, u.municipio_ibge
      FROM public.uasgs u
     WHERE u.ativo AND u.orgao_id IS NOT NULL AND u.sigla_uf ~ '^[A-Z]{2}$'
     GROUP BY u.orgao_id, u.sigla_uf, u.municipio_ibge
     ORDER BY u.orgao_id, count(*) DESC, min(u.codigo_uasg)
  ), loc_p AS (
    SELECT DISTINCT ON (un.orgao_id) un.orgao_id, un.uf, un.municipio_ibge
      FROM public.unidades un
     WHERE un.uf ~ '^[A-Z]{2}$'
     GROUP BY un.orgao_id, un.uf, un.municipio_ibge
     ORDER BY un.orgao_id, count(*) DESC, min(un.codigo_unidade)
  ), c AS (
    SELECT o.id,
           coalesce(ov.tipo_orgao, cl.tipo_orgao) AS tipo,
           CASE WHEN ov.tipo_orgao IS NOT NULL THEN 'override' WHEN cl.regra_id IS NULL THEN 'padrao' ELSE 'regra' END AS origem,
           CASE WHEN ov.tipo_orgao IS NULL THEN cl.regra_id END AS regra_id,
           coalesce(lu.uf, lp.uf, e.uf) AS uf,
           CASE WHEN lu.uf IS NOT NULL THEN lu.municipio_ibge WHEN lp.uf IS NOT NULL THEN lp.municipio_ibge ELSE e.municipio_ibge END AS mun,
           CASE WHEN lu.uf IS NOT NULL THEN 'uasgs_moda' WHEN lp.uf IS NOT NULL THEN 'unidades_pncp_moda'
                WHEN e.uf IS NOT NULL THEN 'entidade_pncp' END AS loc_origem
      FROM public.orgaos o
      LEFT JOIN public.orgao_tipo_override ov ON ov.nivel = 'orgao' AND ov.chave = o.codigo_orgao::text
      LEFT JOIN loc_u lu ON lu.orgao_id = o.id
      LEFT JOIN loc_p lp ON lp.orgao_id = o.id
      LEFT JOIN public.entidades e ON e.id = o.entidade_id
      CROSS JOIN LATERAL public.fn_classifica_orgao(coalesce(o.nome_orgao, o.razao_social), o.natureza_juridica,
                          coalesce(o.esfera, o.pncp_esfera), o.codigo_tipo_administracao, o.codigo_orgao, o.codigo_orgao_vinculado) cl
  ), n AS (
    SELECT c.*, t.grupo_tipo,
           public.fn_esfera_canon(o.natureza_juridica, o.esfera, o.pncp_esfera, c.uf, c.tipo) AS esf,
           public.fn_poder_canon(c.tipo, o.natureza_juridica) AS pod
      FROM c JOIN public.orgaos o ON o.id = c.id JOIN public.orgao_tipos t ON t.tipo_orgao = c.tipo
  ), upd AS (
    UPDATE public.orgaos o
       SET tipo_orgao = n.tipo, grupo_tipo = n.grupo_tipo, tipo_orgao_origem = n.origem, tipo_orgao_regra_id = n.regra_id,
           esfera_canon = n.esf, poder_canon = n.pod,
           uf = n.uf, municipio_ibge = CASE WHEN n.mun ~ '^\d{7}$' THEN n.mun END, localizacao_origem = n.loc_origem,
           classificado_em = now()
      FROM n
     WHERE o.id = n.id
       AND (o.tipo_orgao, o.grupo_tipo, o.tipo_orgao_origem, o.tipo_orgao_regra_id, o.esfera_canon, o.poder_canon, o.uf, o.municipio_ibge, o.localizacao_origem)
           IS DISTINCT FROM (n.tipo, n.grupo_tipo, n.origem, n.regra_id, n.esf, n.pod, n.uf, CASE WHEN n.mun ~ '^\d{7}$' THEN n.mun END, n.loc_origem)
    RETURNING 1)
  SELECT count(*) INTO orgaos_alterados FROM upd;

  WITH c AS (
    SELECT u.id, o.tipo_orgao AS tipo_pai, o.esfera_canon AS esf_pai, o.natureza_juridica,
           ov.tipo_orgao AS tipo_ov, cl.tipo_orgao AS tipo_cl, cl.regra_id
      FROM public.uasgs u
      LEFT JOIN public.orgaos o ON o.id = u.orgao_id
      LEFT JOIN public.orgao_tipo_override ov ON ov.nivel = 'uasg' AND ov.chave = u.codigo_uasg
      CROSS JOIN LATERAL public.fn_classifica_uasg(u.nome_uasg, o.tipo_orgao) cl
  ), n AS (
    SELECT c.id, coalesce(c.tipo_ov, c.tipo_cl) AS tipo, t.grupo_tipo,
           CASE WHEN c.tipo_ov IS NOT NULL THEN 'override' WHEN c.regra_id IS NOT NULL THEN 'regra_uasg' ELSE 'herdado' END AS origem,
           CASE WHEN c.tipo_ov IS NULL THEN c.regra_id END AS regra_id,
           coalesce(c.esf_pai, 'N') AS esf,
           public.fn_poder_canon(coalesce(c.tipo_ov, c.tipo_cl), c.natureza_juridica) AS pod
      FROM c JOIN public.orgao_tipos t ON t.tipo_orgao = coalesce(c.tipo_ov, c.tipo_cl)
  ), upd AS (
    UPDATE public.uasgs u
       SET tipo_orgao = n.tipo, grupo_tipo = n.grupo_tipo, tipo_orgao_origem = n.origem, tipo_orgao_regra_id = n.regra_id,
           esfera_canon = n.esf, poder_canon = n.pod, classificado_em = now()
      FROM n
     WHERE u.id = n.id
       AND (u.tipo_orgao, u.grupo_tipo, u.tipo_orgao_origem, u.tipo_orgao_regra_id, u.esfera_canon, u.poder_canon)
           IS DISTINCT FROM (n.tipo, n.grupo_tipo, n.origem, n.regra_id, n.esf, n.pod)
    RETURNING 1)
  SELECT count(*) INTO uasgs_alteradas FROM upd;

  UPDATE public.orgaos o SET seguranca_defesa_uasgs = s.n
    FROM (SELECT o2.id, count(u.id) FILTER (WHERE u.seguranca_defesa AND u.ativo)::int AS n
            FROM public.orgaos o2 LEFT JOIN public.uasgs u ON u.orgao_id = o2.id GROUP BY o2.id) s
   WHERE o.id = s.id AND o.seguranca_defesa_uasgs IS DISTINCT FROM s.n;
END $$;

create or replace function public.fn_escopo_match_atualizar(OUT orgaos_com_match integer, OUT uasgs_com_match integer)
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_escopo_demanda;
  WITH m AS (
    SELECT orgao_cnpj,
           CASE WHEN bool_or(fonte IN ('licitacao','edital') AND processos_nucleo > 0) THEN 'comprou'
                WHEN bool_or(fonte = 'pca') THEN 'planeja'
                WHEN bool_or(fonte = 'licitacao' AND itens_adjacentes > 0) THEN 'adjacente' END AS nivel
      FROM public.mv_escopo_demanda GROUP BY orgao_cnpj)
  UPDATE public.orgaos o SET match_nivel = m.nivel, match_atualizado_em = now()
    FROM (SELECT o2.id, m.nivel FROM public.orgaos o2
            LEFT JOIN m ON m.orgao_cnpj = regexp_replace(o2.cnpj, '[^0-9]', '', 'g')) m
   WHERE o.id = m.id AND o.match_nivel IS DISTINCT FROM m.nivel;
  SELECT count(*) INTO orgaos_com_match FROM public.orgaos WHERE match_nivel IS NOT NULL;

  WITH m AS (
    SELECT orgao_cnpj, unidade_codigo,
           CASE WHEN bool_or(fonte = 'licitacao' AND processos_nucleo > 0) THEN 'comprou'
                WHEN bool_or(fonte = 'pca') THEN 'planeja'
                WHEN bool_or(fonte = 'licitacao' AND itens_adjacentes > 0) THEN 'adjacente' END AS nivel
      FROM public.mv_escopo_demanda WHERE unidade_codigo IS NOT NULL GROUP BY orgao_cnpj, unidade_codigo)
  UPDATE public.uasgs u SET match_nivel = m.nivel, match_atualizado_em = now()
    FROM (SELECT u2.id,
                 (array_agg(m.nivel ORDER BY array_position(ARRAY['comprou','planeja','adjacente'], m.nivel))
                    FILTER (WHERE m.nivel IS NOT NULL))[1] AS nivel
            FROM public.uasgs u2
            LEFT JOIN m ON m.unidade_codigo = u2.codigo_uasg
                       AND m.orgao_cnpj IN (u2.cnpj_cpf_orgao_norm, u2.cnpj_cpf_orgao_vinculado_norm)
           GROUP BY u2.id) m
   WHERE u.id = m.id AND u.match_nivel IS DISTINCT FROM m.nivel;
  SELECT count(*) INTO uasgs_com_match FROM public.uasgs WHERE match_nivel IS NOT NULL;
END $$;

-- 8) Views de leitura (security_invoker) usadas pela api-orgaos-uasgs --------------------------------------------
-- Órgão titular por CNPJ (várias linhas Compras podem compartilhar o CNPJ). Lista fechada de colunas (sem raw).
create or replace view public.v_orgao_titular_cnpj with (security_invoker = true) as
select distinct on (regexp_replace(o.cnpj, '[^0-9]', '', 'g'))
       regexp_replace(o.cnpj, '[^0-9]', '', 'g') as cnpj14,
       o.id, o.codigo_orgao, o.entidade_id, o.cnpj, o.nome_orgao, o.razao_social, o.pncp_vinculo, o.status_orgao, o.ativo,
       o.natureza_juridica, o.tipo_orgao, o.grupo_tipo, o.tipo_orgao_origem, o.esfera_canon, o.poder_canon,
       o.uf, o.municipio_ibge, o.seguranca_defesa, o.seguranca_defesa_uasgs, o.match_nivel, o.match_projeto
  from public.orgaos o
 where o.cnpj is not null
 order by regexp_replace(o.cnpj, '[^0-9]', '', 'g'),
          (o.pncp_vinculo = 'titular_cnpj') desc nulls last, coalesce(o.status_orgao, true) desc,
          (o.entidade_id is not null) desc, o.codigo_orgao nulls last;

create or replace view public.v_orgao_match_projeto WITH (security_invoker = true) AS
SELECT d.orgao_cnpj,
       t.id AS orgao_id, coalesce(t.nome_orgao, t.razao_social) AS orgao_nome, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf,
       sum(d.processos_nucleo) FILTER (WHERE d.fonte = 'licitacao') AS licitacoes_nucleo,
       sum(d.itens_nucleo)     FILTER (WHERE d.fonte = 'licitacao') AS itens_nucleo,
       sum(d.itens_adjacentes) FILTER (WHERE d.fonte = 'licitacao') AS itens_adjacentes,
       sum(d.valor_estimado)   FILTER (WHERE d.fonte = 'licitacao') AS valor_estimado_itens,
       sum(d.valor_homologado) FILTER (WHERE d.fonte = 'licitacao') AS valor_homologado_itens,
       sum(d.processos_nucleo) FILTER (WHERE d.fonte = 'edital')    AS editais_nucleo,
       sum(d.valor_estimado)   FILTER (WHERE d.fonte = 'edital')    AS valor_editais,
       sum(d.itens_nucleo)     FILTER (WHERE d.fonte = 'pca')       AS itens_pca_7830,
       sum(d.valor_estimado)   FILTER (WHERE d.fonte = 'pca')       AS valor_pca_7830,
       max(d.ultima_publicacao) FILTER (WHERE d.fonte IN ('licitacao','edital')) AS ultima_compra_publicada,
       max(d.ultimo_resultado) AS ultimo_resultado
  FROM public.mv_escopo_demanda d
  LEFT JOIN public.v_orgao_titular_cnpj t ON t.cnpj14 = d.orgao_cnpj
 GROUP BY d.orgao_cnpj, t.id, t.nome_orgao, t.razao_social, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf;

-- Filtro de licitações: UASG (código 6 dígitos + CNPJ do órgão ou do órgão vinculado da UASG) > unidade PNCP > órgão titular do CNPJ > raw PNCP.
create or replace view public.v_licitacoes_filtro WITH (security_invoker = true) AS
SELECT l.id AS licitacao_id, l.fonte, l.orgao_cnpj, l.raw->>'unidade_codigo' AS unidade_codigo,
       CASE WHEN u.id IS NOT NULL THEN 'uasg' WHEN un.id IS NOT NULL THEN 'unidade_pncp'
            WHEN t.id IS NOT NULL THEN 'orgao_cnpj' WHEN l.raw ? 'esfera_id' THEN 'raw_pncp' ELSE 'sem_ligacao' END AS ligacao,
       t.id AS orgao_id, u.id AS uasg_id,
       -- 'N' da UASG/órgão ligado é "sem informação" (ex.: linha só-PNCP antes do PR 2 gravar natureza/pncp_esfera):
       -- não encobre a esfera do raw do PNCP; o fallback final ainda devolve 'N' quando nada se sabe.
       coalesce(nullif(u.esfera_canon, 'N'), nullif(t.esfera_canon, 'N'),
                public.fn_esfera_canon(NULL, NULL, nullif(l.raw->>'esfera_id', ''), nullif(l.uf, ''), f.tipo_orgao)) AS esfera,
       coalesce(u.poder_canon, t.poder_canon, public.fn_poder_canon(f.tipo_orgao, NULL)) AS poder,
       coalesce(u.sigla_uf, un.uf, nullif(l.uf, ''), t.uf) AS uf,
       coalesce(u.municipio_ibge, un.municipio_ibge, CASE WHEN t.esfera_canon = 'M' THEN t.municipio_ibge END) AS municipio_ibge,
       coalesce(u.tipo_orgao, t.tipo_orgao, f.tipo_orgao) AS tipo_orgao,
       coalesce(u.grupo_tipo, t.grupo_tipo, (SELECT ot.grupo_tipo FROM public.orgao_tipos ot WHERE ot.tipo_orgao = f.tipo_orgao)) AS grupo_tipo,
       coalesce(u.seguranca_defesa, t.seguranca_defesa, f.tipo_orgao IN (SELECT ot.tipo_orgao FROM public.orgao_tipos ot WHERE ot.seguranca_defesa)) AS seguranca_defesa,
       coalesce(u.match_nivel, t.match_nivel) AS match_nivel
  FROM public.licitacoes_externas l
  LEFT JOIN public.v_orgao_titular_cnpj t ON t.cnpj14 = l.orgao_cnpj
  LEFT JOIN public.uasgs u ON l.raw->>'unidade_codigo' ~ '^\d{6}$' AND u.codigo_uasg = l.raw->>'unidade_codigo'
                          AND l.orgao_cnpj IN (u.cnpj_cpf_orgao_norm, u.cnpj_cpf_orgao_vinculado_norm)
  LEFT JOIN LATERAL (SELECT x.id, x.uf, x.municipio_ibge
                       FROM public.unidades x JOIN public.orgaos op ON op.id = x.orgao_id
                      WHERE regexp_replace(op.cnpj, '[^0-9]', '', 'g') = l.orgao_cnpj
                        AND x.codigo_unidade = l.raw->>'unidade_codigo'
                      LIMIT 1) un ON true
  CROSS JOIN LATERAL public.fn_classifica_orgao(coalesce(l.orgao_nome, l.entidade), NULL, nullif(l.raw->>'esfera_id', ''), NULL, NULL, NULL) f;

-- 9) RLS e ACL ---------------------------------------------------------------------------------------------------
alter table public.orgao_tipos         enable row level security;
alter table public.orgao_tipo_regras   enable row level security;
alter table public.orgao_tipo_override enable row level security;
alter table public.escopo_termos       enable row level security;

-- Dicionários: só leitura para service_role (manutenção só por migration, que roda como postgres).
revoke all on table public.orgao_tipos, public.orgao_tipo_regras, public.orgao_tipo_override, public.escopo_termos
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.orgao_tipos, public.orgao_tipo_regras, public.orgao_tipo_override, public.escopo_termos
  to service_role;

-- MV e views: só SELECT para service_role.
revoke all on table public.mv_escopo_demanda, public.v_orgao_titular_cnpj, public.v_orgao_match_projeto,
                    public.v_licitacoes_filtro
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.mv_escopo_demanda, public.v_orgao_titular_cnpj, public.v_orgao_match_projeto,
                      public.v_licitacoes_filtro
  to service_role;

-- Sequences de identidade dos dicionários: ninguém além do dono (não há INSERT por role de API).
do $$
declare
  v_tab text;
  v_seq text;
begin
  foreach v_tab in array array['public.orgao_tipo_regras', 'public.orgao_tipo_override', 'public.escopo_termos'] loop
    v_seq := pg_get_serial_sequence(v_tab, 'id');
    if v_seq is not null then
      execute format('revoke all on sequence %s from PUBLIC, anon, authenticated, service_role', v_seq);
    end if;
  end loop;
end $$;

-- Funções: nada para PUBLIC/anon/authenticated; service_role executa só as puras (chamadas pelas views
-- security_invoker); as 2 rotinas de escrita ficam só com o dono (pg_cron como postgres).
revoke all on function
  public.fn_txt_ascii(text), public.fn_norm_item(text), public.fn_norm_nome(text), public.fn_escopo_item(text),
  public.fn_escopo_pca(text), public.fn_classifica_orgao(text, text, text, integer, integer, integer),
  public.fn_classifica_uasg(text, text), public.fn_esfera_canon(text, text, text, text, text),
  public.fn_poder_canon(text, text), public.fn_orgaos_uasgs_classificar(), public.fn_escopo_match_atualizar()
  from PUBLIC, anon, authenticated, service_role;
grant execute on function
  public.fn_txt_ascii(text), public.fn_norm_item(text), public.fn_norm_nome(text), public.fn_escopo_item(text),
  public.fn_escopo_pca(text), public.fn_classifica_orgao(text, text, text, integer, integer, integer),
  public.fn_classifica_uasg(text, text), public.fn_esfera_canon(text, text, text, text, text),
  public.fn_poder_canon(text, text)
  to service_role;

-- 10) Seeds dos dicionários (gerados das regras usadas nas medições do FILTROS.md; on conflict do nothing) -------
-- ===== dicionário de tipos =====
INSERT INTO public.orgao_tipos (tipo_orgao, grupo_tipo, rotulo, grupo_rotulo, ordem_grupo, ordem) VALUES
  ('forcas_armadas_exercito', 'seguranca_defesa', 'Exército', 'Segurança e Defesa', 1, 1),
  ('forcas_armadas_marinha', 'seguranca_defesa', 'Marinha', 'Segurança e Defesa', 1, 2),
  ('forcas_armadas_aeronautica', 'seguranca_defesa', 'Aeronáutica', 'Segurança e Defesa', 1, 3),
  ('ministerio_defesa', 'seguranca_defesa', 'Ministério da Defesa', 'Segurança e Defesa', 1, 4),
  ('corpo_bombeiros_militar', 'seguranca_defesa', 'Corpo de Bombeiros Militar', 'Segurança e Defesa', 1, 5),
  ('policia_militar', 'seguranca_defesa', 'Polícia Militar', 'Segurança e Defesa', 1, 6),
  ('policia_civil', 'seguranca_defesa', 'Polícia Civil', 'Segurança e Defesa', 1, 7),
  ('policia_federal', 'seguranca_defesa', 'Polícia Federal', 'Segurança e Defesa', 1, 8),
  ('policia_rodoviaria_federal', 'seguranca_defesa', 'Polícia Rodoviária Federal', 'Segurança e Defesa', 1, 9),
  ('secretaria_seguranca_publica', 'seguranca_publica_outros', 'Secretaria/Ministério de Segurança Pública', 'Segurança pública (outros)', 2, 10),
  ('sistema_prisional', 'seguranca_publica_outros', 'Sistema prisional e socioeducativo', 'Segurança pública (outros)', 2, 11),
  ('guarda_municipal', 'seguranca_publica_outros', 'Guarda Municipal', 'Segurança pública (outros)', 2, 12),
  ('pericia_oficial', 'seguranca_publica_outros', 'Perícia oficial', 'Segurança pública (outros)', 2, 13),
  ('transito_detran', 'seguranca_publica_outros', 'Trânsito/DETRAN', 'Segurança pública (outros)', 2, 14),
  ('prefeitura', 'executivo_municipal', 'Prefeitura', 'Executivo municipal', 3, 15),
  ('secretaria_municipal', 'executivo_municipal', 'Secretaria municipal', 'Executivo municipal', 3, 16),
  ('fundo_municipal', 'executivo_municipal', 'Fundo municipal', 'Executivo municipal', 3, 17),
  ('autarquia_fundacao_municipal', 'executivo_municipal', 'Autarquia/fundação municipal', 'Executivo municipal', 3, 18),
  ('subprefeitura', 'executivo_municipal', 'Subprefeitura/administração regional', 'Executivo municipal', 3, 19),
  ('governo_estadual', 'executivo_estadual', 'Governo do estado', 'Executivo estadual', 4, 20),
  ('secretaria_estadual', 'executivo_estadual', 'Secretaria estadual', 'Executivo estadual', 4, 21),
  ('fundo_estadual', 'executivo_estadual', 'Fundo estadual', 'Executivo estadual', 4, 22),
  ('autarquia_fundacao_estadual', 'executivo_estadual', 'Autarquia/fundação estadual', 'Executivo estadual', 4, 23),
  ('ministerio_orgao_federal', 'executivo_federal', 'Ministério/órgão federal', 'Executivo federal', 5, 24),
  ('autarquia_fundacao_federal', 'executivo_federal', 'Autarquia/fundação federal', 'Executivo federal', 5, 25),
  ('fundo_federal', 'executivo_federal', 'Fundo federal', 'Executivo federal', 5, 26),
  ('universidade_federal', 'educacao', 'Universidade federal', 'Educação', 6, 27),
  ('instituto_federal_cefet', 'educacao', 'Instituto federal/CEFET', 'Educação', 6, 28),
  ('universidade_estadual_municipal', 'educacao', 'Universidade estadual/municipal', 'Educação', 6, 29),
  ('secretaria_educacao', 'educacao', 'Secretaria de educação', 'Educação', 6, 30),
  ('escola_conselho_escolar', 'educacao', 'Escola/conselho escolar/APM', 'Educação', 6, 31),
  ('hospital', 'saude', 'Hospital/maternidade', 'Saúde', 7, 32),
  ('secretaria_fundo_saude', 'saude', 'Secretaria/fundo de saúde', 'Saúde', 7, 33),
  ('camara_municipal', 'legislativo', 'Câmara municipal', 'Legislativo e controle externo', 8, 34),
  ('assembleia_legislativa', 'legislativo', 'Assembleia legislativa/CLDF', 'Legislativo e controle externo', 8, 35),
  ('congresso_nacional', 'legislativo', 'Congresso Nacional', 'Legislativo e controle externo', 8, 36),
  ('tribunal_contas', 'legislativo', 'Tribunal de contas', 'Legislativo e controle externo', 8, 37),
  ('tribunal_justica_estadual', 'judiciario', 'Tribunal de Justiça', 'Judiciário', 9, 38),
  ('justica_federal', 'judiciario', 'Justiça Federal', 'Judiciário', 9, 39),
  ('justica_trabalho', 'judiciario', 'Justiça do Trabalho', 'Judiciário', 9, 40),
  ('justica_eleitoral', 'judiciario', 'Justiça Eleitoral', 'Judiciário', 9, 41),
  ('justica_militar', 'judiciario', 'Justiça Militar', 'Judiciário', 9, 42),
  ('tribunal_superior_conselho', 'judiciario', 'Tribunais superiores/CNJ/CJF', 'Judiciário', 9, 43),
  ('ministerio_publico', 'funcoes_essenciais', 'Ministério Público', 'Funções essenciais à Justiça', 10, 44),
  ('defensoria_publica', 'funcoes_essenciais', 'Defensoria Pública', 'Funções essenciais à Justiça', 10, 45),
  ('advocacia_procuradoria', 'funcoes_essenciais', 'Advocacia/Procuradoria pública', 'Funções essenciais à Justiça', 10, 46),
  ('empresa_publica', 'empresas_estatais', 'Empresa pública', 'Empresas estatais', 11, 47),
  ('sociedade_economia_mista', 'empresas_estatais', 'Sociedade de economia mista', 'Empresas estatais', 11, 48),
  ('consorcio_publico', 'consorcios', 'Consórcio público', 'Consórcios públicos', 12, 49),
  ('sistema_s', 'paraestatais', 'Sistema S', 'Paraestatais', 13, 50),
  ('conselho_profissional', 'paraestatais', 'Conselho profissional', 'Paraestatais', 13, 51),
  ('entidade_privada', 'privados', 'Entidade privada', 'Privados', 14, 52),
  ('outros', 'outros', 'Outros', 'Outros', 15, 53)
on conflict (tipo_orgao) do nothing;

-- ===== regras de classificação de tipo (nível órgão: prioridade 10..; nível UASG: 1090..1160) =====
INSERT INTO public.orgao_tipo_regras (prioridade, nivel, tipo_orgao, nome_regex, nome_regex_exclui, codigos_orgao, codigos_orgao_vinculado, tipos_administracao, aceita_tipo_adm_nulo, naturezas, natureza_regex, esferas, grupos_orgao_pai, aceita_grupo_pai_nulo, observacao) VALUES
  (10, 'orgao', 'forcas_armadas_exercito', NULL, NULL, ARRAY[52121]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (20, 'orgao', 'forcas_armadas_exercito', NULL, NULL, ARRAY[52921]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (30, 'orgao', 'forcas_armadas_marinha', NULL, NULL, ARRAY[52131]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (40, 'orgao', 'forcas_armadas_marinha', NULL, NULL, ARRAY[52931]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (50, 'orgao', 'forcas_armadas_aeronautica', NULL, NULL, ARRAY[52111]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (60, 'orgao', 'forcas_armadas_aeronautica', NULL, NULL, ARRAY[52911]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (70, 'orgao', 'ministerio_defesa', NULL, NULL, ARRAY[52000]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (80, 'orgao', 'ministerio_defesa', NULL, NULL, ARRAY[52101]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (90, 'orgao', 'policia_federal', NULL, NULL, ARRAY[30108]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (100, 'orgao', 'policia_rodoviaria_federal', NULL, NULL, ARRAY[30802]::integer[], NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'hierarquia SIAFI (codigo do proprio orgao)'),
  (110, 'orgao', 'forcas_armadas_exercito', NULL, NULL, NULL, ARRAY[52121]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (120, 'orgao', 'forcas_armadas_exercito', NULL, NULL, NULL, ARRAY[52921]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (130, 'orgao', 'forcas_armadas_marinha', NULL, NULL, NULL, ARRAY[52131]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (140, 'orgao', 'forcas_armadas_marinha', NULL, NULL, NULL, ARRAY[52931]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (150, 'orgao', 'forcas_armadas_aeronautica', NULL, NULL, NULL, ARRAY[52111]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (160, 'orgao', 'forcas_armadas_aeronautica', NULL, NULL, NULL, ARRAY[52911]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (170, 'orgao', 'ministerio_defesa', NULL, NULL, NULL, ARRAY[52000]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (180, 'orgao', 'ministerio_defesa', NULL, NULL, NULL, ARRAY[52101]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (190, 'orgao', 'policia_federal', NULL, NULL, NULL, ARRAY[30108]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (200, 'orgao', 'policia_rodoviaria_federal', NULL, NULL, NULL, ARRAY[30802]::integer[], ARRAY[1,7]::integer[], true, NULL, NULL, NULL, NULL, false, 'orgao vinculado a Comando/DPF/PRF (adm. direta ou fundo)'),
  (210, 'orgao', 'escola_conselho_escolar', '\yESCOLA\y|\yCOLEGIO\y|\yCOL\y', 'ESCOLA (DE )?(GOVERNO|SUPERIOR|NACIONAL|FAZENDARIA|JUDICIAL|DA MAGISTRATURA|DO LEGISLATIVO|PREPARATORIA DE CADETES|DE SARGENTOS|NAVAL|DE GUERRA|DE CONTAS)|FAMILIAS AGRICOLAS|ESCOLAS? FAMILIA', NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'escola/colegio (exceto escolas de governo, militares etc.)'),
  (220, 'orgao', 'escola_conselho_escolar', '^CONSELHO (DA |DO )?(E E|E C|ESC|ESCOLA|ECIT|E E E|E C I|E E 1|E E1)\y|^CONSELHO E\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'conselho escolar (UEx/PDDE)'),
  (230, 'orgao', 'escola_conselho_escolar', '^ASSOCI\w* (DE |DO |DA )?(AP E|AAEE|APOIO|A [A-Z] ?[A-Z]? ?[A-Z]?|C E|P E E|E C C|COM ESCOLA|E COM|A C|APOIO DA ESC|A A C|CEEMT|C E E)\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'associacao de apoio a escola (UEx/PDDE)'),
  (240, 'orgao', 'ministerio_orgao_federal', 'REPUBLICA FEDERATIVA DO BRASIL|^UNIAO$', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (250, 'orgao', 'outros', '^ORGANISMOS INTERNACIONAIS|^RESERVA DE CONTINGENCIA|^ESTATAIS D[OA]|^ENCARGOS FINANCEIROS|^TRANSFERENCIAS A ', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, 'agregadores contabeis SIAFI'),
  (260, 'orgao', 'sistema_s', 'SERVICO (DE )?APOIO AS? MICRO', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (270, 'orgao', 'entidade_privada', NULL, '\ySESC\y|\ySENAI\y|\ySESI\y|\ySENAC\y|\ySEBRAE\y|\ySEST\y|\ySENAT\y|\ySENAR\y|CONSORCIO', NULL, NULL, ARRAY[15]::integer[], false, NULL, NULL, NULL, NULL, false, 'Compras: EMPRESA PRIVADA'),
  (280, 'orgao', 'entidade_privada', NULL, '\ySESC\y|\ySENAI\y|\ySESI\y|\ySENAC\y|\ySEBRAE\y|\ySEST\y|\ySENAT\y|\ySENAR\y|CONSORCIO', NULL, NULL, NULL, false, NULL, '^(2(?!011|038)|3(?!077)|4)', NULL, NULL, false, 'natureza juridica privada'),
  (290, 'orgao', 'corpo_bombeiros_militar', '\yCORPO DE BOMBEIROS\y|\yBOMBEIROS? MILITAR|\yCBM[A-Z]{2}\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (300, 'orgao', 'policia_militar', '\yPOLICIA MILITAR\y|\yPM[A-Z]{2}\y|\yBATALHAO DE POLICIA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (310, 'orgao', 'policia_civil', '\yPOLICIA CIVIL\y|\yDELEGACIA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (320, 'orgao', 'policia_rodoviaria_federal', '\yPOLICIA RODOVIARIA FEDERAL\y|\yPRF\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (330, 'orgao', 'policia_federal', '\yPOLICIA FEDERAL\y|\yDPF\y|SUPERINTENDENCIA REGIONAL .*POLICIA', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (340, 'orgao', 'forcas_armadas_exercito', '\yCOMANDO DO EXERCITO\y|\yEXERCITO\y|\yBATALHAO\y|\yREGIMENTO\y|\yBRIGADA\y|\yCOMANDO MILITAR\y|\yREGIAO MILITAR\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (350, 'orgao', 'forcas_armadas_marinha', '\yCOMANDO DA MARINHA\y|\yMARINHA\y|\yNAVAL\y|\yFUZILEIROS\y|\yCAPITANIA DOS PORTOS\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (360, 'orgao', 'forcas_armadas_aeronautica', '\yCOMANDO DA AERONAUTICA\y|\yAERONAUTICA\y|\yBASE AEREA\y|\yFORCA AEREA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (370, 'orgao', 'ministerio_defesa', '\yMINISTERIO DA DEFESA\y|\yESTADO MAIOR CONJUNTO\y|\yESCOLA SUPERIOR DE GUERRA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (380, 'orgao', 'sistema_prisional', '\yPOLICIA PENAL\y|PENITENCIAR|PRISIONAL|\ySEAP\y|\ySOCIOEDUCATIV', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (390, 'orgao', 'guarda_municipal', '\yGUARDA (CIVIL )?(MUNICIPAL|METROPOLITANA)\y|\ySEGURANCA URBANA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (400, 'orgao', 'pericia_oficial', '\yPERICIA\y|\yPOLICIA CIENTIFICA\y|INSTITUTO MEDICO LEGAL|CRIMINALISTICA', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (410, 'orgao', 'transito_detran', '\yDETRAN\y|DEPARTAMENTO ESTADUAL DE TRANSITO', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (420, 'orgao', 'secretaria_seguranca_publica', 'SEGURANCA PUBLICA|DEFESA SOCIAL|SEGURANCA E DEFESA', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (430, 'orgao', 'tribunal_contas', '\yTRIBUNAL DE CONTAS\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (440, 'orgao', 'justica_trabalho', '\yTRIBUNAL REGIONAL DO TRABALHO\y|\yJUSTICA DO TRABALHO\y|\yTRT\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (450, 'orgao', 'justica_eleitoral', '\yTRIBUNAL REGIONAL ELEITORAL\y|\yJUSTICA ELEITORAL\y|\yTRE\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (460, 'orgao', 'justica_militar', '\yJUSTICA MILITAR\y|\yAUDITORIA .*CJM\y|TRIBUNAL DE JUSTICA MILITAR', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (470, 'orgao', 'tribunal_superior_conselho', '\ySUPREMO TRIBUNAL\y|\ySUPERIOR TRIBUNAL\y|\yTRIBUNAL SUPERIOR\y|\yCONSELHO NACIONAL DE JUSTICA\y|CONSELHO DA JUSTICA FEDERAL', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (480, 'orgao', 'justica_federal', '\yJUSTICA FEDERAL\y|\yTRIBUNAL REGIONAL FEDERAL\y|\ySECAO JUDICIARIA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (490, 'orgao', 'tribunal_justica_estadual', '\yTRIBUNAL DE JUSTICA\y|\yPODER JUDICIARIO\y|JUSTICA DO DISTRITO FEDERAL', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (500, 'orgao', 'ministerio_publico', '\yMINISTERIO PUBLICO\y|\yPROCURADORIA GERAL D[EA] JUSTICA\y|\yPROCURADORIA DA REPUBLICA\y|\yPROCURADORIA REGIONAL DO TRABALHO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (510, 'orgao', 'defensoria_publica', '\yDEFENSORIA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (520, 'orgao', 'advocacia_procuradoria', '\yADVOCACIA GERAL\y|\yPROCURADORIA GERAL DO (ESTADO|MUNICIPIO)\y|\yPROCURADORIA GERAL DA FAZENDA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (530, 'orgao', 'camara_municipal', '\yCAMARA MUNICIPAL\y|\yCAMARA DE VEREADORES\y|\yCAMARA MUN\w*\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (540, 'orgao', 'assembleia_legislativa', '\yASSEMBLEIA LEGISLATIVA\y|\yCAMARA LEGISLATIVA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (550, 'orgao', 'congresso_nacional', '\ySENADO FEDERAL\y|\yCAMARA DOS DEPUTADOS\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (560, 'orgao', 'consorcio_publico', '\yCONSORCIO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (570, 'orgao', 'sistema_s', '^(SERVICO (SOCIAL|NACIONAL) D|SESC|SENAC|SESI|SENAI|SEST|SENAT|SEBRAE|SENAR)\y|\ySEST SENAT\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (580, 'orgao', 'conselho_profissional', '^CONSELHO (REGIONAL|FEDERAL|NACIONAL|REG|R|FED)\y(?! DE (SAUDE|EDUCACAO|ASSISTENCIA|DIREITOS|DESENVOLVIMENTO|SEGURANCA))|^ORDEM DOS (ADVOGADOS|MUSICOS)', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (590, 'orgao', 'instituto_federal_cefet', '\yINSTITUTO FEDERAL\y|\yCENTRO (FEDERAL )?DE EDUCACAO TECNOLOGICA\y|\yCENTRO FED DE ED\y|\yCEFET\y|\yCOLEGIO PEDRO II\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (600, 'orgao', 'universidade_federal', '\yUNIVERSIDADE (FEDERAL|TECNOLOGICA FEDERAL)\y|\yFUNDACAO UNIVERSIDADE FEDERAL\y|\yUNIV FED\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (610, 'orgao', 'universidade_estadual_municipal', '\yUNIVERSIDADE\y|\yFACULDADE\y|\yINSTITUTO (DE )?EDUC\w* SUP', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (620, 'orgao', 'hospital', '\yHOSPITAL\y|\yMATERNIDADE\y|\yPRONTO SOCORRO\y|\yUPA\y|\yEBSERH\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (630, 'orgao', 'secretaria_fundo_saude', '\ySAUDE\y|^FUNDO M S\y|^FUNDO MUN(IC)? (DE )?S\y|\yFMS\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (640, 'orgao', 'secretaria_educacao', '\yEDUCACAO\y|\yENSINO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (650, 'orgao', 'prefeitura', '^PREFEIT|\yPREFEIT\w* MUNICIPAL\y|^MUNICIPIO D[EAO]S?\y|^MUNICIPIO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (660, 'orgao', 'subprefeitura', '\ySUBPREFEITURA\y|\yADMINISTRACAO REGIONAL\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (670, 'orgao', 'governo_estadual', '^(GOVERNO DO )?ESTADO D[EOA]S? [A-Z ]+$|^GOVERNO D[OA] ', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (680, 'orgao', 'empresa_publica', NULL, NULL, NULL, NULL, NULL, false, ARRAY['2011']::text[], NULL, NULL, NULL, false, NULL),
  (690, 'orgao', 'empresa_publica', NULL, NULL, NULL, NULL, ARRAY[5,8]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (700, 'orgao', 'sociedade_economia_mista', NULL, NULL, NULL, NULL, NULL, false, ARRAY['2038']::text[], NULL, NULL, NULL, false, NULL),
  (710, 'orgao', 'sociedade_economia_mista', NULL, NULL, NULL, NULL, ARRAY[6]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (720, 'orgao', 'consorcio_publico', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1210','1228']::text[], NULL, NULL, NULL, false, NULL),
  (730, 'orgao', 'sistema_s', NULL, NULL, NULL, NULL, NULL, false, ARRAY['3077']::text[], NULL, NULL, NULL, false, NULL),
  (740, 'orgao', 'prefeitura', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1244']::text[], NULL, NULL, NULL, false, NULL),
  (750, 'orgao', 'governo_estadual', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1236']::text[], NULL, NULL, NULL, false, NULL),
  (760, 'orgao', 'camara_municipal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1066']::text[], NULL, NULL, NULL, false, NULL),
  (770, 'orgao', 'assembleia_legislativa', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1058']::text[], NULL, NULL, NULL, false, NULL),
  (780, 'orgao', 'justica_federal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1074']::text[], NULL, NULL, NULL, false, NULL),
  (790, 'orgao', 'tribunal_justica_estadual', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1082']::text[], NULL, NULL, NULL, false, NULL),
  (800, 'orgao', 'fundo_federal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1287','1295','1309','1317','1325','1333']::text[], NULL, ARRAY['F']::text[], NULL, false, NULL),
  (810, 'orgao', 'fundo_estadual', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1287','1295','1309','1317','1325','1333']::text[], NULL, ARRAY['E','D']::text[], NULL, false, NULL),
  (820, 'orgao', 'fundo_municipal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1287','1295','1309','1317','1325','1333']::text[], NULL, NULL, NULL, false, NULL),
  (830, 'orgao', 'fundo_federal', NULL, NULL, NULL, NULL, ARRAY[7]::integer[], false, NULL, NULL, ARRAY['F']::text[], NULL, false, NULL),
  (840, 'orgao', 'fundo_estadual', NULL, NULL, NULL, NULL, ARRAY[7]::integer[], false, NULL, NULL, ARRAY['E','D']::text[], NULL, false, NULL),
  (850, 'orgao', 'fundo_municipal', NULL, NULL, NULL, NULL, ARRAY[7]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (860, 'orgao', 'fundo_federal', '\yFUNDO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['F']::text[], NULL, false, NULL),
  (870, 'orgao', 'fundo_estadual', '\yFUNDO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['E','D']::text[], NULL, false, NULL),
  (880, 'orgao', 'fundo_municipal', '\yFUNDO\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (890, 'orgao', 'autarquia_fundacao_federal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1104','1139','1252']::text[], NULL, NULL, NULL, false, NULL),
  (900, 'orgao', 'autarquia_fundacao_federal', NULL, NULL, NULL, NULL, ARRAY[3,4]::integer[], false, NULL, NULL, ARRAY['F']::text[], NULL, false, NULL),
  (910, 'orgao', 'autarquia_fundacao_estadual', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1112','1147','1260']::text[], NULL, NULL, NULL, false, NULL),
  (920, 'orgao', 'autarquia_fundacao_estadual', NULL, NULL, NULL, NULL, ARRAY[13]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (930, 'orgao', 'autarquia_fundacao_estadual', NULL, NULL, NULL, NULL, ARRAY[3,4]::integer[], false, NULL, NULL, ARRAY['E','D']::text[], NULL, false, NULL),
  (940, 'orgao', 'autarquia_fundacao_municipal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1120','1155','1279']::text[], NULL, NULL, NULL, false, NULL),
  (950, 'orgao', 'autarquia_fundacao_municipal', NULL, NULL, NULL, NULL, ARRAY[14]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (960, 'orgao', 'autarquia_fundacao_municipal', NULL, NULL, NULL, NULL, ARRAY[3,4]::integer[], false, NULL, NULL, ARRAY['M']::text[], NULL, false, NULL),
  (970, 'orgao', 'secretaria_municipal', '^SECRETARIA|\ySECRETARIA\y|\ySEC\y', NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['M']::text[], NULL, false, NULL),
  (980, 'orgao', 'secretaria_municipal', '^SECRETARIA|\ySECRETARIA\y|\ySEC\y', NULL, NULL, NULL, NULL, false, ARRAY['1031','1180']::text[], NULL, NULL, NULL, false, NULL),
  (990, 'orgao', 'secretaria_estadual', '^SECRETARIA|\ySECRETARIA\y|\ySEC\y', NULL, NULL, NULL, NULL, false, NULL, NULL, ARRAY['E','D']::text[], NULL, false, NULL),
  (1000, 'orgao', 'secretaria_estadual', '^SECRETARIA|\ySECRETARIA\y|\ySEC\y', NULL, NULL, NULL, NULL, false, ARRAY['1023','1171']::text[], NULL, NULL, NULL, false, NULL),
  (1010, 'orgao', 'ministerio_orgao_federal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1015','1163']::text[], NULL, NULL, NULL, false, NULL),
  (1020, 'orgao', 'ministerio_orgao_federal', NULL, NULL, NULL, NULL, ARRAY[1]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (1030, 'orgao', 'secretaria_municipal', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1031','1180']::text[], NULL, NULL, NULL, false, NULL),
  (1040, 'orgao', 'secretaria_municipal', NULL, NULL, NULL, NULL, ARRAY[12]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (1050, 'orgao', 'secretaria_estadual', NULL, NULL, NULL, NULL, NULL, false, ARRAY['1023','1171']::text[], NULL, NULL, NULL, false, NULL),
  (1060, 'orgao', 'secretaria_estadual', NULL, NULL, NULL, NULL, ARRAY[11]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (1070, 'orgao', 'entidade_privada', NULL, NULL, NULL, NULL, NULL, false, NULL, '^[234]', NULL, NULL, false, NULL),
  (1080, 'orgao', 'entidade_privada', NULL, NULL, NULL, NULL, ARRAY[15]::integer[], false, NULL, NULL, NULL, NULL, false, NULL),
  (1090, 'uasg', 'corpo_bombeiros_militar', '\yBOMBEIROS?\y|\yCBM[A-Z]{0,2}\y|\yGRUPAMENTO DE BOMBEIROS\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['seguranca_defesa','seguranca_publica_outros','executivo_estadual']::text[], true, NULL),
  (1100, 'uasg', 'policia_militar', '\yPOLICIA MILITAR\y|\yPOL(ICIA)? MILITAR\y|\yBPM\y|\yBATALHAO DE POLICIA\y|\yCOM(ANDO)?\.? ?POLIC\w*\y|\yCPA\y|\yCPI\y|\yPOLICIAMENTO\y|\yACADEMIA DE POL\w* MILITAR\y|\yESCOLA SUPERIOR DE SOLDADOS\y|\yCIA PM\y|\ySARGENTOS\y|\yDA PM\y|\yPOLICIA MONTADA\y|\yCOMANDO GERAL\y|\yPM[A-Z]{2}\y|\yCOMANDO GERAL\y.*\yPM\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['seguranca_defesa','seguranca_publica_outros','executivo_estadual']::text[], true, NULL),
  (1110, 'uasg', 'policia_civil', '\yPOLICIA CIVIL\y|\yDELEG\w*\y|\yPOL\w* JUD\w*\y|\yDEPARTAMENTO DE POLICIA JUDICIARIA\y|\yACADEMIA DE POLICIA CIVIL\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['seguranca_defesa','seguranca_publica_outros','executivo_estadual']::text[], true, NULL),
  (1120, 'uasg', 'policia_rodoviaria_federal', '\yPOLICIA RODOVIARIA FEDERAL\y|\yPOL\w* RODO?V\w* FEDERAL\y|\yDPRF\y|\yPRF\y|\ySRPRF\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['seguranca_defesa','seguranca_publica_outros','executivo_federal']::text[], true, NULL),
  (1130, 'uasg', 'policia_federal', '\yPOLICIA FEDERAL\y|\yDPF\y|\yACADEMIA NACIONAL DE POLICIA\y|\ySR ?DPF\y|\yDEP\w* ?POLICIA FEDERAL\y|\yP ?FEDERAL\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, ARRAY['seguranca_defesa','seguranca_publica_outros','executivo_federal']::text[], true, NULL),
  (1140, 'uasg', 'sistema_prisional', 'PENITENC|PRISIONAL|POLICIA PENAL|\yC ?P ?P\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (1150, 'uasg', 'hospital', '\yHOSPITAL\y|\yMATERNIDADE\y|\yPOLICLINICA\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL),
  (1160, 'uasg', 'instituto_federal_cefet', '\yINSTITUTO FEDERAL\y|\yCAMPUS\y.*\yIF[A-Z]{1,4}\y', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, false, NULL)
on conflict (nivel, prioridade) do nothing;

-- ===== termos de escopo (exclusão, núcleo, adjacente, recreação do PCA) =====
INSERT INTO public.escopo_termos (prioridade, nivel, familia, padrao, janela_caracteres) VALUES
  (10, 'exclusao', NULL, 'remocao de pavimento', 70),
  (20, 'exclusao', NULL, 'despertador', 70),
  (30, 'exclusao', NULL, 'exercitadora de maos', 70),
  (40, 'exclusao', NULL, 'borracha (bicolor|escolar|branca|apagadora)', 70),
  (50, 'exclusao', NULL, 'para lapis', 70),
  (60, 'exclusao', NULL, '\ylapis', 70),
  (70, 'exclusao', NULL, 'lapiseira', 70),
  (80, 'exclusao', NULL, 'apagador', 70),
  (90, 'exclusao', NULL, 'capacho', 70),
  (100, 'exclusao', NULL, '\ycera\y', 70),
  (110, 'exclusao', NULL, 'limpeza', 70),
  (120, 'exclusao', NULL, '\ymop\y', 70),
  (130, 'exclusao', NULL, 'vedac', 70),
  (140, 'exclusao', NULL, 'vedante', 70),
  (150, 'exclusao', NULL, 'mangueira', 70),
  (160, 'exclusao', NULL, 'luvas? (de )?(latex|procedimento|nitril|borracha)', 70),
  (170, 'exclusao', NULL, 'anel de borracha', 70),
  (180, 'exclusao', NULL, 'junta de borracha', 70),
  (190, 'exclusao', NULL, 'coxim', 70),
  (200, 'exclusao', NULL, 'restaurador', 70),
  (210, 'exclusao', NULL, 'odontol', 70),
  (220, 'exclusao', NULL, 'dental', 70),
  (230, 'exclusao', NULL, 'dentes', 70),
  (240, 'exclusao', NULL, 'seringa', 70),
  (250, 'exclusao', NULL, 'cateter', 70),
  (260, 'exclusao', NULL, 'bota (de )?(seguranca|borracha)', 70),
  (270, 'exclusao', NULL, 'mascara', 70),
  (280, 'exclusao', NULL, 'bola de (algodao|gude|soprar|isopor|natal)', 70),
  (290, 'exclusao', NULL, 'rede (de )?(esgoto|agua|energia|eletrica|dados|logica|computadores)', 70),
  (300, 'exclusao', NULL, 'fita isolante', 70),
  (310, 'exclusao', NULL, 'tinta', 70),
  (320, 'exclusao', NULL, '\ytrofeu', 70),
  (330, 'exclusao', NULL, 'medalh', 70),
  (340, 'exclusao', NULL, 'camiset', 70),
  (350, 'exclusao', NULL, 'camisa', 70),
  (360, 'exclusao', NULL, '\yshorts?\y', 70),
  (370, 'exclusao', NULL, 'uniforme', 70),
  (380, 'exclusao', NULL, 'meiao', 70),
  (390, 'exclusao', NULL, 'kit com uma camisa', 70),
  (400, 'exclusao', NULL, 'alambrado', 70),
  (410, 'exclusao', NULL, 'portao', 70),
  (420, 'exclusao', NULL, 'tela de arame', 70),
  (430, 'exclusao', NULL, 'luminaria', 70),
  (440, 'exclusao', NULL, 'refletor', 70),
  (450, 'exclusao', NULL, 'decorativ', 70),
  (460, 'exclusao', NULL, 'rolo de posicionamento', 70),
  (470, 'exclusao', NULL, 'cunha de posicionamento', 70),
  (480, 'exclusao', NULL, 'bolsa termica', 70),
  (490, 'exclusao', NULL, 'garrafao', 70),
  (500, 'nucleo', 'musculacao_academia', 'academia (ao ar livre|de ginastica|da saude)', NULL),
  (510, 'nucleo', 'musculacao_academia', 'equipamentos? (para |de )?academia', NULL),
  (520, 'nucleo', 'musculacao_academia', 'materia(l|is) (de |para )?academia', NULL),
  (530, 'nucleo', 'musculacao_academia', 'equipamentos? de ginastica', NULL),
  (540, 'nucleo', 'musculacao_academia', 'aparelhos? (de|para) (musculacao|ginastica)', NULL),
  (550, 'nucleo', 'musculacao_academia', 'estacao (de )?musculacao', NULL),
  (560, 'nucleo', 'musculacao_academia', 'multi ?estac', NULL),
  (570, 'nucleo', 'musculacao_academia', 'multiexercitador', NULL),
  (580, 'nucleo', 'musculacao_academia', 'leg ?press', NULL),
  (590, 'nucleo', 'musculacao_academia', '\ysupino', NULL),
  (600, 'nucleo', 'musculacao_academia', 'cadeira (extensora|flexora|adutora|abdutora)', NULL),
  (610, 'nucleo', 'musculacao_academia', '\yextensora\y', NULL),
  (620, 'nucleo', 'musculacao_academia', '\yflexora\y', NULL),
  (630, 'nucleo', 'musculacao_academia', 'puxad(or|a) (alta|baixa|costas)', NULL),
  (640, 'nucleo', 'musculacao_academia', 'pull ?down', NULL),
  (650, 'nucleo', 'musculacao_academia', 'cross ?over', NULL),
  (660, 'nucleo', 'musculacao_academia', '\ysmith\y', NULL),
  (670, 'nucleo', 'musculacao_academia', 'banco (de )?(supino|abdominal|musculacao|scott|regulavel)', NULL),
  (680, 'nucleo', 'musculacao_academia', '\yhalter', NULL),
  (690, 'nucleo', 'musculacao_academia', '\yanilhas?\y', NULL),
  (700, 'nucleo', 'musculacao_academia', 'kettlebell', NULL),
  (710, 'nucleo', 'musculacao_academia', 'barra (olimpica|w\y|de musculacao)', NULL),
  (720, 'nucleo', 'musculacao_academia', 'caneleira', NULL),
  (730, 'nucleo', 'musculacao_academia', 'tornozeleira', NULL),
  (740, 'nucleo', 'musculacao_academia', 'bicicleta ergometric', NULL),
  (750, 'nucleo', 'musculacao_academia', 'bike (de )?spinning', NULL),
  (760, 'nucleo', 'musculacao_academia', '\yspinning\y', NULL),
  (770, 'nucleo', 'musculacao_academia', 'esteira (eletric|ergometric|de corrida|profissional)', NULL),
  (780, 'nucleo', 'musculacao_academia', 'eliptic', NULL),
  (790, 'nucleo', 'musculacao_academia', 'remo ergometric', NULL),
  (800, 'nucleo', 'musculacao_academia', '\ystep\y', NULL),
  (810, 'nucleo', 'musculacao_academia', 'colchonete', NULL),
  (820, 'nucleo', 'musculacao_academia', 'colchao[^.]{0,30}ginastica', NULL),
  (830, 'nucleo', 'musculacao_academia', 'bola (suica|de pilates|para ginastica|tonificadora|tipo feijao)', NULL),
  (840, 'nucleo', 'musculacao_academia', 'overball', NULL),
  (850, 'nucleo', 'musculacao_academia', 'gym ?ball', NULL),
  (860, 'nucleo', 'musculacao_academia', 'corda (para|de) exercicio', NULL),
  (870, 'nucleo', 'musculacao_academia', 'medicine ?b[ao]ll', NULL),
  (880, 'nucleo', 'musculacao_academia', '\ypilates\y', NULL),
  (890, 'nucleo', 'musculacao_academia', '\yyoga\y', NULL),
  (900, 'nucleo', 'musculacao_academia', 'elastico (extensor|de resistencia)', NULL),
  (910, 'nucleo', 'musculacao_academia', 'mini ?bands?', NULL),
  (920, 'nucleo', 'musculacao_academia', 'faixas? elasticas?', NULL),
  (930, 'nucleo', 'musculacao_academia', 'banda elastica', NULL),
  (940, 'nucleo', 'musculacao_academia', 'corda elastica', NULL),
  (950, 'nucleo', 'musculacao_academia', 'extensor (fit|elastico)', NULL),
  (960, 'nucleo', 'musculacao_academia', 'kit de extensor', NULL),
  (970, 'nucleo', 'musculacao_academia', 'rubb?er band', NULL),
  (980, 'nucleo', 'musculacao_academia', 'tubing', NULL),
  (990, 'nucleo', 'musculacao_academia', 'corda (de pular|naval|individual)', NULL),
  (1000, 'nucleo', 'musculacao_academia', 'rolo (de )?espuma', NULL),
  (1010, 'nucleo', 'musculacao_academia', 'prancha (para )?abdominal', NULL),
  (1020, 'nucleo', 'musculacao_academia', 'equipamentos? para ginasio', NULL),
  (1030, 'nucleo', 'musculacao_academia', 'banco sueco', NULL),
  (1040, 'nucleo', 'musculacao_academia', 'espaldar', NULL),
  (1050, 'nucleo', 'musculacao_academia', 'bastao (com |de )?peso', NULL),
  (1060, 'nucleo', 'musculacao_academia', 'bastao (para |de )?ginastica', NULL),
  (1070, 'nucleo', 'musculacao_academia', 'cama elastica', NULL),
  (1080, 'nucleo', 'musculacao_academia', '\yjump\y', NULL),
  (1090, 'nucleo', 'musculacao_academia', 'mini trampolim', NULL),
  (1100, 'nucleo', 'musculacao_academia', 'trampolim', NULL),
  (1110, 'nucleo', 'musculacao_academia', 'disco de equilibrio', NULL),
  (1120, 'nucleo', 'musculacao_academia', 'tabua (de )?(equilibrio|proprioce)', NULL),
  (1130, 'nucleo', 'musculacao_academia', 'prancha de equilibrio', NULL),
  (1140, 'nucleo', 'musculacao_academia', 'argolas? de agilidade', NULL),
  (1150, 'nucleo', 'musculacao_academia', 'cinto de tracao', NULL),
  (1160, 'nucleo', 'musculacao_academia', 'kit (funcional|agilidade)', NULL),
  (1170, 'nucleo', 'musculacao_academia', 'treinamento funcional', NULL),
  (1180, 'nucleo', 'material_esportivo', 'materia(l|is) esportivos?', NULL),
  (1190, 'nucleo', 'material_esportivo', 'materia(l|is) (da area )?de educacao fisica', NULL),
  (1200, 'nucleo', 'material_esportivo', 'materia(l|is) (de|para) (esporte|pratica esportiva)', NULL),
  (1210, 'nucleo', 'material_esportivo', '\ybolas?\y[^.]{0,60}(futebol|futsal|society|volei|voleibol|basquet|handebol|tenis|beach|biribol|futevolei|iniciac|inicializ|queimada|ginastica ritmica|aprovad[ao] pela fig|bola (de )?campo|frescobol|malabar|espuma soft|oficial|borracha matrizada|pu\y|microfibra|termotec|gomos)', NULL),
  (1220, 'nucleo', 'material_esportivo', '\ybolas? confeccionada', NULL),
  (1230, 'nucleo', 'material_esportivo', 'tabela (de |para )?basquet', NULL),
  (1240, 'nucleo', 'material_esportivo', 'aro[^.]{0,25}basquet', NULL),
  (1250, 'nucleo', 'material_esportivo', '\ytraves? (de |para |movel )?(gol|futsal|futebol|handebol|oficial|society|movel|recreativ)', NULL),
  (1260, 'nucleo', 'material_esportivo', '\ybalizas? (de |para )?(futebol|futsal|gol|handebol|society|campo|oficial|movel|esportiv)', NULL),
  (1270, 'nucleo', 'material_esportivo', '\ygol\y', NULL),
  (1280, 'nucleo', 'material_esportivo', 'redes? (de |para |oara )?(futsal|futebol|volei|voleibol|basquet|tenis|handebol|gol|trave|peteca|protecao esportiva|seda)', NULL),
  (1290, 'nucleo', 'material_esportivo', 'redes? de protecao[^.]{0,20}(campo|futebol|society|quadra|esportiv)', NULL),
  (1300, 'nucleo', 'material_esportivo', 'rede esportiva', NULL),
  (1310, 'nucleo', 'material_esportivo', 'rede profissional', NULL),
  (1320, 'nucleo', 'material_esportivo', 'par de rede', NULL),
  (1330, 'nucleo', 'material_esportivo', 'pares de rede', NULL),
  (1340, 'nucleo', 'material_esportivo', 'postes? (para |de )?volei', NULL),
  (1350, 'nucleo', 'material_esportivo', 'antenas? (de |para )?(fibra|volei)', NULL),
  (1360, 'nucleo', 'material_esportivo', 'faixa suporte para antena', NULL),
  (1370, 'nucleo', 'material_esportivo', 'cones?\y[^.]{0,20}(treinamento|agilidade|esportiv|demarcat|chapeu)', NULL),
  (1380, 'nucleo', 'material_esportivo', 'prato demarcatorio', NULL),
  (1390, 'nucleo', 'material_esportivo', 'mini cones?', NULL),
  (1400, 'nucleo', 'material_esportivo', '\ycones? (com|de) \d+ ?cm', NULL),
  (1410, 'nucleo', 'material_esportivo', '\yskates?\y', NULL),
  (1420, 'nucleo', 'material_esportivo', 'coletes? (em transfer|numerad)', NULL),
  (1430, 'nucleo', 'material_esportivo', 'cabo de guerra', NULL),
  (1440, 'nucleo', 'material_esportivo', 'cronometro', NULL),
  (1450, 'nucleo', 'material_esportivo', 'escada (para exercicio|de coordenacao)', NULL),
  (1460, 'nucleo', 'material_esportivo', '(barreira|obstaculos?)[^.]{0,20}treinamento', NULL),
  (1470, 'nucleo', 'material_esportivo', 'estacas para treinamento', NULL),
  (1480, 'nucleo', 'material_esportivo', 'cones? plastico', NULL),
  (1490, 'nucleo', 'material_esportivo', 'chapeu chines', NULL),
  (1500, 'nucleo', 'material_esportivo', 'disco de marcador', NULL),
  (1510, 'nucleo', 'material_esportivo', 'bomba[^.]{0,30}(encher|enchimento|inflar)[^.]{0,20}bola', NULL),
  (1520, 'nucleo', 'material_esportivo', 'bomba tipo big', NULL),
  (1530, 'nucleo', 'material_esportivo', 'calibrador[^.]{0,40}bola', NULL),
  (1540, 'nucleo', 'material_esportivo', 'suporte[^.]{0,25}bola', NULL),
  (1550, 'nucleo', 'material_esportivo', '\yapitos?\y', NULL),
  (1560, 'nucleo', 'material_esportivo', 'colete (esportivo|dupla face|de treino|de treinamento)', NULL),
  (1570, 'nucleo', 'material_esportivo', 'raquete', NULL),
  (1580, 'nucleo', 'material_esportivo', 'tenis de mesa', NULL),
  (1590, 'nucleo', 'material_esportivo', 'mesa de tenis', NULL),
  (1600, 'nucleo', 'material_esportivo', 'ping.?pong', NULL),
  (1610, 'nucleo', 'material_esportivo', '\ypeteca', NULL),
  (1620, 'nucleo', 'material_esportivo', 'badminton', NULL),
  (1630, 'nucleo', 'material_esportivo', 'frescobol', NULL),
  (1640, 'nucleo', 'material_esportivo', '\ytatame', NULL),
  (1650, 'nucleo', 'material_esportivo', 'kimono', NULL),
  (1660, 'nucleo', 'material_esportivo', 'luvas? de (boxe|goleiro)', NULL),
  (1670, 'nucleo', 'material_esportivo', 'saco (de )?pancada', NULL),
  (1680, 'nucleo', 'material_esportivo', 'aparador de chute', NULL),
  (1690, 'nucleo', 'material_esportivo', 'taekwondo', NULL),
  (1700, 'nucleo', 'material_esportivo', 'bambole', NULL),
  (1710, 'nucleo', 'material_esportivo', 'arcos? (de|para|plasticos)[^.]{0,10}(ginastica|bambole)', NULL),
  (1720, 'nucleo', 'material_esportivo', 'arco (de |para )?ginastica', NULL),
  (1730, 'nucleo', 'material_esportivo', 'ginastica ritmica', NULL),
  (1740, 'nucleo', 'material_esportivo', 'aprovad[ao] pela fig', NULL),
  (1750, 'nucleo', 'material_esportivo', 'bola (de )?campo', NULL),
  (1760, 'nucleo', 'material_esportivo', 'ginastica artistica', NULL),
  (1770, 'nucleo', 'material_esportivo', 'carbonato (de )?magnesio', NULL),
  (1780, 'nucleo', 'material_esportivo', 'escada (de )?agilidade', NULL),
  (1790, 'nucleo', 'material_esportivo', 'barreiras?\y[^.]{0,20}(salto|atletismo|agilidade|desmontave)', NULL),
  (1800, 'nucleo', 'material_esportivo', 'atletismo', NULL),
  (1810, 'nucleo', 'material_esportivo', 'placar', NULL),
  (1820, 'nucleo', 'material_esportivo', 'bandeira de escanteio', NULL),
  (1830, 'nucleo', 'material_esportivo', 'prancheta tatica', NULL),
  (1840, 'nucleo', 'material_esportivo', 'pranchetas taticas', NULL),
  (1850, 'nucleo', 'material_esportivo', 'fita (de )?(marcacao|demarcatoria)[^.]{0,30}(volei|quadra|campo|futevolei)', NULL),
  (1860, 'nucleo', 'material_esportivo', 'kit fita de marcacao', NULL),
  (1870, 'nucleo', 'material_esportivo', 'porta bola', NULL),
  (1880, 'nucleo', 'material_esportivo', 'bolsa para carregar bola', NULL),
  (1890, 'nucleo', 'material_esportivo', 'cola para uso esportivo', NULL),
  (1900, 'nucleo', 'material_esportivo', 'natacao', NULL),
  (1910, 'nucleo', 'material_esportivo', 'nadadeira', NULL),
  (1920, 'nucleo', 'material_esportivo', 'palmar', NULL),
  (1930, 'nucleo', 'material_esportivo', 'pullboy', NULL),
  (1940, 'nucleo', 'material_esportivo', 'hidrogin', NULL),
  (1950, 'nucleo', 'material_esportivo', 'bocha', NULL),
  (1960, 'nucleo', 'material_esportivo', 'jogo de malha', NULL),
  (1970, 'nucleo', 'material_esportivo', 'jogo de bets', NULL),
  (1980, 'nucleo', 'material_esportivo', 'borracha para raquete', NULL),
  (1990, 'nucleo', 'material_esportivo', 'kit ping pong', NULL),
  (2000, 'nucleo', 'material_esportivo', 'equipamento acessorios desporto', NULL),
  (2010, 'nucleo', 'piso_emborrachado', 'piso[s]?[ ,:-]+(emborrachad|de borracha|esportivo|sintetico[^.]{0,60}borracha|modular[^.]{0,40}(amortec|esportiv|indoor|outdoor))', NULL),
  (2020, 'nucleo', 'piso_emborrachado', 'emborrachado monolitico', NULL),
  (2030, 'nucleo', 'piso_emborrachado', 'placas? de borracha', NULL),
  (2040, 'nucleo', 'piso_emborrachado', 'manta[ :,-]+(de borracha|amortecedora)', NULL),
  (2050, 'nucleo', 'piso_emborrachado', 'tapete de borracha', NULL),
  (2060, 'nucleo', 'piso_emborrachado', 'sistema modular esportivo', NULL),
  (2070, 'nucleo', 'piso_emborrachado', 'superficie multiuso articulada', NULL),
  (2080, 'nucleo', 'piso_emborrachado', 'sistema modular flexivel robusto', NULL),
  (2090, 'nucleo', 'piso_emborrachado', 'rampa de acabamento[^.]{0,20}piso emborrachado', NULL),
  (2100, 'adjacente', 'superficie_esportiva', 'grama(do)? sintetic', NULL),
  (2110, 'adjacente', 'superficie_esportiva', 'borracha (granulada|moida|triturada|reciclada)', NULL),
  (2120, 'adjacente', 'superficie_esportiva', 'granulado de borracha', NULL),
  (2130, 'adjacente', 'superficie_esportiva', 'granulos? de borracha', NULL),
  (2140, 'adjacente', 'superficie_esportiva', '\ysbr\y', NULL),
  (2150, 'adjacente', 'superficie_esportiva', 'espalhamento das borrachas', NULL),
  (2160, 'adjacente', 'superficie_esportiva', 'campo society', NULL)
on conflict (prioridade) do nothing;
INSERT INTO public.escopo_termos (prioridade, nivel, familia, padrao, janela_caracteres) VALUES
  (5010, 'recreacao_pca', NULL, 'playground', NULL),
  (5020, 'recreacao_pca', NULL, 'parque infantil', NULL),
  (5030, 'recreacao_pca', NULL, 'brinquedo', NULL),
  (5040, 'recreacao_pca', NULL, 'escorregador', NULL),
  (5050, 'recreacao_pca', NULL, 'gangorra', NULL),
  (5060, 'recreacao_pca', NULL, 'gira.?gira', NULL),
  (5070, 'recreacao_pca', NULL, 'carrossel', NULL),
  (5080, 'recreacao_pca', NULL, 'trepa.?trepa', NULL),
  (5090, 'recreacao_pca', NULL, 'casinha', NULL),
  (5100, 'recreacao_pca', NULL, 'pula.?pula', NULL),
  (5110, 'recreacao_pca', NULL, 'piscina de bolinhas', NULL),
  (5120, 'recreacao_pca', NULL, 'eventos infantis', NULL),
  (5130, 'recreacao_pca', NULL, 'circuito motor', NULL),
  (5140, 'recreacao_pca', NULL, 'tunel de pneus', NULL),
  (5150, 'recreacao_pca', NULL, '\ybalanco\y', NULL),
  (5160, 'recreacao_pca', NULL, '\yrecreacao\y', NULL)
on conflict (prioridade) do nothing;
INSERT INTO public.orgao_tipo_override (nivel, chave, tipo_orgao, motivo) VALUES
  ('uasg', '180341', 'policia_militar', 'Escola de Educação Física da PMESP (nome genérico, CNPJ SSP-SP)'),
  ('uasg', '933749', 'policia_militar', 'Centro de Material de Intendência da PMESP'),
  ('uasg', '180195', 'policia_militar', 'Centro de Motomecanização da PMESP'),
  ('uasg', '180220', 'policia_militar', 'Centro Médico da PMESP'),
  ('orgao', '32201', 'entidade_privada', 'CEPEL: associação civil sem fins lucrativos cadastrada com tipo_adm 3 (autarquia) no Compras')
on conflict (nivel, chave) do nothing;

commit;
