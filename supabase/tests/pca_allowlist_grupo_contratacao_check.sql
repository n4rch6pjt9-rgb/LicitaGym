-- Checagem da migration 20261113120000_pca_allowlist_grupo_contratacao.sql. Falha com EXCEPTION se:
--   LISTA    a função private.pca_persistir_unidade_atomica não aceitar os 3 campos da spec 0056 em pca_itens;
--   ACL      anon ou authenticated puderem executar a função, ou service_role não puder;
--   SEGURO   a função deixar de ser SECURITY INVOKER com search_path vazio;
--   RESTO    ainda houver linha da fila em 'erro' com o erro "Campo PCA fora da lista permitida" que não foi reaberta;
--   EFEITO   linha marcada com o chain_id da reabertura estiver em 'pendente' sem os campos zerados.
-- No banco descartável a fila nasce vazia: RESTO e EFEITO passam; em produção provam a reabertura.
do $chk$
declare
  v_fn regprocedure := to_regprocedure('private.pca_persistir_unidade_atomica(text,jsonb,jsonb,uuid)');
  v_src text;
  v_campo text;
  v_n integer;
begin
  if v_fn is null then
    raise exception 'ACL CHECK FALHOU: private.pca_persistir_unidade_atomica não existe';
  end if;

  select p.prosrc into v_src from pg_proc p where p.oid = v_fn;
  foreach v_campo in array array['grupo_contratacao_codigo', 'grupo_contratacao_nome', 'data_atualizacao_origem'] loop
    if position(quote_literal(v_campo) in v_src) = 0 then
      raise exception 'pca_allowlist_grupo_contratacao_check (LISTA): % fora da lista da função', v_campo;
    end if;
  end loop;

  if has_function_privilege('anon', v_fn, 'execute')
     or has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception 'ACL CHECK FALHOU: execute de pca_persistir_unidade_atomica fora de service_role';
  end if;

  if exists (
    select 1 from pg_proc p
     where p.oid = v_fn
       and (p.prosecdef or coalesce(array_to_string(p.proconfig, ','), '') not in ('search_path=""', 'search_path='))
  ) then
    raise exception 'pca_allowlist_grupo_contratacao_check (SEGURO): função não é INVOKER com search_path vazio';
  end if;

  select count(*) into v_n
    from private.pca_plano_fila
   where status = 'erro'
     and erro like '%Campo PCA fora da lista permitida%'
     and erro not like 'reaberto allowlist; antes: %';
  if v_n > 0 then
    raise exception 'pca_allowlist_grupo_contratacao_check (RESTO): % linha(s) em erro pela lista não reabertas', v_n;
  end if;

  select count(*) into v_n
    from private.pca_plano_fila
   where chain_id = '00560000-0000-4000-8000-000000000057'::uuid
     and status = 'pendente'
     and (tentativas <> 0 or disponivel_em is not null or reserva_token is not null
       or erro is null or erro not like 'reaberto allowlist; antes: %');
  if v_n > 0 then
    raise exception 'pca_allowlist_grupo_contratacao_check (EFEITO): % linha(s) reaberta(s) sem os campos zerados', v_n;
  end if;

  raise notice 'SUCESSO pca_allowlist_grupo_contratacao_check: lista com os campos da 0056, ACL e fila reaberta';
end;
$chk$;
