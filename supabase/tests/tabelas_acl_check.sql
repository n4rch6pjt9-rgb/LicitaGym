-- Checagem de grants de tabela/view/matview/sequência (spec specs/0005-tabelas-acl-drift.md, migration 20261009130000).
-- Falha com EXCEPTION se:
--   1. alguma relação própria de `public`/`private` der a `anon`/`authenticated` privilégio fora da lista intencional
--      (inclui o herdado de PUBLIC);
--   2. alguma relação da lista perder o privilégio previsto (quebraria fluxo com JWT do usuário);
--   3. `anon` puder ler alguma materialized view (sem RLS);
--   4. os default privileges de `postgres` em `public` ainda concederem algo a `anon`/`authenticated`.
-- Só lê o catálogo (cria uma tabela temporária e termina em rollback). Roda no banco descartável
-- (scripts/validar-migrations.sh) e pode rodar em produção pelo SQL Editor; não roda em transação read only.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  r record;
  v_tab_privs constant text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  v_seq_privs constant text[] := array['USAGE','SELECT','UPDATE'];
begin
  -- Lista intencional: mesma da migration 20261009130000_tabelas_acl_drift.sql (mudou aqui, mude lá).
  create temporary table tabelas_acl_intencional_chk (rel text, papel text, privs text[], primary key (rel, papel)) on commit drop;
  insert into tabelas_acl_intencional_chk values
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

  -- 1) Nada fora da lista
  for r in
    select format('%s.%s %s (%s)', n.nspname, c.relname, pr, p.papel) as f
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as p(papel)
      cross join lateral unnest(case when c.relkind = 'S' then v_seq_privs else v_tab_privs end) as pr
      left join tabelas_acl_intencional_chk i on i.rel = n.nspname || '.' || c.relname and i.papel = p.papel
     where n.nspname in ('public', 'private')
       and c.relkind in ('r', 'p', 'v', 'm', 'S')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and (case when c.relkind = 'S' then has_sequence_privilege(p.papel, c.oid, pr) else has_table_privilege(p.papel, c.oid, pr) end)
       and not (pr = any (coalesce(i.privs, array[]::text[])))
     order by 1
  loop
    v_falhas := v_falhas || r.f;
  end loop;

  -- 2) Lista intencional preservada
  for r in
    select format('%s %s (%s)', i.rel, pr, i.papel) as f
      from tabelas_acl_intencional_chk i
      cross join lateral unnest(i.privs) as pr
      left join pg_class c on c.oid = to_regclass(i.rel)
     where c.oid is null
        or not (case when c.relkind = 'S' then has_sequence_privilege(i.papel, c.oid, pr) else has_table_privilege(i.papel, c.oid, pr) end)
  loop
    v_falhas := v_falhas || ('perdeu ' || r.f);
  end loop;

  -- 3) Materialized view legível por anon
  for r in
    select format('%s.%s', n.nspname, c.relname) as f
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private') and c.relkind = 'm' and has_table_privilege('anon', c.oid, 'SELECT')
  loop
    v_falhas := v_falhas || ('matview legível por anon: ' || r.f);
  end loop;

  -- 4) Default privileges de postgres em public
  for r in
    select format('default %s: %s', d.defaclobjtype, a.grantee::regrole) as f
      from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) a
     where d.defaclrole = 'postgres'::regrole
       and d.defaclnamespace = 'public'::regnamespace
       and a.grantee in (to_regrole('anon'), to_regrole('authenticated'))
  loop
    v_falhas := v_falhas || r.f;
  end loop;

  if cardinality(v_falhas) > 0 then
    raise exception 'tabelas_acl_check: % falha(s): %', cardinality(v_falhas), array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: tabelas_acl_check: grants de tabela/view/matview/sequência conferidos';
end $chk$;

rollback;
