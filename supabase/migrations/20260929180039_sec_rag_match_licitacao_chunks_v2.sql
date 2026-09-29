-- LicitaGym: match_licitacao_chunks_v2 — recuperação com isolamento por nível de confiança
--
-- Contexto (claude/seguranca-prompt-injection-v1.md, seção 5.3). A v1 devolve trechos do órgão e de
-- partes interessadas sem rótulo. A v2:
--   * nunca devolve chunks 'suspeito' ou 'bloqueado';
--   * só devolve 'parte_interessada' (recurso, contrarrazões, proposta, e-mail de fornecedor) quando o
--     chamador pede explicitamente (pergunta SOBRE a alegação, nunca pergunta de fato ou de norma);
--   * devolve tipo_documento, nivel_confianca, autor_tipo e fornecedor para o envelope do prompt;
--   * limita match_count a 20.
-- Só service_role (Edge Function do assistente). A v1 continua existindo até o assistente migrar.

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
language sql stable set search_path = public as $$
  select c.id, c.documento_id, c.licitacao_id, c.secao, c.texto,
         l.numero_processo, l.objeto, d.nome_original,
         c.metadados->>'tipo_documento', c.nivel_confianca, c.autor_tipo, c.metadados->>'fornecedor',
         1 - (c.embedding <=> query_embedding)
  from public.licitacao_chunks c
  join public.licitacao_documentos d on d.id = c.documento_id
  join public.licitacoes_externas  l on l.id = c.licitacao_id
  where c.nivel_confianca not in ('suspeito','bloqueado')
    and (incluir_partes_interessadas or c.nivel_confianca <> 'parte_interessada')
    and (filtro_secao is null or c.secao = filtro_secao)
    and (filtro_fonte is null or l.fonte = filtro_fonte)
  order by c.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 10), 1), 20);
$$;

revoke all on function public.match_licitacao_chunks_v2(vector, integer, text, text, boolean) from public, anon, authenticated;
grant execute on function public.match_licitacao_chunks_v2(vector, integer, text, text, boolean) to service_role;
