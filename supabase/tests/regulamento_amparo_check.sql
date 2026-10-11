-- Checagem da migration 20261011110100_regulamento_amparo_legal (spec 0020).
--   CA-1 regra de regulamento_do_amparo (mesmos casos de services/coletor-externo/tests/test_pncp_regulamento.py);
--   CA-2 gatilho: deriva com amparo_legal, não mexe sem ele (RCA do Sistema S fica);
--   CA-3 constraint ampliada; ACL da função nova.
-- As linhas de teste são desfeitas por uma exceção proposital no fim.
-- Falha com RAISE EXCEPTION 'CHECK FALHOU: ...'; sucesso termina com NOTICE 'SUCESSO: ...'.

do $$
declare
  r      record;
  v_id   bigint;
  v_ok   boolean;
  v_papel text;
begin
  -- CA-1
  for r in select * from (values
      ('Lei 14.133/2021, Art. 28, I', 'LEI_14133'),
      ('Lei 14.133/2021, Art. 75, II', 'LEI_14133'),
      ('Lei 14.981/2024, Art. 2º', 'LEI_14981'),
      ('Lei 13.303/2016, Art. 29, II', 'LEI_13303'),
      ('MP 1.221/2024, Art. 2º', 'OUTRO'),
      ('Lei 114.133/2099', 'OUTRO'),
      ('', null),
      ('   ', null),
      (null, null)) as t(nome, esperado)
  loop
    if public.regulamento_do_amparo(r.nome) is distinct from r.esperado then
      raise exception 'CHECK FALHOU: regulamento_do_amparo(%) = %, esperado %',
        r.nome, public.regulamento_do_amparo(r.nome), r.esperado;
    end if;
  end loop;

  -- ACL: só service_role executa a função nova
  foreach v_papel in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_papel, 'public.regulamento_do_amparo(text)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa regulamento_do_amparo', v_papel;
    end if;
  end loop;

  begin
    -- CA-2: sem amparo_legal, o regulamento gravado fica (Sistema S)
    insert into public.licitacoes_externas (fonte, regulamento) values ('sestsenat', 'RCA') returning id into v_id;
    update public.licitacoes_externas set objeto = 'check' where id = v_id;
    if (select regulamento from public.licitacoes_externas where id = v_id) is distinct from 'RCA' then
      raise exception 'CHECK FALHOU: gatilho mexeu no regulamento sem amparo_legal';
    end if;

    -- CA-2: amparo_legal no insert e no update deriva o regulamento
    insert into public.licitacoes_externas (fonte, amparo_legal)
      values ('pncp', '{"codigo": 1, "nome": "Lei 14.133/2021, Art. 28, I"}') returning id into v_id;
    if (select regulamento from public.licitacoes_externas where id = v_id) is distinct from 'LEI_14133' then
      raise exception 'CHECK FALHOU: insert com amparo_legal não derivou LEI_14133';
    end if;
    update public.licitacoes_externas
       set amparo_legal = '{"codigo": 99, "nome": "Lei 14.981/2024, Art. 2º"}' where id = v_id;
    if (select regulamento from public.licitacoes_externas where id = v_id) is distinct from 'LEI_14981' then
      raise exception 'CHECK FALHOU: update de amparo_legal não derivou LEI_14981';
    end if;
    -- amparo sem nome não apaga o regulamento
    update public.licitacoes_externas set amparo_legal = '{"codigo": 1}' where id = v_id;
    if (select regulamento from public.licitacoes_externas where id = v_id) is distinct from 'LEI_14981' then
      raise exception 'CHECK FALHOU: amparo sem nome apagou o regulamento';
    end if;

    -- CA-3: constraint aceita os valores novos e recusa valor fora da lista
    update public.licitacoes_externas set regulamento = 'LEI_13303' where id = v_id;
    v_ok := false;
    begin
      update public.licitacoes_externas set regulamento = 'LEI_8666' where id = v_id;
    exception when check_violation then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: constraint aceitou regulamento fora da lista';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: regulamento_amparo regra, gatilho, constraint e ACL ok (linhas desfeitas)';
end
$$;
