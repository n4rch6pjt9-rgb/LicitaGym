-- P0.3-G5.1 — SOMENTE PostgreSQL descartável com migration aplicada.
-- Requer pelo menos um registro fixture em public.licitacao_documentos.
-- Todos os INSERTs de teste são revertidos por ROLLBACK.
BEGIN;
DO $test$
DECLARE
  doc_id bigint;
  id_1 bigint;
  id_2 bigint;
  h1 text := repeat('a', 64);
  h2 text := repeat('b', 64);
  erro text;
BEGIN
  SELECT id INTO doc_id FROM public.licitacao_documentos ORDER BY id LIMIT 1;
  IF doc_id IS NULL THEN
    RAISE EXCEPTION 'Pré-condição ausente: criar fixture licitacao_documentos no banco descartável';
  END IF;
  -- Evita colisão com fixtures de execução anterior; o teste deve ser executado em banco descartável.
  IF EXISTS (SELECT 1 FROM public.licitacao_documento_versoes WHERE documento_id = doc_id AND sha256 IN (h1,h2)) THEN
    RAISE EXCEPTION 'Hashes de teste já existem: use banco descartável limpo';
  END IF;
  INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes,mime_type)
  VALUES(doc_id,h1,'test://versao-a',3,'application/pdf') RETURNING id INTO id_1;
  ASSERT id_1 IS NOT NULL, 'INSERT não retornou ID';
  BEGIN
    INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
    VALUES(doc_id,h1,'test://duplicado',3);
    RAISE EXCEPTION 'Duplicação foi aceita';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
  VALUES(doc_id,h2,'test://versao-b',4) RETURNING id INTO id_2;
  ASSERT id_1 <> id_2, 'IDs de versões não são distintos';
  BEGIN
    UPDATE public.licitacao_documento_versoes SET mime_type='text/plain' WHERE id=id_1;
    RAISE EXCEPTION 'UPDATE foi aceito';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS erro = MESSAGE_TEXT;
    IF erro <> 'Histórico documental imutável: UPDATE/DELETE proibido' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.licitacao_documento_versoes WHERE id=id_1;
    RAISE EXCEPTION 'DELETE foi aceito';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS erro = MESSAGE_TEXT;
    IF erro <> 'Histórico documental imutável: UPDATE/DELETE proibido' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
    VALUES(-9223372036854775807,repeat('c',64),'test://fk',1);
    RAISE EXCEPTION 'FK inválida foi aceita';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
    VALUES(doc_id,'inválido','test://hash',1);
    RAISE EXCEPTION 'Hash inválido foi aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
    VALUES(doc_id,repeat('c',64),'   ',1);
    RAISE EXCEPTION 'URI vazia foi aceita';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.licitacao_documento_versoes(documento_id,sha256,storage_uri,tamanho_bytes)
    VALUES(doc_id,repeat('d',64),'test://negative',-1);
    RAISE EXCEPTION 'Tamanho negativo foi aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'G5.1: 8 verificações de integridade concluídas (rollback a seguir)';
END
$test$;
ROLLBACK;
