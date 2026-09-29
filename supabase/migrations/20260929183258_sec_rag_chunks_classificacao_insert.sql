-- LicitaGym: classificação de confiança também nas ingestões novas (review do PR #89)
--
-- Correções apontadas por Copilot e Codex nas migrations 20260929180030 e 20260929180039:
--   1. [BLOQUEANTE] O default 'externo' deixava recurso/contrarrazões/proposta novos fora do isolamento:
--      o indexador (services/coletor-externo/coletor/indexador.py) só grava tipo_documento em metadados.
--      Agora o trigger classifica a partir de metadados->>'tipo_documento' em todo INSERT e em UPDATE de
--      texto ou metadados.
--   2. [BLOQUEANTE] impugnacao (emitida pelo indexador, ia.py TIPOS) ficava 'externo'. Agora a política
--      cobre todos os 18 TIPOS do indexador e as seções usadas como fallback de tipo.
--   3. [IMPORTANTE] base64_longo passa a rebaixar o chunk para 'suspeito'.
--   4. [IMPORTANTE] match_licitacao_chunks_v2 ignora chunks sem embedding (similaridade NULL).
--
-- Regras do trigger:
--   * 'bloqueado' é decisão manual/guardrail: nunca é sobrescrito, só o scan é recalculado.
--   * INSERT com nivel_confianca explícito (diferente do default 'externo') mantém o rótulo do produtor.
--   * Nos demais casos o rótulo base vem de private.classificar_tipo_documento(tipo); se o scanner
--     disparar, o chunk vira 'suspeito'. 'suspeito' é derivado do conteúdo: some se o texto for limpo.
--   * UPDATE de texto/metadados recalcula o rótulo base (curadoria manual diferente de 'bloqueado'
--     não sobrevive a um reindex; usar 'bloqueado' para exclusões definitivas).

create or replace function private.classificar_tipo_documento(tipo text, out nivel text, out autor text)
language sql immutable set search_path = '' as $f$
  select
    case
      when tipo in ('edital','aviso','termo_referencia','ata_sessao','analise_tecnica','diligencia',
                    'decisao_recurso','adjudicacao','homologacao','revogacao','contrato','parecer')
        then 'orgao_publicado'
      when tipo in ('proposta','habilitacao','recurso','contrarrazoes','lance','impugnacao','outro')
        then 'parte_interessada'
      else 'externo'  -- esclarecimento (pergunta de terceiro + resposta do órgão), 'processo', nulo, desconhecido
    end,
    case
      when tipo in ('edital','aviso','termo_referencia','ata_sessao','analise_tecnica','diligencia',
                    'decisao_recurso','adjudicacao','homologacao','revogacao','contrato','parecer')
        then 'orgao'
      when tipo in ('proposta','habilitacao','recurso','contrarrazoes','lance') then 'fornecedor'
      when tipo in ('impugnacao','outro') then 'terceiro'
      else null
    end;
$f$;

create or replace function private.trg_scan_chunk() returns trigger
language plpgsql set search_path = '' as $f$
declare
  v_base text;
  v_autor text;
  v_suspeito boolean;
begin
  new.scan := private.scan_chunk_texto(new.texto);
  new.scan_versao := 'regex-v2';

  if new.nivel_confianca = 'bloqueado' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.nivel_confianca is distinct from 'externo' then
    v_base := new.nivel_confianca;           -- rótulo explícito do produtor
    v_autor := new.autor_tipo;
  else
    select c.nivel, c.autor into v_base, v_autor
      from private.classificar_tipo_documento(new.metadados->>'tipo_documento') c;
  end if;

  v_suspeito := coalesce((new.scan->>'instrucao_ao_modelo')::boolean, false)
             or coalesce((new.scan->>'papel_modelo')::boolean, false)
             or coalesce((new.scan->>'acao_tool')::boolean, false)
             or coalesce((new.scan->>'ocultacao')::boolean, false)
             or coalesce((new.scan->>'zero_width')::boolean, false)
             or coalesce((new.scan->>'base64_longo')::boolean, false);

  new.nivel_confianca := case when v_suspeito then 'suspeito' else v_base end;
  new.autor_tipo := coalesce(v_autor, new.autor_tipo);
  return new;
end $f$;

revoke all on function private.classificar_tipo_documento(text) from public, anon, authenticated;
revoke all on function private.trg_scan_chunk() from public, anon, authenticated;
grant execute on function private.classificar_tipo_documento(text), private.trg_scan_chunk() to service_role;

drop trigger if exists licitacao_chunks_scan on public.licitacao_chunks;
create trigger licitacao_chunks_scan before insert or update of texto, metadados
  on public.licitacao_chunks for each row execute function private.trg_scan_chunk();

-- Reprocessa a base com as regras novas (scan v2 + classificação pelo tipo).
update public.licitacao_chunks set texto = texto;

create or replace function public.match_licitacao_chunks_v2(
  query_embedding vector,
  match_count integer default 10,
  filtro_secao text default null,
  filtro_fonte text default null,
  incluir_partes_interessadas boolean default false
)
returns table(chunk_id bigint, documento_id bigint, licitacao_id bigint, secao text, texto text,
              numero_processo text, objeto text, nome_original text,
              tipo_documento text, nivel_confianca text, autor_tipo text, fornecedor text,
              similaridade double precision)
language sql stable set search_path = public as $f$
  select c.id, c.documento_id, c.licitacao_id, c.secao, c.texto,
         l.numero_processo, l.objeto, d.nome_original,
         c.metadados->>'tipo_documento', c.nivel_confianca, c.autor_tipo, c.metadados->>'fornecedor',
         1 - (c.embedding <=> query_embedding)
  from public.licitacao_chunks c
  join public.licitacao_documentos d on d.id = c.documento_id
  join public.licitacoes_externas  l on l.id = c.licitacao_id
  where c.embedding is not null
    and c.nivel_confianca not in ('suspeito','bloqueado')
    and (incluir_partes_interessadas or c.nivel_confianca <> 'parte_interessada')
    and (filtro_secao is null or c.secao = filtro_secao)
    and (filtro_fonte is null or l.fonte = filtro_fonte)
  order by c.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 10), 1), 20);
$f$;

revoke all on function public.match_licitacao_chunks_v2(vector, integer, text, text, boolean) from public, anon, authenticated;
grant execute on function public.match_licitacao_chunks_v2(vector, integer, text, text, boolean) to service_role;
