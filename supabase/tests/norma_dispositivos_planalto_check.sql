-- Checagem da migration 20261010100200_norma_dispositivos_planalto.
-- Arts. 11, 41 e 42 existem e estão conferidos. Art. 164 (trecho literal) está conferido.
-- Art. 54 permanece não conferido: o recorte gravado não é substring do Planalto.

do $$
begin
  if (select count(*) from public.norma_dispositivos
       where norma = 'LEI_14133_2021' and artigo in (11, 41, 42) and conferido_oficial) <> 3 then
    raise exception 'CHECK FALHOU: arts. 11, 41 ou 42 ausentes ou não conferidos';
  end if;
  if not (select conferido_oficial from public.norma_dispositivos where norma = 'LEI_14133_2021' and artigo = 164) then
    raise exception 'CHECK FALHOU: art. 164 deveria estar conferido';
  end if;
  if (select conferido_oficial from public.norma_dispositivos where norma = 'LEI_14133_2021' and artigo = 54) then
    raise exception 'CHECK FALHOU: art. 54 foi marcado conferido sem o trecho bater com o Planalto';
  end if;
  raise notice 'SUCESSO: norma dispositivos planalto';
end $$;
