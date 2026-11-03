-- LicitaGym: taxonomia de pisos v0.2 — grama sintética, borracha granulada materializada e padrões de granulado/grama
--
-- Contexto (levantamento Sistema S de 30/09/2026):
--   * Grama sintética, piso SBR/EPDM e granulado de borracha fazem parte do escopo (linha Playfit), mas:
--     - o nó borracha_granulada apontava para o PDM 9461, que não existia em catmat_pdms (nó inerte);
--     - grama sintética (PDM 18481, classe 7220) tinha padrão de texto, mas nenhum nó na taxonomia;
--     - não havia padrão de texto para granulado avulso (infill de grama, paisagismo) no PDM 9461.
--   * PDM 9461 = BORRACHA GRANULADA, grupo 93 (MATERIAIS MANUFATURADOS, NÃO METÁLICOS), classe 9320 (ARTIGOS DE
--     BORRACHA), status ativo — conferido na API Dados Abertos Compras (3_consultarPdmMaterial?codigoPdm=9461).
--
-- Esta migration:
--   1) materializa por curadoria o grupo 93, a classe 9320 e SÓ o PDM 9461 (payload_hash 'curadoria:…'). A classe
--      9320 continua FORA da política de escopo (TRANSITIONAL_FITNESS_SCOPE): hoje o sync-compras-catmat recusa a
--      classe (assertCatmatClasseInScope), então nenhum sync toca nessas linhas. Só um sync da classe 9320, se ela
--      entrar no escopo, atualizaria as linhas (o payload_hash 'curadoria:…' nunca bate com o hash do sync).
--      Nenhum código apaga linhas de catmat_pdms. Sync de órgãos, PCA e árvore de escopo não mudam. O PDM passa a
--      valer no casamento por texto/taxonomia (licitacoes_ids_por_catmat) e pode receber padrões.
--      data_atualizacao_origem em UTC (+00), como o sync grava o dataHoraAtualizacao da API;
--   2) taxonomia_no_pdm: carga vigente da taxonomia de pisos 'pisos-0.2' (7 nós IN, 13 pares), com o nó novo
--      grama_sintetica -> 18481. A carga acompanha services/coletor-externo/coletor/data/taxonomia-pisos-v0.2.json
--      (teste tests/supabase/taxonomia_pisos_test.ts);
--   3) padrões de inclusão para 9461 (granulado/raspa/infill de borracha) e 18481 (gramados, grama artificial, relva),
--      só onde o PDM existe e sem sobrescrever padrões editados pelo admin (on conflict do nothing).
--
-- Idempotente. Leitura authenticated; escrita só service_role (ACL das tabelas não muda).

begin;

-- 1) PDM 9461 por curadoria ---------------------------------------------------------------------------------------------
insert into public.catmat_grupos (codigo_grupo, nome, status, payload_hash)
values (93, 'MATERIAIS MANUFATURADOS, NÃO METÁLICOS', true, 'curadoria:' || md5('93|MATERIAIS MANUFATURADOS, NÃO METÁLICOS'))
on conflict (codigo_grupo) do nothing;

insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, status, payload_hash)
values (93, 9320, 'ARTIGOS DE BORRACHA', true, 'curadoria:' || md5('93|9320|ARTIGOS DE BORRACHA'))
on conflict (codigo_grupo, codigo_classe) do nothing;

insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, status, data_atualizacao_origem, payload_hash)
values (9461, 93, 9320, 'BORRACHA GRANULADA', true, '2021-10-16T09:21:41.961529+00',
        'curadoria:' || md5('93|9320|9461|BORRACHA GRANULADA'))
on conflict (codigo_pdm) do nothing;

-- 2) Taxonomia de pisos -> PDM (carga vigente pisos-0.2) ----------------------------------------------------------------
insert into public.taxonomia_no_pdm (no_taxonomia, codigo_pdm, versao_dicionario) values
  ('piso_epdm', 10779, 'pisos-0.2'),
  ('piso_epdm', 757, 'pisos-0.2'),
  ('piso_borracha_reciclada_sbr', 10779, 'pisos-0.2'),
  ('piso_borracha_reciclada_sbr', 757, 'pisos-0.2'),
  ('placa_emborrachada', 10779, 'pisos-0.2'),
  ('placa_emborrachada', 757, 'pisos-0.2'),
  ('placa_emborrachada', 12550, 'pisos-0.2'),
  ('grama_sintetica', 18481, 'pisos-0.2'),
  ('borracha_granulada', 9461, 'pisos-0.2'),
  ('tapete_borracha', 12550, 'pisos-0.2'),
  ('tapete_borracha', 757, 'pisos-0.2'),
  ('piso_emborrachado', 10779, 'pisos-0.2'),
  ('piso_emborrachado', 757, 'pisos-0.2')
on conflict (no_taxonomia, codigo_pdm) do update set versao_dicionario = excluded.versao_dicionario;

-- 3) Padrões (regex ARE sobre lg_normalizar) --------------------------------------------------------------------------
insert into public.catmat_pdm_palavras (codigo_pdm, padrao)
select v.codigo_pdm, v.padrao
  from (values
  (9461, '\mborracha (sbr |reciclad[oa] |de pneus? )?(granul|triturad|moid)'),
  (9461, '\m(raspa|po|farelo) de borracha'),
  (9461, 'granulad[oa]s? (de |em )?(borracha|pneus?)'),
  (9461, 'granulos? de (borracha|pneus?)'),
  (9461, 'mulch de borracha'),
  (9461, '(infill|preenchimento)[^.]{0,30}(borracha|\msbr\M|\mepdm\M)'),
  (18481, '(grama|gramados?|relva) (sintetic|artificia)')
       ) as v(codigo_pdm, padrao)
 where exists (select 1 from public.catmat_pdms p where p.codigo_pdm = v.codigo_pdm)
on conflict (codigo_pdm, padrao) do nothing;

commit;
