-- Bucket privado `arquivo-raw`: original (raw) dos itens e resultados coletados pelo coletor PNCP no GitHub Actions.
--
-- Por quê: desde 04/10/2026 o raw sai de licitacao_itens.raw / licitacao_resultados.raw para um arquivo imutável
-- (contrato gcs-raw-1, services/coletor-externo/coletor/arquivo_raw.py). O coletor do Actions não tem credencial do
-- GCP e rodava com ARQUIVO_RAW_GCS=0: o JSONL.gz ia para o disco do runner e se perdia no fim do job (medido em
-- 12/11/2026 no log do run de 10/11). Decisão do Marcelo (12/11/2026): o destino do Actions passa a ser o Storage do
-- Supabase, com a service role que o job já usa.
--
-- O que muda: só o bucket. Privado, 50 MB por objeto, só application/gzip. Sem policy em storage.objects: anon e
-- authenticated não leem nem gravam; quem grava e lê é a service_role (que ignora RLS), pelo coletor.
-- Caminho dos objetos: arquivo-db/<tabela>/<fonte>/<AAAA-MM-DD UTC>/<execucao_id>-<lote>.jsonl.gz (o mesmo do GCS).
--
-- Como verificar: supabase/tests/storage_arquivo_raw_check.sql.

begin;

set local lock_timeout = '10s';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'arquivo-raw',
  'arquivo-raw',
  false,
  52428800,
  array['application/gzip']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;
