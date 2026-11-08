-- LicitaGym: apaga do catálogo legislacao_* os documentos que não são norma (spec 0042, K-3)
--
-- Contexto: o sync-pncp-legislation (aposentado em 20261109000000) gravou como "vigente" links de navegação das
-- páginas-índice: "GOV.BR", "Guia do Fornecedor", "Combate à Discriminação Racial", "Resoluções revogadas" etc.
-- Medido em produção em 08/11/2026: 32 documentos, 27 versões, 27 alertas. As 11 normas vieram do seed
-- 20260920142857 (tipo_norma preenchido, nenhuma versão); os outros 21 documentos vieram do sync (2 em 20/09, 19 em
-- 05/10), e todas as 27 versões e 27 alertas são deles. Decisão do Marcelo (08/11): apagar.
--
-- O que muda:
--   * private.legislacao_apagar_documentos(uuid[]): apaga os documentos da lista com versões, alertas e relações.
--     Recusa (exceção, nada apagado) se algum for norma (tipo_norma preenchido) ou estiver ligado a uma seção da
--     API do Compras (compras_api_secao_legislacao). Documento que não existe é ignorado (idempotente).
--   * apaga os 21 documentos por id (lista explícita, conferida em produção em 08/11; nunca por padrão de título).
-- Fora daqui: os 27 arquivos no bucket pncp-legislation (Storage, ~3,8 MB) saem pelo script de operação
-- scripts/operacao/legislacao_apagar_arquivos.py (API de Storage, com --dry-run), rodado pelo Marcelo.
-- Backup: não (decisão de 08/11: o lixo não tem valor; as normas do seed ficam).
-- ACL: função nova sem EXECUTE para public, anon, authenticated nem service_role (só o dono, nas migrations).
-- Verificação: supabase/tests/legislacao_limpeza_catalogo_check.sql. Idempotente.

begin;

set local lock_timeout = '10s';

create or replace function private.legislacao_apagar_documentos(p_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_norma text;
  v_apagados integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  select string_agg(d.id::text || ' (' || d.titulo || ')', ', ') into v_norma
    from public.legislacao_documentos d
   where d.id = any (p_ids)
     and (d.tipo_norma is not null
          or exists (select 1 from public.compras_api_secao_legislacao s where s.documento_id = d.id));
  if v_norma is not null then
    raise exception 'legislacao_apagar_documentos: a lista tem norma do seed; nada apagado: %', v_norma;
  end if;

  update public.legislacao_documentos set versao_atual_id = null
   where id = any (p_ids) and versao_atual_id is not null;
  delete from public.legislacao_alertas where documento_id = any (p_ids);
  delete from public.legislacao_relacoes
   where documento_origem_id = any (p_ids) or documento_destino_id = any (p_ids);
  delete from public.legislacao_versoes where documento_id = any (p_ids);
  delete from public.legislacao_documentos where id = any (p_ids);
  get diagnostics v_apagados = row_count;
  return v_apagados;
end
$fn$;

comment on function private.legislacao_apagar_documentos(uuid[]) is
  'Spec 0042 (K-3): apaga documentos-lixo do catálogo legislacao_* com versões, alertas e relações. Recusa norma '
  '(tipo_norma preenchido ou ligada a compras_api_secao_legislacao). Só para migrations.';

revoke all on function private.legislacao_apagar_documentos(uuid[]) from public, anon, authenticated, service_role;

do $do$
declare
  v_apagados integer;
begin
  v_apagados := private.legislacao_apagar_documentos(array[
    '6b1914a7-013d-4514-a183-fbadef62a3a0', -- Legislação (gov.br/pncp, 20/09)
    '65a6033d-2607-453d-a243-f6c4f10f73d2', -- Legislação (catálogo eletrônico, 20/09)
    'fc3a0781-ea55-40b4-96d4-0e5b2f02ee91', -- Legislação (gov.br/compras)
    '98aac7ff-cc63-4da7-962f-137e41344649', -- Legislação por Tema
    '943fdc56-95b6-4ff0-8997-69ec7ccf0d91', -- Leis
    '4a1e7ce5-4c8d-4ce1-83dc-ff3036c68acb', -- Decretos
    '1df94fe3-f73f-4b19-9851-e806f2cb27aa', -- Portarias
    '497f00ca-26f9-4dc2-bd20-a54dd122fcc8', -- Portarias revogadas
    '0dd9f98e-658f-44fa-b5f5-c1661f30d2dc', -- Instruções Normativas
    '10cb11c3-dcc4-4686-8268-f7e167739b85', -- Instruções Normativas revogadas
    'e38f735c-12a2-46be-aaa9-00b62ab0310c', -- Orientações Normativas
    'd5f834e3-d2a6-44d7-a7fe-db01d867f4a8', -- Orientações Normativas revogadas
    '91adccb9-d46e-469e-ba1c-1cb4d3e8ecfb', -- Resoluções
    'a36e57d3-c4b7-4f30-b5f3-2ca446c32ee1', -- Resoluções Revogadas
    '63bd3b2c-fe41-4cb2-81f3-b2ab6857a6fb', -- Pregão Eletrônico
    '5bb41e1e-a2ad-4f43-ac30-fbc2d2400b14', -- Guia do Fornecedor
    'ced92e58-aaf8-4b04-af4b-d149268d8df8', -- GOV.BR
    '252f15e0-f40b-45e5-94da-767b627415a5', -- Combate à Discriminação Racial
    'a4541eeb-ae1e-44a1-82c1-d730bd2e1dc7', -- Legislação / Acesso à Informação / Participe
    '97ebb70f-b332-4241-876a-846d1b7623a0', -- Lei nº 14.133/21 por Tema (página do gov.br, não a lei)
    '36cbd6e7-5187-4f2c-af23-995f9254f06f'  -- Legislação por Tema (-1)
  ]::uuid[]);
  raise notice 'legislacao_limpeza_catalogo: % documento(s) apagado(s)', v_apagados;
end
$do$;

commit;
