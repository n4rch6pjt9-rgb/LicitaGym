-- =============================================================================
-- Checagem da higiene da migration 20261021150000_precos_itens_contratacao (spec 0031, CA-9b, parte SQL).
--
-- Depois da migration:
--   1. nenhuma linha de precos_praticados_itens tem descricao_detalhada_item só com espaço ou vazia ('');
--   2. não há a linha de teste id_compra = 'ZZTESTE';
--   3. a limpeza, reaplicada sobre linhas sintéticas (só em banco local com até 100 linhas), corrige '' e apaga
--      ZZTESTE; reaplicar não falha.
-- Só leitura, salvo a reaplicação dentro de begin; ... rollback;.
-- Saída esperada: "SUCESSO: precos_praticados_higiene_check".
-- =============================================================================

begin;

do $$
declare
  v_vazias bigint;
  v_teste bigint;
begin
  select count(*) into v_vazias
    from public.precos_praticados_itens
   where descricao_detalhada_item is not null and btrim(descricao_detalhada_item) = '';
  if v_vazias > 0 then
    raise exception 'CHECK FALHOU (CA-9b): % linhas com descricao_detalhada_item vazia (esperado NULL)', v_vazias;
  end if;

  select count(*) into v_teste from public.precos_praticados_itens where id_compra = 'ZZTESTE';
  if v_teste > 0 then
    raise exception 'CHECK FALHOU (CA-9b): linha de teste ZZTESTE ainda na tabela';
  end if;

  -- a limpeza da migration, reaplicada sobre linhas sintéticas (banco local), corrige '' e apaga ZZTESTE
  if (select count(*) from public.precos_praticados_itens) <= 100 then
    insert into public.precos_praticados_itens (id_compra, id_item_compra, descricao_detalhada_item)
    values ('99999999999999998', 1, '   '), ('ZZTESTE', 1, 'x');
  end if;

  update public.precos_praticados_itens
     set descricao_detalhada_item = null
   where descricao_detalhada_item is not null and btrim(descricao_detalhada_item) = '';
  delete from public.precos_praticados_itens where id_compra = 'ZZTESTE';
  if exists (select 1 from public.precos_praticados_itens
              where id_compra = 'ZZTESTE' or (id_compra = '99999999999999998' and descricao_detalhada_item is not null)) then
    raise exception 'CHECK FALHOU (CA-9b): a limpeza reaplicada não corrigiu as linhas sintéticas';
  end if;

  raise notice 'SUCESSO: precos_praticados_higiene_check';
end $$;

rollback;
