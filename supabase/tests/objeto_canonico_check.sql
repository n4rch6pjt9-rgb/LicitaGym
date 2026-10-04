-- Checagem da migration 20261004140000_objeto_canonico.
--   (a) ACL/RLS do catálogo e das funções; colunas novas na view das oportunidades.
--   (b) Classificação de objetos reais (textos tirados de produção em 04/10/2026) e do selo de registro de preço.
--   (c) Gatilho: insert classifica, update do objeto reclassifica (num sub-bloco desfeito ao fim).
-- Falha com RAISE EXCEPTION 'CHECK FALHOU: ...'; sucesso termina com NOTICE 'SUCESSO: ...'.

do $$
declare
  r   text;
  p   text;
  f   text;
  v_c record;
begin
  -- (a) ACL e RLS
  if not (select relrowsecurity from pg_class where oid = 'public.objeto_categorias'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em objeto_categorias';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.objeto_categorias'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em objeto_categorias', r, p;
      end if;
    end loop;
    foreach f in array array['public.objeto_normalizar(text)', 'public.objeto_classificar(text)', 'public.objeto_reclassificar()'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % executa %', r, f;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'licitacoes_externas_prioridade_efetiva'
                    and column_name = 'objeto_categoria')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'licitacoes_externas_prioridade_efetiva'
                       and column_name = 'objeto_registro_preco') then
    raise exception 'CHECK FALHOU: view das oportunidades sem as colunas do objeto canônico';
  end if;
  if has_table_privilege('anon', 'public.licitacoes_externas_prioridade_efetiva'::regclass, 'SELECT')
     or has_table_privilege('authenticated', 'public.licitacoes_externas_prioridade_efetiva'::regclass, 'SELECT')
     or not has_table_privilege('service_role', 'public.licitacoes_externas_prioridade_efetiva'::regclass, 'SELECT') then
    raise exception 'CHECK FALHOU: ACL da view das oportunidades mudou ao recriá-la';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.licitacoes_externas_objeto_canonico_trg()'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa a função do gatilho', r;
    end if;
  end loop;
  if (select count(*) from public.objeto_categorias where ativo) < 11 then
    raise exception 'CHECK FALHOU: catálogo canônico sem as 11 categorias semeadas';
  end if;

  -- (b) Classificação
  for v_c in
    select * from (values
      ('AQUISIÇÃO DE APARELHOS DE MUSCULAÇÃO, PARA ACADEMIA PÚBLICA GINÁSIO MUNICIPAL', 'equipamento_musculacao'),
      ('REGISTRO DE PREÇOS PARA FUTURA E EVENTUAL AQUISIÇÃO DE MATERIAIS ESPORTIVOS DIVERSOS', 'material_esportivo'),
      ('AQUISICAO DE MATERIAL ESPORTIVO PARA OS DIVERSOS DEPARTAMENTOS ADMINISTRATIVOS', 'material_esportivo'),
      ('AQUISIÇÃO DE MATERIAIS PERMANENTES DESTINADOS À ESTRUTURAÇÃO DO NOVO ANEXO', 'equipamento_permanente'),
      ('CHAMAMENTO PÚBLICO PARA CREDENCIAMENTO DE PESSOAS JURÍDICAS', 'credenciamento'),
      ('PRESTAÇÃO DE SERVIÇOS DE TAPEÇARIA DESTINADOS À REFORMA DOS ESTOFADOS DOS APARELHOS DE MUSCULAÇÃO', 'servico_manutencao'),
      ('AQUISIÇÃO DE EQUIPAMENTOS DE MUSCULAÇÃO PARA REFORMA DA ACADEMIA.', 'equipamento_musculacao'),
      ('CONTRATAÇÃO, EM REGIME DE EMPREITADA POR PREÇO GLOBAL, DE SERVIÇOS PARA CONSTRUÇÃO DO NOVO PRÉDIO', 'reforma_geral'),
      ('piso emborrachado', 'piso_esportivo'),
      ('AQUISIÇÃO DE BRINQUEDOS PARA A UAEB', 'playground'),
      ('AQUISIÇÃO DE EQUIPAMENTOS DE GINÁSTICA AO AR LIVRE PARA A PRAÇA', 'academia_ar_livre'),
      ('Registro de preço para Academia da Terceira Idade (ATI)', 'academia_ar_livre'),
      ('AQUISIÇÃO DE MATERIAIS DE CONSUMO DE FISIOTERAPIA E REABILITAÇÃO FÍSICA', 'equipamento_fisioterapia'),
      ('AQUISIÇÃO DE EQUIPAMENTOS DE MUSCULAÇÃO E FISIOTERAPIA', 'equipamento_musculacao'),
      ('AQUISIÇÃO DE MOBILIÁRIOS CORPORATIVOS, CADEIRAS', 'aquisicao_material'),
      ('APORTE FINANCEIRO PARA CUSTEIO DE CAMPEONATO', 'outros'),
      (null, 'outros')
    ) as t (objeto, esperado)
  loop
    if public.objeto_classificar(v_c.objeto) <> v_c.esperado then
      raise exception 'CHECK FALHOU: "%" classificado como %, esperado %', v_c.objeto, public.objeto_classificar(v_c.objeto), v_c.esperado;
    end if;
  end loop;
  if public.objeto_normalizar('Registro de Preço para futura aquisição') !~ 'REGISTRO DE PRECO' then
    raise exception 'CHECK FALHOU: normalização sem acento/maiúsculas';
  end if;

  raise notice 'SUCESSO: objeto_canonico ACL, view e classificação ok';
end
$$;

-- (c) Gatilho, desfeito ao final
do $$
declare
  v_id bigint;
  v_cat text;
  v_srp boolean;
begin
  begin
    insert into public.licitacoes_externas (fonte, objeto)
    values ('pncp', 'Registro de Preço para aquisição de esteira ergométrica') returning id into v_id;
    select objeto_categoria, objeto_registro_preco into v_cat, v_srp from public.licitacoes_externas where id = v_id;
    if v_cat <> 'equipamento_musculacao' or not v_srp then
      raise exception 'CHECK FALHOU: insert classificou % / selo %', v_cat, v_srp;
    end if;
    update public.licitacoes_externas set objeto = 'Credenciamento de clínicas' where id = v_id;
    select objeto_categoria, objeto_registro_preco into v_cat, v_srp from public.licitacoes_externas where id = v_id;
    if v_cat <> 'credenciamento' or v_srp then
      raise exception 'CHECK FALHOU: update não reclassificou (% / %)', v_cat, v_srp;
    end if;
    -- o papel dos coletores (service_role) grava com o gatilho ativo
    set local role service_role;
    insert into public.licitacoes_externas (fonte, objeto) values ('pncp', 'Aquisição de playground') returning id into v_id;
    if (select objeto_categoria from public.licitacoes_externas where id = v_id) <> 'playground' then
      raise exception 'CHECK FALHOU: gatilho como service_role';
    end if;
    reset role;
    -- regex inválido é recusado na gravação do catálogo
    v_cat := 'aceitou';
    begin
      insert into public.objeto_categorias (slug, nome, ordem, padrao) values ('check_regex', 'CHECK REGEX', 999, '(AB');
    exception when check_violation or invalid_regular_expression then v_cat := 'recusou';
    end;
    if v_cat <> 'recusou' then
      raise exception 'CHECK FALHOU: catálogo aceitou regex inválido';
    end if;
    raise exception 'DESFAZER_CHECK_OBJETO';
  exception when raise_exception then
    if sqlerrm <> 'DESFAZER_CHECK_OBJETO' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: objeto_canonico gatilho ok (gravações do teste desfeitas)';
end
$$;
