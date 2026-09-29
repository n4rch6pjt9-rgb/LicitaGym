-- LicitaGym: nível de confiança e scanner determinístico em licitacao_chunks
--
-- Contexto (claude/seguranca-prompt-injection-v1.md, seções 5.1 e 5.2): a recuperação do RAG misturava
-- trechos do órgão (edital, homologação) e de partes interessadas (recurso, contrarrazões, e-mail de
-- fornecedor) sem rótulo. Esta migration:
--   1. adiciona nivel_confianca / autor_tipo / autor_confirmado / scan / scan_versao;
--   2. faz o backfill a partir de metadados->>'tipo_documento';
--   3. cria o scanner private.scan_chunk_texto + trigger que marca 'suspeito' quando dispara;
--   4. escaneia os chunks existentes (UPDATE set texto = texto passa pelo trigger).
-- Baseline de 29/09/2026: 403 chunks, 0 sinais -> nenhum chunk deve virar 'suspeito'.
-- Regex de zero-width montado com chr(): caracteres invisíveis literais se perdem ao copiar.

-- 1) Colunas ------------------------------------------------------------------------------------------
alter table public.licitacao_chunks
  add column if not exists nivel_confianca text not null default 'externo',
  add column if not exists autor_tipo text,
  add column if not exists autor_confirmado boolean not null default false,
  add column if not exists scan jsonb,
  add column if not exists scan_versao text;

alter table public.licitacao_chunks
  drop constraint if exists licitacao_chunks_nivel_confianca_check,
  add constraint licitacao_chunks_nivel_confianca_check
    check (nivel_confianca in ('orgao_publicado','externo','parte_interessada','suspeito','bloqueado')),
  drop constraint if exists licitacao_chunks_autor_tipo_check,
  add constraint licitacao_chunks_autor_tipo_check
    check (autor_tipo is null or autor_tipo in ('orgao','fornecedor','terceiro','licitagym'));

comment on column public.licitacao_chunks.nivel_confianca is
  'orgao_publicado | externo | parte_interessada | suspeito | bloqueado. match_licitacao_chunks_v2 exclui suspeito/bloqueado e, por padrão, parte_interessada.';
comment on column public.licitacao_chunks.autor_confirmado is
  'true só quando o autor foi extraído do cabeçalho/assinatura do documento (não do nome do arquivo nem do lote).';

-- 2) Backfill a partir do metadado existente -----------------------------------------------------------
update public.licitacao_chunks set
  nivel_confianca = case
    when metadados->>'tipo_documento' in ('edital','aviso','homologacao','decisao_recurso','analise_tecnica','diligencia')
      then 'orgao_publicado'
    when metadados->>'tipo_documento' in ('recurso','contrarrazoes','proposta','outro')
      then 'parte_interessada'
    else 'externo' end,
  autor_tipo = case
    when metadados->>'tipo_documento' in ('recurso','contrarrazoes','proposta') then 'fornecedor'
    when metadados->>'tipo_documento' = 'outro' then 'terceiro'
    when metadados->>'tipo_documento' in ('edital','aviso','homologacao','decisao_recurso','analise_tecnica','diligencia') then 'orgao'
    else null end;

-- 3) Scanner -------------------------------------------------------------------------------------------
create or replace function private.scan_chunk_texto(t text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'instrucao_ao_modelo', t ~* '\m(ignore|desconsider\w*|esque[cç]a)\M.{0,40}\m(instru\w*|regras?|crit[eé]rios?|orienta\w*|anteriores?)\M',
    'papel_modelo',        t ~* '(voc[eê] [eé] (um|uma) (assistente|ia|modelo)|system prompt|prompt do sistema|modelo de linguagem)',
    'acao_tool',           t ~* '\m(envie|encaminhe|mande|execute)\M.{0,60}\m(e-?mail|ferramenta|tool|api)\M',
    'ocultacao',           t ~* '(n[aã]o mencion\w*|sem informar o usu[aá]rio)',
    'zero_width',          t ~  ('[' || chr(8203) || '-' || chr(8207) || chr(8288) || chr(65279) || ']'),
    'base64_longo',        t ~  '[A-Za-z0-9+/]{120,}={0,2}',
    'dominios', coalesce((
      select jsonb_agg(distinct rtrim(lower(m[1]), '.'))
      from regexp_matches(t, 'https?://([^/\s\)\]>"]+)', 'g') m), '[]'::jsonb)
  );
$$;

create or replace function private.trg_scan_chunk() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.scan := private.scan_chunk_texto(new.texto);
  new.scan_versao := 'regex-v1';
  if (new.scan->>'instrucao_ao_modelo')::boolean or (new.scan->>'papel_modelo')::boolean
     or (new.scan->>'acao_tool')::boolean or (new.scan->>'ocultacao')::boolean
     or (new.scan->>'zero_width')::boolean then
    new.nivel_confianca := 'suspeito';
  end if;
  return new;
end $$;

revoke all on function private.scan_chunk_texto(text) from public, anon, authenticated;
revoke all on function private.trg_scan_chunk() from public, anon, authenticated;
grant execute on function private.scan_chunk_texto(text), private.trg_scan_chunk() to service_role;

drop trigger if exists licitacao_chunks_scan on public.licitacao_chunks;
create trigger licitacao_chunks_scan before insert or update of texto
  on public.licitacao_chunks for each row execute function private.trg_scan_chunk();

-- 4) Escaneia a base existente --------------------------------------------------------------------------
update public.licitacao_chunks set texto = texto;
