-- Checagem da migration 20261109230000_fontes_externas_paradigmabs_registro.
-- Os portais paradigmabs que o coletor coleta todo dia aparecem como 'automatico' no cadastro. Num banco sem as
-- linhas (stub), a checagem passa.

do $$
declare
  n int;
begin
  select count(*) into n
    from public.fontes_externas
   where slug in ('sescsp', 'sesc_senac_rs', 'sescdn', 'sescrj', 'sescba')
     and modo_coleta is distinct from 'automatico';
  if n > 0 then
    raise exception 'CHECK FALHOU: % fonte(s) paradigmabs coletada(s) pelo mural ainda fora de automatico', n;
  end if;

  select count(*) into n
    from public.fontes_externas
   where (slug in ('sescsp', 'sesc_senac_rs', 'sescrj', 'sescba') and robots_permite is distinct from false)
      or (slug = 'sescdn' and robots_permite is not null);
  if n > 0 then
    raise exception 'CHECK FALHOU: % fonte(s) paradigmabs com robots_permite incoerente com o robots.txt do host', n;
  end if;

  raise notice 'SUCESSO: cadastro das fontes paradigmabs coerente com a coleta';
end $$;
