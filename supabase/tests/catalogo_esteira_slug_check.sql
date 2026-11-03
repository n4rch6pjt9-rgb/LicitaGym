-- Checagem da migration 20261013210000_catalogo_esteira_slug_backfill: nenhum produto do catálogo fica com a
-- taxonomia da esteira fora do dicionário v0.3 (slug esteira_eletrica / esteira_nao_eletrica).
do $$
declare
  v_fora integer;
begin
  select count(*) into v_fora
    from public.catalogo_produtos
   where no_taxonomia is not null
     and lower(no_taxonomia) like '%esteira%'
     and no_taxonomia not in ('esteira_eletrica', 'esteira_nao_eletrica');
  if v_fora > 0 then
    raise exception 'ACL CHECK FALHOU: % produto(s) com taxonomia de esteira fora do dicionário (esperado slug esteira_eletrica ou esteira_nao_eletrica).', v_fora;
  end if;
  raise notice 'SUCESSO: taxonomia da esteira no catálogo só com slug do dicionário.';
end $$;
