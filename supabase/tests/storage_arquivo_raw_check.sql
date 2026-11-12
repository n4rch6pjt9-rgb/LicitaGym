-- Checagem da migration 20261112180000_storage_arquivo_raw.
-- Bucket privado, só gzip, 50 MB, e nenhuma policy de storage.objects que abra o bucket para anon ou authenticated.

do $$
declare
  v_publico boolean;
  v_limite bigint;
  v_tipos text[];
  v_policies int;
begin
  select public, file_size_limit, allowed_mime_types
    into v_publico, v_limite, v_tipos
    from storage.buckets where id = 'arquivo-raw';
  if not found then
    raise exception 'CHECK FALHOU: bucket arquivo-raw não existe';
  end if;
  if v_publico is distinct from false then
    raise exception 'CHECK FALHOU: bucket arquivo-raw não pode ser público';
  end if;
  if v_limite is distinct from 52428800 then
    raise exception 'CHECK FALHOU: limite do bucket arquivo-raw esperado 52428800, veio %', v_limite;
  end if;
  if v_tipos is distinct from array['application/gzip'] then
    raise exception 'CHECK FALHOU: tipos aceitos do bucket arquivo-raw esperados {application/gzip}, veio %', v_tipos;
  end if;

  select count(*) into v_policies
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%arquivo-raw%';
  if v_policies > 0 then
    raise exception 'CHECK FALHOU: % policy(ies) em storage.objects citam o bucket arquivo-raw', v_policies;
  end if;

  raise notice 'SUCESSO: bucket arquivo-raw privado, só gzip, sem policy para anon/authenticated';
end $$;
