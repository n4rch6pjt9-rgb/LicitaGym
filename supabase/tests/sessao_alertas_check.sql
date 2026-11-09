-- Spec 0039, etapa 1b (CA-7f): public.sessao_alertas, private.sessao_alertas_destinos(bigint[]) e a retenção.
--   1. tabela existe, RLS ligada, sem policy; anon/authenticated sem nenhum privilégio
--   2. service_role: select e insert; update só em lido_em e lido_por; sem delete
--   3. único (tenant_id, chave_mensagem); tipo só convocacao_anexos | etapa_fechada (CHECK de verdade); FKs com cascade
--   4. sessao_alertas_destinos: security invoker, search_path fixo, EXECUTE só service_role, mesma regra de
--      sessao_chat_alvos (tenant ativo, fora de perdida/descartada)
--   5. sessao_mensagens_retencao anonimiza os alertas (razão social e CNPJ) junto com o texto
-- Só leitura (o insert do item 3 falha no CHECK e é desfeito). Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_fn regprocedure := to_regprocedure('private.sessao_alertas_destinos(bigint[])');
  v_ret regprocedure := to_regprocedure('private.sessao_mensagens_retencao()');
  v_priv text;
  v_def text;
begin
  if to_regclass('public.sessao_alertas') is null then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: public.sessao_alertas não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.sessao_alertas'::regclass) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: RLS desligado';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessao_alertas') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: há policy (leitura só por Edge Function)';
  end if;
  foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('anon', 'public.sessao_alertas', v_priv)
       or has_table_privilege('authenticated', 'public.sessao_alertas', v_priv) then
      raise exception 'SESSAO_ALERTAS CHECK FALHOU: anon/authenticated tem % em sessao_alertas', v_priv;
    end if;
  end loop;

  if not has_table_privilege('service_role', 'public.sessao_alertas', 'SELECT')
     or not has_table_privilege('service_role', 'public.sessao_alertas', 'INSERT') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role sem SELECT/INSERT';
  end if;
  foreach v_priv in array array['DELETE','TRUNCATE','UPDATE'] loop
    if has_table_privilege('service_role', 'public.sessao_alertas', v_priv) then
      raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role tem % na tabela inteira', v_priv;
    end if;
  end loop;
  if not has_column_privilege('service_role', 'public.sessao_alertas', 'lido_em', 'UPDATE')
     or not has_column_privilege('service_role', 'public.sessao_alertas', 'lido_por', 'UPDATE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role não marca lido (UPDATE em lido_em/lido_por)';
  end if;
  if has_column_privilege('service_role', 'public.sessao_alertas', 'tenant_id', 'UPDATE')
     or has_column_privilege('service_role', 'public.sessao_alertas', 'prazo', 'UPDATE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role atualiza coluna além de lido_em/lido_por';
  end if;

  if not exists (
    select 1 from pg_index i
     where i.indrelid = 'public.sessao_alertas'::regclass and i.indisunique
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['tenant_id', 'chave_mensagem']
  ) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: falta único (tenant_id, chave_mensagem)';
  end if;
  -- CHECK roda antes das FKs: sem a constraint de tipo, o insert falha por FK e a exceção sobe (check falha).
  begin
    insert into public.sessao_alertas (tenant_id, licitacao_id, chave_mensagem, tipo, mensagem_em)
    values (-1, -1, gen_random_uuid(), 'outro_tipo', now());
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: aceitou tipo fora da lista';
  exception when check_violation then null;
  end;
  if (select count(*) from pg_constraint
       where conrelid = 'public.sessao_alertas'::regclass and contype = 'f' and confdeltype = 'c'
         and confrelid in ('public.tenants'::regclass, 'public.licitacoes_externas'::regclass,
                           'public.sessao_mensagens'::regclass)) <> 3 then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: FKs para tenants, licitacoes_externas e sessao_mensagens sem cascade';
  end if;

  if v_fn is null then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: private.sessao_alertas_destinos(bigint[]) não existe';
  end if;
  if to_regprocedure('private.sessao_alertas_destinos(bigint)') is not null then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: assinatura antiga sessao_alertas_destinos(bigint) ainda existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: anon/authenticated executa sessao_alertas_destinos';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role não executa sessao_alertas_destinos';
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn and not prosecdef
                  and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: sessao_alertas_destinos precisa ser security invoker com search_path fixo';
  end if;
  v_def := pg_get_functiondef(v_fn);
  if v_def not like '%t.ativo%' or v_def not like '%''perdida'', ''descartada''%' then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: destinos fora da regra de sessao_chat_alvos (ativo, perdida/descartada)';
  end if;

  if v_ret is null or pg_get_functiondef(v_ret) not like '%update public.sessao_alertas%fornecedor_razao_social = null%' then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: a retenção não anonimiza os alertas';
  end if;
  if has_function_privilege('service_role', v_ret, 'EXECUTE') or has_function_privilege('authenticated', v_ret, 'EXECUTE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: sessao_mensagens_retencao executável fora do dono';
  end if;

  raise notice 'SUCESSO: sessao_alertas, destinos e retenção conferidos';
end $$;
