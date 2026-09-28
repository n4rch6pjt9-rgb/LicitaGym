-- SEC-DB-003 / SEC-DB-004 — Security remediation R1
-- Revoke anon/authenticated EXECUTE on refresh_catmat_item_completo
-- Harden catmat_item_completo matview to SELECT-only for authenticated
--
-- BEFORE (deployed ifaiagegyicjzlpskafh 2026-09-22):
--   refresh_catmat_item_completo ACL: postgres=X, anon=X, authenticated=X, service_role=X
--   catmat_item_completo ACL: postgres=ALL, authenticated=ALL, service_role=ALL
-- EXPECTED AFTER:
--   refresh: EXECUTE for service_role (+ owner); NOT anon/authenticated/PUBLIC
--   matview: SELECT for authenticated; ALL for service_role/owner; NOT write for authenticated
--
-- Idempotent: guarded with IF EXISTS. Does not REFRESH the matview.
-- Does not alter catmat_* Source Truth tables.

DO $$
BEGIN
  IF to_regprocedure('public.refresh_catmat_item_completo()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.refresh_catmat_item_completo() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.refresh_catmat_item_completo() FROM anon;
    REVOKE ALL ON FUNCTION public.refresh_catmat_item_completo() FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.refresh_catmat_item_completo() TO service_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.catmat_item_completo') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.catmat_item_completo FROM PUBLIC;
    REVOKE ALL ON TABLE public.catmat_item_completo FROM anon;
    REVOKE ALL ON TABLE public.catmat_item_completo FROM authenticated;
    GRANT SELECT ON TABLE public.catmat_item_completo TO authenticated;
    GRANT ALL ON TABLE public.catmat_item_completo TO service_role;
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regprocedure('public.refresh_catmat_item_completo()') IS NOT NULL THEN
    EXECUTE $comment$
      COMMENT ON FUNCTION public.refresh_catmat_item_completo() IS
        'SEC-R1: REFRESH read-model matview only; EXECUTE restricted to service_role.'
    $comment$;
  END IF;
END
$$;
