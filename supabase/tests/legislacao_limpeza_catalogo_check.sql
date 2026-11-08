-- Spec 0042 (K-3, CA-5): limpeza do catálogo legislacao_* (migration 20261109000100_legislacao_limpeza_catalogo).
--   1. Nenhum dos 21 documentos-lixo da lista existe mais (documentos, versões, alertas).
--   2. As normas do seed (tipo_norma preenchido) que existirem continuam 'vigente'.
--   3. private.legislacao_apagar_documentos(uuid[]): apaga documento sem tipo_norma com versões e alertas; recusa
--      documento com tipo_norma (norma do seed); rodar de novo não muda nada. EXECUTE de ninguém além do dono.
-- As linhas de teste são desfeitas no fim (bloco interno encerrado por exceção sentinela).

do $$
declare
  v_fn regprocedure := to_regprocedure('private.legislacao_apagar_documentos(uuid[])');
  v_lixo constant uuid[] := array[
    '6b1914a7-013d-4514-a183-fbadef62a3a0', '65a6033d-2607-453d-a243-f6c4f10f73d2',
    'fc3a0781-ea55-40b4-96d4-0e5b2f02ee91', '98aac7ff-cc63-4da7-962f-137e41344649',
    '943fdc56-95b6-4ff0-8997-69ec7ccf0d91', '4a1e7ce5-4c8d-4ce1-83dc-ff3036c68acb',
    '1df94fe3-f73f-4b19-9851-e806f2cb27aa', '497f00ca-26f9-4dc2-bd20-a54dd122fcc8',
    '0dd9f98e-658f-44fa-b5f5-c1661f30d2dc', '10cb11c3-dcc4-4686-8268-f7e167739b85',
    'e38f735c-12a2-46be-aaa9-00b62ab0310c', 'd5f834e3-d2a6-44d7-a7fe-db01d867f4a8',
    '91adccb9-d46e-469e-ba1c-1cb4d3e8ecfb', 'a36e57d3-c4b7-4f30-b5f3-2ca446c32ee1',
    '63bd3b2c-fe41-4cb2-81f3-b2ab6857a6fb', '5bb41e1e-a2ad-4f43-ac30-fbc2d2400b14',
    'ced92e58-aaf8-4b04-af4b-d149268d8df8', '252f15e0-f40b-45e5-94da-767b627415a5',
    'a4541eeb-ae1e-44a1-82c1-d730bd2e1dc7', '97ebb70f-b332-4241-876a-846d1b7623a0',
    '36cbd6e7-5187-4f2c-af23-995f9254f06f']::uuid[];
  v_norma uuid;
  v_lixo_teste uuid;
  v_versao uuid;
  v_n bigint;
begin
  if v_fn is null then
    raise exception 'LIMPEZA CHECK FALHOU: private.legislacao_apagar_documentos(uuid[]) não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'LIMPEZA CHECK FALHOU: legislacao_apagar_documentos executável por anon/authenticated/service_role';
  end if;

  select count(*) into v_n from public.legislacao_documentos where id = any (v_lixo);
  if v_n > 0 then
    raise exception 'LIMPEZA CHECK FALHOU (CA-5): % documento(s)-lixo da lista ainda existem', v_n;
  end if;
  select count(*) into v_n from public.legislacao_documentos where tipo_norma is not null and status <> 'vigente';
  if v_n > 0 then
    raise exception 'LIMPEZA CHECK FALHOU (CA-5): % norma(s) do seed fora de vigente', v_n;
  end if;

  begin
    insert into public.legislacao_documentos (tipo_norma, numero, ano, titulo, status, url_canonica)
    values ('lei', '99999', 2099, 'Norma de teste (check 0042)', 'vigente', 'https://teste.invalid/norma-0042')
    returning id into v_norma;
    insert into public.legislacao_documentos (titulo, status, url_canonica)
    values ('GOV.BR (teste 0042)', 'vigente', 'https://teste.invalid/lixo-0042')
    returning id into v_lixo_teste;
    insert into public.legislacao_versoes (documento_id, numero_versao, storage_path, sha256)
    values (v_lixo_teste, 1, v_lixo_teste::text || '/x/original.pdf', 'sha-teste-0042')
    returning id into v_versao;
    update public.legislacao_documentos set versao_atual_id = v_versao where id = v_lixo_teste;
    insert into public.legislacao_alertas (documento_id, tipo_alerta, titulo)
    values (v_lixo_teste, 'nova_versao', 'teste 0042');

    -- recusa norma do seed (tipo_norma preenchido), sem apagar nada
    begin
      perform private.legislacao_apagar_documentos(array[v_lixo_teste, v_norma]);
      raise exception 'LIMPEZA CHECK FALHOU (CA-5): apagou lista que contém norma do seed';
    exception when others then
      if sqlerrm like 'LIMPEZA CHECK FALHOU%' then raise; end if;
    end;
    if not exists (select 1 from public.legislacao_documentos where id = v_lixo_teste) then
      raise exception 'LIMPEZA CHECK FALHOU (CA-5): a recusa não foi atômica (lixo apagado junto com a recusa)';
    end if;

    perform private.legislacao_apagar_documentos(array[v_lixo_teste]);
    if exists (select 1 from public.legislacao_documentos where id = v_lixo_teste)
       or exists (select 1 from public.legislacao_versoes where documento_id = v_lixo_teste)
       or exists (select 1 from public.legislacao_alertas where documento_id = v_lixo_teste) then
      raise exception 'LIMPEZA CHECK FALHOU (CA-5): documento-lixo, versão ou alerta sobrou';
    end if;
    if not exists (select 1 from public.legislacao_documentos where id = v_norma and status = 'vigente') then
      raise exception 'LIMPEZA CHECK FALHOU (CA-5): a norma de teste sumiu ou saiu de vigente';
    end if;

    -- idempotente: de novo, nada muda e não falha
    perform private.legislacao_apagar_documentos(array[v_lixo_teste]);

    raise exception 'desfaz_dados_de_teste';
  exception when raise_exception then
    if sqlerrm <> 'desfaz_dados_de_teste' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: catálogo de legislação limpo; normas do seed intactas';
end $$;
