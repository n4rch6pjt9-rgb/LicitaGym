-- A função pode existir somente no ambiente de origem (event trigger ensure_rls).
-- Revogar chamadas diretas quando presente; não criar stub em ambientes novos.
do $compat$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$compat$;
-- As tabelas CATMAT/PCA criadas após a revisão RLS de 202609180009
-- herdaram grants para `anon`. As policies permitem leitura somente para
-- `authenticated`; remover os grants mantém a ACL alinhada ao modelo declarado.
REVOKE ALL PRIVILEGES ON TABLE
  public.catmat_grupos,
  public.catmat_classes,
  public.catmat_pdms,
  public.catmat_pdm_naturezas_despesa,
  public.catmat_pdm_unidades,
  public.catmat_item_caracteristicas,
  public.pca_item_pdm
FROM anon;
