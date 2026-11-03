-- LicitaGym: "academia ao ar livre" deixa de classificar escopo (escopo_termos id 50)
--
-- Contexto (03/10/2026, issue 160, decisão do Marcelo): o catálogo de palavras vem da taxonomia
-- CATMAT (nome oficial do PDM, catmat_pdm_palavras e taxonomia_no_pdm). Isso já basta. Não inventar
-- catálogo paralelo de sinônimos: o que se registra à parte muitas vezes não aparece no texto oficial,
-- e o que está no CATMAT não se acha por uma frase inventada.
--
-- O #112 já trata "academia ao ar livre" como falso positivo no coletor (só entra pelo piso). O padrão
-- de escopo_termos id 50 / prioridade 500 continuou ativo e ainda casa a frase:
--   academia (ao ar livre|de ginastica|da saude)
-- Esta migration só retira o ramo inventado "ao ar livre". Não cria padrão novo. "academia de ginástica"
-- e "academia da saúde" permanecem neste registro já versionado.
--
-- Dry-run em produção (SELECT, 03/10/2026), itens cuja descrição normalizada casa "academia ao ar livre":
--   47 itens; 41 também casam outro termo ativo de núcleo/adjacente e continuam no escopo por esse outro
--   termo; 6 casam só este padrão e saem no próximo refresh de mv_escopo_demanda (job 7). São aparelho
--   de academia ao ar livre / ATI (simulador de caminhada, cavalgada, alongador, placa de academia ao ar
--   livre), não piso. Nenhum edital em contratacoes_editais tinha a frase. A MV lê fn_escopo_item na hora
--   do refresh; esta migration não dá REFRESH.
--
-- Quem lê: fn_escopo_item / fn_escopo_match_atualizar (service_role) e o Dashboard (SELECT já concedido).
-- Sem GRANT novo. Idempotente: o UPDATE só casa o padrão antigo; a checagem exige o padrão novo no id 50.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '30s';

update public.escopo_termos
   set padrao = 'academia (de ginastica|da saude)'
 where id = 50
   and prioridade = 500
   and padrao = 'academia (ao ar livre|de ginastica|da saude)';

comment on table public.escopo_termos is
  'Termos do match de itens com o escopo LicitaGym (musculação/academia, material esportivo, piso emborrachado; adjacente = grama sintética/granulado). Alterar só por migration. Catálogo de palavras novo não entra aqui: a origem é a taxonomia CATMAT (PDM oficial, catmat_pdm_palavras, taxonomia_no_pdm). Termo inventado não substitui o nome oficial.';

do $$
begin
  if not exists (
    select 1
      from public.escopo_termos
     where id = 50
       and prioridade = 500
       and nivel = 'nucleo'
       and familia = 'musculacao_academia'
       and ativo
       and padrao = 'academia (de ginastica|da saude)'
  ) then
    raise exception 'escopo_termos id 50 não ficou sem o ramo "academia ao ar livre"';
  end if;
end $$;

commit;
