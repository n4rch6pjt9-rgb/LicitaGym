-- Checagem da 20261002200000_licitacao_chunks_embedding_model (roda em scripts/validar-migrations.sh).
--   1. coluna existe, é text e tem default 'text-multilingual-embedding-002';
--   2. nenhum chunk com embedding fica sem embedding_model;
--   3. o trigger de scan continua cobrindo só texto/metadados/secao (o backfill conta com isso).
do $$
declare
  v_tipo text;
  v_default text;
  v_n bigint;
begin
  select data_type, column_default into v_tipo, v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'licitacao_chunks' and column_name = 'embedding_model';
  if v_tipo is null then
    raise exception 'CHECK FALHOU: licitacao_chunks.embedding_model ausente';
  end if;
  if v_tipo <> 'text' then
    raise exception 'CHECK FALHOU: embedding_model é %, esperado text', v_tipo;
  end if;
  if coalesce(v_default, '') not like '%text-multilingual-embedding-002%' then
    raise exception 'CHECK FALHOU: default de embedding_model é %', v_default;
  end if;

  select count(*) into v_n from public.licitacao_chunks where embedding is not null and embedding_model is null;
  if v_n > 0 then
    raise exception 'CHECK FALHOU: % chunk(s) com embedding e sem embedding_model', v_n;
  end if;

  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.licitacao_chunks'::regclass
                  and t.tgname = 'licitacao_chunks_scan'
                  and pg_get_triggerdef(t.oid) like '%INSERT OR UPDATE OF texto, metadados, secao%') then
    raise exception 'CHECK FALHOU: trigger licitacao_chunks_scan mudou (o backfill de embedding_model contava com ele fora)';
  end if;

  raise notice 'SUCESSO: licitacao_chunks.embedding_model conferido';
end $$;
