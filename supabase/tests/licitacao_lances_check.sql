-- Spec 0061, K-12 e CA-12: public.licitacao_lances (histórico da disputa por item, coletor Paradigma).
-- Dados fictícios, tudo em begin/rollback. Aborta se licitacoes_externas tiver mais de 100 linhas.
--   1. tabela existe, RLS ligada, sem privilégio para anon e authenticated, service_role grava e lê
--   2. o mesmo lance (licitação, item, id do lance) não duplica: o upsert do coletor usa essa chave
--   3. apagar a licitação apaga os lances (on delete cascade)

begin;

do $$
declare
  v_qtd int;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;
end $$;

insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
values ('fieb', 'FIEB', 'paradigma', 'https://compras.fieb.org.br/portal', 'automatico')
on conflict (slug) do nothing;

do $$
declare
  v_lic bigint;
  v_priv text;
  v_ok boolean;
  v_qtd int;
begin
  if to_regclass('public.licitacao_lances') is null then
    raise exception 'CHECK FALHOU: public.licitacao_lances não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.licitacao_lances'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em licitacao_lances';
  end if;
  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('anon', 'public.licitacao_lances', v_priv)
       or has_table_privilege('authenticated', 'public.licitacao_lances', v_priv) then
      raise exception 'ACL CHECK FALHOU: licitacao_lances com % para anon/authenticated', v_priv;
    end if;
  end loop;
  if not (has_table_privilege('service_role', 'public.licitacao_lances', 'INSERT')
          and has_table_privilege('service_role', 'public.licitacao_lances', 'SELECT')
          and has_table_privilege('service_role', 'public.licitacao_lances', 'UPDATE')) then
    raise exception 'ACL CHECK FALHOU: service_role sem INSERT/SELECT/UPDATE em licitacao_lances';
  end if;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo)
  values ('fieb', 19, 938191, 'fieb-938191') returning id into v_lic;

  insert into public.licitacao_lances (licitacao_id, numero_item, id_lance_externo, data_lance, valor, moeda,
                                       fornecedor_nome, fornecedor_cnpj, posicao, vencedor, raw)
  values (v_lic, 1, 1191050, '2023-08-25T18:03:39Z', 38.79, 'R$', 'FORNECEDOR TESTE 1 LTDA', '11222334000162', 1, true, '{}'),
         (v_lic, 1, 1191047, '2023-08-25T18:02:21Z', 38.80, 'R$', 'FORNECEDOR TESTE 2 LTDA', null, 2, false, '{}'),
         (v_lic, 1, 1189287, '2023-08-23T14:42:57Z', 120.00, 'R$', 'FORNECEDOR TESTE 3 LTDA', null, null, false, '{}');

  -- 2. mesma chave: o upsert atualiza, não duplica
  insert into public.licitacao_lances (licitacao_id, numero_item, id_lance_externo, valor, raw)
  values (v_lic, 1, 1191050, 38.79, '{}')
  on conflict (licitacao_id, numero_item, id_lance_externo) do update set valor = excluded.valor;
  select count(*) into v_qtd from public.licitacao_lances where licitacao_id = v_lic;
  if v_qtd <> 3 then
    raise exception 'CHECK FALHOU: esperado 3 lances depois do upsert repetido, veio %', v_qtd;
  end if;

  v_ok := false;
  begin
    insert into public.licitacao_lances (licitacao_id, numero_item, id_lance_externo, raw)
    values (v_lic, 1, 1191050, '{}');
  exception when unique_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FALHOU: lance repetido entrou sem conflito'; end if;

  -- 3. cascade
  delete from public.licitacoes_externas where id = v_lic;
  select count(*) into v_qtd from public.licitacao_lances where licitacao_id = v_lic;
  if v_qtd <> 0 then
    raise exception 'CHECK FALHOU: lances sobraram depois de apagar a licitação (%)', v_qtd;
  end if;

  raise notice 'SUCESSO: licitacao_lances_check (RLS, ACL, chave do lance e cascade)';
end $$;

rollback;
