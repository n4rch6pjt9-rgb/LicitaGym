-- Somente leitura. Executar no ambiente que deseja inspecionar.
SELECT to_regclass('public.licitacao_documento_versoes') AS tabela_versoes;
SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS definicao
FROM pg_constraint c
WHERE c.conrelid = to_regclass('public.licitacao_documento_versoes')
ORDER BY c.conname;
SELECT relrowsecurity AS rls_ativo
FROM pg_class WHERE oid = to_regclass('public.licitacao_documento_versoes');
SELECT rolname, has_table_privilege(rolname, 'public.licitacao_documento_versoes', 'SELECT') AS pode_ler,
       has_table_privilege(rolname, 'public.licitacao_documento_versoes', 'INSERT') AS pode_inserir,
       has_table_privilege(rolname, 'public.licitacao_documento_versoes', 'UPDATE') AS pode_atualizar,
       has_table_privilege(rolname, 'public.licitacao_documento_versoes', 'DELETE') AS pode_excluir
FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')
AND to_regclass('public.licitacao_documento_versoes') IS NOT NULL
ORDER BY rolname;
