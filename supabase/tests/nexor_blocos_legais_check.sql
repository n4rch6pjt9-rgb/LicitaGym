-- Checagem da migration 20261108230000_nexor_blocos_legais (Nexor Fase 0, PR 3b).
--   RLS ligada, sem policy; anon, authenticated e public sem nenhum privilégio; service_role só lê;
--   110 linhas (22 blocos × 5 procedimentos) do regime lei_14133; detalhe só no pregão; prazo coerente;
--   impugnação no pregão = 3 du antes da abertura (art. 164); constraint de prazo recusa quantidade sem unidade.

do $$
declare
  r text;
  n integer;
  b record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.blocos_legais'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em public.blocos_legais';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'blocos_legais') then
    raise exception 'CHECK FALHOU: public.blocos_legais tem policy (esperado: nenhuma, leitura só via service_role)';
  end if;
  foreach r in array array['anon', 'authenticated', 'public'] loop
    if has_table_privilege(r, 'public.blocos_legais', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') then
      raise exception 'CHECK FALHOU: % tem privilégio em public.blocos_legais', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.blocos_legais', 'SELECT') then
    raise exception 'CHECK FALHOU: service_role não lê public.blocos_legais';
  end if;
  if has_table_privilege('service_role', 'public.blocos_legais', 'INSERT,UPDATE,DELETE,TRUNCATE,MAINTAIN') then
    raise exception 'CHECK FALHOU: service_role escreve em public.blocos_legais (escrita só por migration)';
  end if;

  select count(*) into n from public.blocos_legais where regime_id = 'lei_14133';
  if n <> 110 then raise exception 'CHECK FALHOU: esperadas 110 linhas da lei_14133, achei %', n; end if;

  select count(distinct bloco) into n from public.blocos_legais;
  if n <> 22 then raise exception 'CHECK FALHOU: esperados 22 blocos, achei %', n; end if;

  select count(*) into n from public.blocos_legais
   where procedimento = 'pregao' and (condicao is null or base_legal is null or parte_obrigada is null);
  if n <> 0 then raise exception 'CHECK FALHOU: % blocos do pregão sem detalhe', n; end if;

  select count(*) into n from public.blocos_legais
   where procedimento <> 'pregao'
     and (condicao is not null or base_legal is not null or parte_obrigada is not null or temas_rag is not null
          or variacoes is not null);
  if n <> 0 then raise exception 'CHECK FALHOU: % linhas fora do pregão com detalhe (não pesquisado)', n; end if;

  select * into b from public.blocos_legais
   where regime_id = 'lei_14133' and procedimento = 'pregao' and bloco = 'impugnacao_esclarecimento';
  if b.status <> 'obrigatorio' or b.prazo_quantidade <> 3 or b.prazo_unidade <> 'du' or b.prazo_sentido <> 'antes'
     or b.prazo_ancora <> 'abertura_sessao' or b.base_legal !~ 'art\. 164' then
    raise exception 'CHECK FALHOU: impugnação no pregão diferente de 3 du antes da abertura (art. 164)';
  end if;

  if exists (select 1 from public.blocos_legais where status = 'nao_aplica' and prazo_quantidade is not null) then
    raise exception 'CHECK FALHOU: bloco N/A com prazo';
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.blocos_legais'::regclass and conname = 'blocos_legais_prazo_coerente') then
    raise exception 'CHECK FALHOU: constraint blocos_legais_prazo_coerente ausente';
  end if;
  begin
    insert into public.blocos_legais (regime_id, procedimento, bloco, ordem, status, prazo_quantidade, confianca)
    values ('lei_14133', 'pregao', 'teste_check', 99, 'obrigatorio', 3, 'alta');
    raise exception 'CHECK FALHOU: aceitou prazo sem unidade, sentido e âncora';
  exception when check_violation then
    null;
  end;

  raise notice 'SUCESSO: blocos_legais (RLS, ACL, 110 linhas, detalhe só no pregão, prazo coerente)';
end $$;
