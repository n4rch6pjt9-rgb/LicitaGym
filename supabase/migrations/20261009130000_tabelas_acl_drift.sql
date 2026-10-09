-- Corrige drift de grants de tabela, view, materialized view e sequência em produção (spec specs/0005-tabelas-acl-drift.md).
--
-- Contexto (medição só leitura em produção, 09/10/2026, com has_table_privilege/has_sequence_privilege): quase todas as
-- relações de `public` e `private` davam SELECT/INSERT/UPDATE/DELETE (e MAINTAIN em 33) a `anon` e `authenticated`
-- (grantor e dono `postgres` em todas),
-- inclusive as materialized views `catmat_item_completo` e `mv_escopo_demanda` (sem RLS: legíveis por qualquer um com a
-- chave publishable). Num banco limpo (scripts/validar-migrations.sh) `anon` não tem nenhum grant de tabela/view/matview
-- e `authenticated` tem os 88 pares da lista abaixo. Origem provável: o painel do Supabase (Data API, "Exposed tables" e
-- exposição automática). As tabelas têm RLS e as views são security_invoker; o que vazava de fato eram as 2 matviews.
--
-- O que faz:
--   1. para toda relação própria do projeto em `public` e `private` (r, p, v, m, S), revoga de `anon` e `authenticated`
--      os privilégios que não estão na lista intencional (igual ao banco limpo). Não mexe em `service_role`/`postgres`;
--   2. tira dos default privileges de `postgres` em `public` os grants automáticos a `anon`/`authenticated` (tabelas e
--      sequências novas passam a depender de GRANT explícito na migration; função nova ainda herda EXECUTE de PUBLIC,
--      ver o fim do arquivo);
--   3. revoga grants por coluna (attacl) fora da lista;
--   4. pós-checagem com has_table_privilege/has_sequence_privilege/has_any_column_privilege (inclui PUBLIC): sobrou
--      algo fora da lista → aborta. Privilégios: os 7 clássicos + MAINTAIN (PG17).
-- Ignora objetos de extensão. Idempotente. Verificação: supabase/tests/tabelas_acl_check.sql.

begin;

set local lock_timeout = '5s';

do $acl$
declare
  r record;
  v_priv text;
  v_revogados int := 0;
  v_sobra text;
  v_tab_privs constant text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_seq_privs constant text[] := array['USAGE','SELECT','UPDATE'];
begin
  -- Lista intencional congelada em 09/10/2026 (gerada do banco limpo). A lista viva fica em
  -- supabase/tests/tabelas_acl_check.sql: migration nova que der grant a anon/authenticated atualiza a lista do check.
  create temporary table tabelas_acl_intencional (rel text, papel text, privs text[], primary key (rel, papel)) on commit drop;
  insert into tabelas_acl_intencional values
    ('public.catalogo_chunks', 'authenticated', '{SELECT}'),
    ('public.catalogo_documentos', 'authenticated', '{SELECT}'),
    ('public.catalogo_empresa_catmat', 'authenticated', '{SELECT}'),
    ('public.catalogo_especificacoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catalogo_itens', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catalogo_ponte', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catalogo_produtos', 'authenticated', '{SELECT}'),
    ('public.categoria_item_pca', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_classes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_grupos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_item_atributo', 'authenticated', '{SELECT}'),
    ('public.catmat_item_caracteristicas', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_item_pdm', 'authenticated', '{SELECT}'),
    ('public.catmat_itens', 'authenticated', '{SELECT}'),
    ('public.catmat_itens_taxonomia', 'authenticated', '{SELECT}'),
    ('public.catmat_pdm_ancoras', 'authenticated', '{SELECT}'),
    ('public.catmat_pdm_exclusoes', 'authenticated', '{SELECT}'),
    ('public.catmat_pdm_naturezas_despesa', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_pdm_palavras', 'authenticated', '{SELECT}'),
    ('public.catmat_pdm_unidades', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.catmat_pdms', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.compras_api_secao_legislacao', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.compras_api_secoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.consultas_log', 'authenticated', '{SELECT}'),
    ('public.contratacoes_ata_participantes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_atas', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_contratos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_editais', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_eventos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_itens', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.contratacoes_resultados', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.documento_tipos', 'authenticated', '{SELECT}'),
    ('public.fontes_externas', 'authenticated', '{SELECT}'),
    ('public.icatmat_grupo_material', 'authenticated', '{SELECT}'),
    ('public.icatmat_grupo_material_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.icatmat_grupo_material_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.icatmat_pdm_completa', 'authenticated', '{SELECT}'),
    ('public.icatmat_pdm_completa_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.icatmat_pdm_completa_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.irp_eventos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.irp_intencoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.irp_itens', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.irp_participantes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.legislacao_alertas', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.legislacao_documentos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.legislacao_fontes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.legislacao_relacoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.legislacao_versoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.licitacao_chunks_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.licitacao_chunks_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.licitacao_documentos_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.licitacao_documentos_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.licitacao_escopo_decisao', 'authenticated', '{SELECT,INSERT}'),
    ('public.licitacao_escopo_decisao_id_seq', 'authenticated', '{USAGE}'),
    ('public.licitacoes_externas_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.licitacoes_externas_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.norma_dispositivos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.norma_dispositivos_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.norma_dispositivos_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.oportunidades_borracha', 'authenticated', '{SELECT}'),
    ('public.pca_alteracoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.pca_alteracoes_resumo', 'authenticated', '{SELECT}'),
    ('public.pca_conversao_edital_item', 'authenticated', '{SELECT}'),
    ('public.pca_conversao_edital_taxa', 'authenticated', '{SELECT}'),
    ('public.pca_item_pdm', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.pca_itens', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.pca_planos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER}'),
    ('public.processo_eventos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.processo_fase_transicoes', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.processo_fase_transicoes_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.processo_fase_transicoes_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.processo_fases', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tarefas_catalogo', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tarefas_catalogo_base_legal', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tarefas_catalogo_dependencias', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.taxonomia_mapa_caracteristica', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.taxonomia_no_pdm', 'authenticated', '{SELECT}'),
    ('public.tenant_dados_restritos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tenant_documentos', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tenant_documentos_id_seq', 'anon', '{USAGE,SELECT,UPDATE}'),
    ('public.tenant_documentos_id_seq', 'authenticated', '{USAGE,SELECT,UPDATE}'),
    ('public.tenant_membros', 'authenticated', '{SELECT,INSERT,UPDATE,DELETE}'),
    ('public.tenants', 'authenticated', '{SELECT,INSERT,UPDATE}'),
    ('public.tenants_id_seq', 'authenticated', '{USAGE,SELECT}'),
    ('public.v_bi_resultados_itens', 'authenticated', '{SELECT}'),
    ('public.v_fornecedor_participacoes', 'authenticated', '{SELECT}'),
    ('public.v_licitacao_documentos', 'authenticated', '{SELECT}'),
    ('public.v_oportunidades_externas', 'authenticated', '{SELECT}');

  for r in
    select c.oid, c.relkind, format('%I.%I', n.nspname, c.relname) as nome, p.papel,
           coalesce(i.privs, array[]::text[]) as manter
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as p(papel)
      left join tabelas_acl_intencional i on i.rel = n.nspname || '.' || c.relname and i.papel = p.papel
     where n.nspname in ('public', 'private')
       and c.relkind in ('r', 'p', 'v', 'm', 'S')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    foreach v_priv in array (case when r.relkind = 'S' then v_seq_privs else v_tab_privs end) loop
      if not (v_priv = any (r.manter))
         and exists (select 1 from pg_class pc cross join lateral aclexplode(pc.relacl) a
                      where pc.oid = r.oid and pc.relacl is not null
                        and a.grantee = to_regrole(r.papel) and a.privilege_type = v_priv) then
        execute format('revoke %s on %s %s from %I', v_priv, case when r.relkind = 'S' then 'sequence' else 'table' end, r.nome, r.papel);
        v_revogados := v_revogados + 1;
      end if;
    end loop;
  end loop;

  -- Grants por coluna (pg_attribute.attacl) fora da lista: has_table_privilege não os enxerga
  for r in
    select format('%I.%I', n.nspname, c.relname) as nome, a.attname, x.papel, x.privilege_type as priv
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral (select e.privilege_type, g.rolname as papel
                            from aclexplode(a.attacl) e join pg_roles g on g.oid = e.grantee
                           where g.rolname in ('anon', 'authenticated')) x
      left join tabelas_acl_intencional i on i.rel = n.nspname || '.' || c.relname and i.papel = x.papel
     where n.nspname in ('public', 'private') and a.attacl is not null and a.attnum > 0 and not a.attisdropped
       and not (x.privilege_type = any (coalesce(i.privs, array[]::text[])))
  loop
    execute format('revoke %s (%I) on table %s from %I', r.priv, r.attname, r.nome, r.papel);
    v_revogados := v_revogados + 1;
  end loop;

  -- Pós-checagem (inclui privilégio herdado de PUBLIC)
  select string_agg(format('%s.%s %s (%s)', n.nspname, c.relname, pr, p.papel), ', ' order by 1) into v_sobra
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as p(papel)
    cross join lateral unnest(case when c.relkind = 'S' then v_seq_privs else v_tab_privs end) as pr
    left join tabelas_acl_intencional i on i.rel = n.nspname || '.' || c.relname and i.papel = p.papel
   where n.nspname in ('public', 'private')
     and c.relkind in ('r', 'p', 'v', 'm', 'S')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     and (case when c.relkind = 'S' then has_sequence_privilege(p.papel, c.oid, pr) else has_table_privilege(p.papel, c.oid, pr) end)
     and not (pr = any (coalesce(i.privs, array[]::text[])));
  if v_sobra is null then
    select string_agg(format('%s.%s %s por coluna (%s)', n.nspname, c.relname, pr, p.papel), ', ') into v_sobra
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as p(papel)
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as pr
      left join tabelas_acl_intencional i on i.rel = n.nspname || '.' || c.relname and i.papel = p.papel
     where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and has_any_column_privilege(p.papel, c.oid, pr)
       and not (pr = any (coalesce(i.privs, array[]::text[])));
  end if;
  if v_sobra is not null then
    raise exception '20261009130000: depois do revoke, ainda há privilégio fora da lista: %', v_sobra
      using hint = 'Grant via PUBLIC ou com outro grantor; revogue com o grantor certo numa migration nova.';
  end if;

  raise notice '20261009130000: % privilégio(s) revogado(s) de anon/authenticated', v_revogados;
end $acl$;

-- Default privileges: objetos novos de `postgres` em `public` não nascem abertos a anon/authenticated. Função nova ainda
-- herda EXECUTE de PUBLIC (padrão do Postgres): a migration que cria a função continua precisando de `revoke ... from public`.
-- Não revogamos esse padrão aqui: `... in schema public revoke execute on functions from public` não tem efeito (o padrão
-- é global, e o default por schema só soma), e o revoke global (`for role postgres` sem schema) também vale para extensão
-- criada depois (testado: as 118 funções do pgvector num schema novo perdem o EXECUTE de PUBLIC). Quem barra função nova
-- aberta é supabase/tests/funcoes_acl_check.sql, bloco 1 (has_function_privilege inclui PUBLIC), que roda na CI.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

commit;
