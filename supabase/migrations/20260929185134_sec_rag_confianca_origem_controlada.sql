-- LicitaGym: confiança dos chunks derivada só de origem controlada pelo coletor (review 2 do PR #89)
--
-- Problema (Copilot, BLOQUEANTE): a 20260929183258 derivava nivel_confianca de
-- metadados->>'tipo_documento', que o indexador preenche com a extração do Gemini
-- (services/coletor-externo/coletor/indexador.py: ia.extrair_campos). Um documento de parte
-- interessada poderia ser rotulado pelo modelo como 'edital' e ganhar 'orgao_publicado'.
--
-- Regra nova (private.classificar_origem_controlada):
--   * A base vem de sinais que o coletor controla:
--       - secao do portal: recurso, contrarrazoes, proposta, habilitacao, lance -> parte_interessada
--                          parecer                                              -> orgao_publicado
--                          processo e demais                                    -> externo
--     metadados->>'fornecedor' NÃO é sinal de autoria: o coletor o preenche com o participante
--     associado ao documento (a decisão do órgão sobre o recurso da empresa X também o traz).
--   * O tipo_documento da IA só pode REBAIXAR a confiança (nunca elevar): se a IA disser que é
--     proposta/recurso/impugnacao/outro etc., o chunk vira parte_interessada; se disser que é
--     edital, nada muda. Um atacante que manipule a extração só consegue esconder o próprio texto.
--   * autor_tipo só vem de sinal controlado (secao); o rebaixamento pela IA marca
--     'terceiro' (autor desconhecido, não órgão).
-- Ordem de confiança: orgao_publicado > externo > parte_interessada. 'suspeito' (scanner) e
-- 'bloqueado' (manual) continuam como antes.

create or replace function private.classificar_origem_controlada(
  metadados jsonb, secao text, out nivel text, out autor text)
language plpgsql immutable set search_path = '' as $f$
declare
  v_tipo_ia text := metadados->>'tipo_documento';
  v_ia_parte boolean;
begin
  if secao in ('recurso','contrarrazoes','proposta','habilitacao','lance') then
    nivel := 'parte_interessada'; autor := 'fornecedor';
  elsif secao = 'parecer' then
    nivel := 'orgao_publicado'; autor := 'orgao';
  else
    nivel := 'externo'; autor := null;
  end if;

  -- rebaixamento pela classificação descritiva da IA (nunca eleva)
  v_ia_parte := (select c.nivel from private.classificar_tipo_documento(v_tipo_ia) c) = 'parte_interessada';
  if v_ia_parte and nivel <> 'parte_interessada' then
    nivel := 'parte_interessada';
    autor := coalesce(autor, 'terceiro');
    if autor = 'orgao' then autor := 'terceiro'; end if;
  end if;
end $f$;

comment on function private.classificar_origem_controlada(jsonb, text) is
  'Confiança do chunk a partir da secao do portal (controlada pelo coletor). tipo_documento (IA) só rebaixa.';

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

  select c.nivel, c.autor into v_base, v_autor
    from private.classificar_origem_controlada(new.metadados, new.secao) c;

  -- rótulo explícito do produtor no INSERT só vale se for MAIS restritivo que a origem
  if tg_op = 'INSERT' and new.nivel_confianca = 'parte_interessada' then
    v_base := 'parte_interessada';
    v_autor := coalesce(new.autor_tipo, v_autor, 'terceiro');
  end if;

  v_suspeito := coalesce((new.scan->>'instrucao_ao_modelo')::boolean, false)
             or coalesce((new.scan->>'papel_modelo')::boolean, false)
             or coalesce((new.scan->>'acao_tool')::boolean, false)
             or coalesce((new.scan->>'ocultacao')::boolean, false)
             or coalesce((new.scan->>'zero_width')::boolean, false)
             or coalesce((new.scan->>'base64_longo')::boolean, false);

  new.nivel_confianca := case when v_suspeito then 'suspeito' else v_base end;
  new.autor_tipo := v_autor;
  return new;
end $f$;

revoke all on function private.classificar_origem_controlada(jsonb, text) from public, anon, authenticated;
revoke all on function private.trg_scan_chunk() from public, anon, authenticated;
grant execute on function private.classificar_origem_controlada(jsonb, text), private.trg_scan_chunk() to service_role;

drop trigger if exists licitacao_chunks_scan on public.licitacao_chunks;
create trigger licitacao_chunks_scan before insert or update of texto, metadados, secao
  on public.licitacao_chunks for each row execute function private.trg_scan_chunk();

update public.licitacao_chunks set texto = texto;
