-- Verificação de ACL e do scanner do RAG (prompt injection)
-- (migrations 20260929180014_sec_rag_acl_lock, 20260929180030_sec_rag_chunks_confianca e 20260929180039_sec_rag_match_licitacao_chunks_v2).
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sec_rag_prompt_injection_acl_check.sql):
--   1. legislacao / legislacao_embeddings: anon e authenticated só SELECT; sem policy de escrita para eles
--   2. consultas_log: anon sem nada; authenticated só SELECT; policy por dono; user_id NOT NULL
--   3. match_licitacao_chunks e _v2: EXECUTE só service_role (pega drift de grant, como o de 29/09/2026)
--   4. match_legislacao_embeddings: sem EXECUTE para anon/PUBLIC; search_path fixo
--   5. licitacao_chunks: trigger de scanner presente; nenhum chunk sem scan; regex de zero-width não casa com hífen
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_obj text;
  v_priv text;
  v_fn regprocedure;
  v_n bigint;
begin
  -- 1. base normativa
  foreach v_obj in array array['public.legislacao', 'public.legislacao_embeddings', 'public.consultas_log'] loop
    foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) or has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: anon/authenticated possui % em %', v_priv, v_obj;
      end if;
    end loop;
    if not has_table_privilege('service_role', v_obj, 'INSERT') then
      raise exception 'ACL CHECK FALHOU: service_role sem INSERT em %', v_obj;
    end if;
  end loop;
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename in ('legislacao','legislacao_embeddings','consultas_log')
     and cmd in ('INSERT','UPDATE','DELETE','ALL');
  if v_n > 0 then
    raise exception 'ACL CHECK FALHOU: % policy(ies) de escrita em legislacao/legislacao_embeddings/consultas_log', v_n;
  end if;

  -- 2. consultas_log
  if has_table_privilege('anon', 'public.consultas_log', 'SELECT') then
    raise exception 'ACL CHECK FALHOU: anon possui SELECT em consultas_log';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'consultas_log'
                  and policyname = 'consultas_log_select_own' and qual like '%auth.uid()%') then
    raise exception 'ACL CHECK FALHOU: policy consultas_log_select_own ausente ou sem filtro por dono';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consultas_log'
              and column_name = 'user_id' and (is_nullable = 'YES' or column_default is not null)) then
    raise exception 'ACL CHECK FALHOU: consultas_log.user_id deve ser NOT NULL e sem default';
  end if;

  -- 3. funções de chunks de licitação: só service_role
  foreach v_obj in array array['public.match_licitacao_chunks(vector,integer,text,text)',
                               'public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)'] loop
    v_fn := to_regprocedure(v_obj);
    if v_fn is null then
      raise exception 'ACL CHECK FALHOU: função % não existe', v_obj;
    end if;
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'ACL CHECK FALHOU: anon/authenticated/PUBLIC possui EXECUTE em %', v_obj;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'ACL CHECK FALHOU: service_role sem EXECUTE em %', v_obj;
    end if;
  end loop;

  -- 4. match_legislacao_embeddings
  v_fn := to_regprocedure('public.match_legislacao_embeddings(vector,double precision,integer)');
  if v_fn is null then
    raise exception 'ACL CHECK FALHOU: função match_legislacao_embeddings não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'ACL CHECK FALHOU: anon/PUBLIC possui EXECUTE em match_legislacao_embeddings';
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn and proconfig is not null
                  and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    raise exception 'ACL CHECK FALHOU: match_legislacao_embeddings sem search_path fixo';
  end if;

  -- 5. scanner
  if not exists (select 1 from pg_trigger where tgrelid = 'public.licitacao_chunks'::regclass
                  and tgname = 'licitacao_chunks_scan' and not tgisinternal) then
    raise exception 'ACL CHECK FALHOU: trigger licitacao_chunks_scan ausente';
  end if;
  select count(*) into v_n from public.licitacao_chunks where scan is null;
  if v_n > 0 then
    raise exception 'ACL CHECK FALHOU: % chunk(s) sem scan', v_n;
  end if;
  if (private.scan_chunk_texto('PE 112/2025 - SEST/SENAT')->>'zero_width')::boolean then
    raise exception 'ACL CHECK FALHOU: regex de zero-width casa com hífen';
  end if;
  if not (private.scan_chunk_texto(('a' || chr(8203) || 'b'))->>'zero_width')::boolean then
    raise exception 'ACL CHECK FALHOU: regex de zero-width não detecta U+200B';
  end if;

  raise notice 'SUCESSO: ACL e scanner do RAG conferidos';
end $$;
