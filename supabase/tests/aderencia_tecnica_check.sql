-- Checagem da migration 20261010100300_aderencia_tecnica.
-- Ontologia semeada, veredito com não comprovado, eliminatório bloqueia atende, requisito validado não se sobrescreve.

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['ontologia_atributos', 'licitacao_item_requisitos', 'catalogo_produto_atributos'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'CHECK FALHOU: RLS desligada em public.%', t;
    end if;
    if has_table_privilege('anon', ('public.' || t)::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: anon lê public.%', t;
    end if;
    if not has_table_privilege('authenticated', ('public.' || t)::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: authenticated sem select em public.%', t;
    end if;
    if has_table_privilege('authenticated', ('public.' || t)::regclass, 'INSERT') then
      raise exception 'CHECK FALHOU: authenticated escreve em public.%', t;
    end if;
  end loop;

  if (select count(*) from public.ontologia_atributos where no_taxonomia = 'esteira_eletrica') < 6 then
    raise exception 'CHECK FALHOU: ontologia da esteira incompleta';
  end if;
  if (select count(*) from public.ontologia_atributos where no_taxonomia = 'piso_emborrachado') < 6 then
    raise exception 'CHECK FALHOU: ontologia do piso incompleta';
  end if;

  if public.classificar_aderencia(3, 0, 1, 0, 0, 0, array['capacidade'], '{}', array['capacidade']) <> 'nao_atende' then
    raise exception 'CHECK FALHOU: eliminatório não derrubou atende';
  end if;
  if public.classificar_aderencia(3, 0, 0, 1, 0, 0, '{}', array['certificacao'], array['certificacao']) <> 'nao_comprovado' then
    raise exception 'CHECK FALHOU: lacuna eliminatória virou outra coisa que não comprovado';
  end if;
  if public.classificar_aderencia(2, 0, 1, 0, 0, 0, array['area'], '{}', '{}') <> 'parcial' then
    raise exception 'CHECK FALHOU: falha não eliminatória não ficou parcial';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.classificar_aderencia(int,int,int,int,int,int,text[],text[],text[])', 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa classificar_aderencia', r;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'licitacao_item_requisitos_nao_sobrescreve'
       and tgrelid = 'public.licitacao_item_requisitos'::regclass
  ) then
    raise exception 'CHECK FALHOU: gatilho de requisito validado ausente';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'catalogo_de_para_aderencia_check'
       and pg_get_constraintdef(oid) like '%nao_comprovado%'
  ) then
    raise exception 'CHECK FALHOU: aderencia sem nao_comprovado';
  end if;

  raise notice 'SUCESSO: aderencia tecnica';
end $$;
