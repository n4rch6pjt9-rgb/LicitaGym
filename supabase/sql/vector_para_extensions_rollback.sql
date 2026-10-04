-- Desfaz supabase/sql/vector_para_extensions.sql. Mesmo requisito de dono (supautils).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $r$
begin
  if (select extnamespace::regnamespace::text from pg_extension where extname = 'vector') = 'extensions' then
    alter extension vector set schema public;
  else
    raise notice 'vector não está em extensions: nada a fazer.';
  end if;
end
$r$;
commit;
