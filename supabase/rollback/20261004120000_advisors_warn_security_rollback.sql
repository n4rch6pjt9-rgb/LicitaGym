-- Volta ao estado anterior a 20261004120000_advisors_warn_security (produção em 03/10/2026):
--   catmat_item_completo: authenticated volta a ter SELECT (estado lido: authenticated=r, anon sem grant).
--   update_updated_at_column() e taxonomia_bloco(text): search_path volta a ser o do chamador (RESET).
--   match_*: search_path volta a ser só public.
-- ATENÇÃO: se vector já tiver sido movida para extensions (supabase/sql/vector_para_extensions.sql),
-- NÃO rode o bloco dos match_* sem antes desfazer aquela mudança: com search_path=public o operador
-- <=> não resolve e as buscas RAG (match_licitacao_chunks_v2 etc.) passam a falhar.
-- Idempotente. Rode como postgres.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $a$
begin
  if to_regclass('public.catmat_item_completo') is not null then
    grant select on table public.catmat_item_completo to authenticated;
  end if;
end
$a$;

do $c$
begin
  if to_regprocedure('public.update_updated_at_column()') is not null then
    alter function public.update_updated_at_column() reset search_path;
  end if;
  if to_regprocedure('public.taxonomia_bloco(text)') is not null then
    alter function public.taxonomia_bloco(text) reset search_path;
  end if;
end
$c$;

do $d$
declare
  v_sig text;
  v_fn  regprocedure;
begin
  if (select extnamespace::regnamespace::text from pg_extension where extname = 'vector') is distinct from 'public' then
    raise exception 'vector não está em public: desfaça vector_para_extensions antes de voltar match_* para search_path=public';
  end if;
  foreach v_sig in array array[
    'public.match_legislacao_embeddings(vector,double precision,integer)',
    'public.match_licitacao_chunks(vector,integer,text,text)',
    'public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)',
    'public.match_catalogo_chunks(vector,integer,text,text)'
  ] loop
    v_fn := to_regprocedure(v_sig);
    continue when v_fn is null;
    execute format('alter function %s set search_path = public', v_fn);
  end loop;
end
$d$;

commit;
