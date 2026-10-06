-- Leitura. Falha com EXCEPTION se a evidência PCA na compra coletada não ficou no lugar.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'licitacoes_externas' and column_name = 'pca_plano_id'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'licitacoes_externas' and column_name = 'pca_link_evidencia'
  ) then
    raise exception 'ACL CHECK FALHOU: licitacoes_externas sem pca_plano_id ou pca_link_evidencia';
  end if;

  if not exists (
    select 1 from pg_class c
     where c.oid = to_regclass('public.pca_conversao_edital_item')
       and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) then
    raise exception 'ACL CHECK FALHOU: pca_conversao_edital_item sem security_invoker';
  end if;

  if has_table_privilege('anon', 'public.pca_conversao_edital_item'::regclass, 'SELECT')
     or not has_table_privilege('authenticated', 'public.pca_conversao_edital_item'::regclass, 'SELECT')
     or not has_table_privilege('service_role', 'public.pca_conversao_edital_item'::regclass, 'SELECT') then
    raise exception 'ACL CHECK FALHOU: grant de pca_conversao_edital_item';
  end if;

  raise notice 'SUCESSO: licitacoes_externas_pca_link_check';
end
$$;
