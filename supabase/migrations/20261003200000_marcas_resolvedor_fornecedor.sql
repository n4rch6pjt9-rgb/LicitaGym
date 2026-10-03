-- LicitaGym: resolvedor de marca (versionado e curável) + marca_1..3 por fornecedor.
--
-- Contexto (02/10/2026, só leitura em produção ifaiagegyicjzlpskafh):
--   * precos_praticados_itens (Pesquisa de Preço do Compras.gov) tem 25 464 linhas de 40 PDMs. O campo `marca`
--     é a marca declarada na proposta pelo licitante, vem 100% preenchido e é texto livre, sem limite de 20
--     caracteres (há valores com até 84). Na conferência manual de 02/10/2026 23:15 BRT, ~76% é marca real; o
--     restante é modelo (~4%), lixo ou ambíguo (produto, medida, placeholder como PRÓPRIA, S/M, SIMILAR,
--     CONFORME EDITAL...). Por isso o valor passa pelo resolvedor abaixo, em vez de ser usado cru.
--   * Estudo e amostra: MARCAS-COMPRASGOV.md, MARCAS-PROPOSTA.md e amostra-marca-manual.py (fora do repo).
--
-- O que cria (nada existe em produção com esses nomes; conferido em 03/10/2026):
--   1. private.marca_normalizar(text): maiúsculas, sem acento, sem LTDA, pontuação vira espaço, espaços colapsados,
--      frase repetida colapsada ("FUNDIBAN FUNDIBAN" -> "FUNDIBAN"). IMMUTABLE.
--   2. public.marca_aliases: valor normalizado (ou padrão) -> marca canônica, com tipo (marca, grafia,
--      modelo_marca, nao_marca), modo (exato, prefixo, regex), escopo opcional por CNPJ (PRÓPRIA de fabricante),
--      origem e texto da evidência e revisao_manual. Semente `marcas-v1` abaixo: só o que tem evidência na amostra
--      manual, na web (citada na coluna evidencia), nas listas do coletor (perfil_item.py, fabricantes_marcas.json)
--      ou nos próprios dados (mesmo CNPJ usando as duas grafias).
--      Curadoria: inserir/alterar linhas com revisao_manual = true. Reaplicar a semente NUNCA sobrescreve linha
--      com revisao_manual = true, e no resolvedor a linha manual vence em empate.
--   3. private.marca_resolver(marca_bruta, cnpj): o primeiro que casar vence, nesta ordem:
--      escopo do CNPJ > global; exato > prefixo (o mais longo) > regex; manual > semente.
--      Sem alias: vazio/1 caractere, código de modelo ou medida ("1130PC", "LLM014", "R55V5", "10KG", "2 KG", "8 0",
--      "75CM BOMBA", "COD MB") -> NULL. Começar com dígito não basta: com palavra de 5+ letras e sem medida
--      ("3 SECONDS FITNESS", "3G FITNESS", "D1FITNESS") é marca. Qualquer outro texto conta como a própria
--      string normalizada, com curada = false.
--      curada = "resolvida por alias" (tipo <> 'nao_marca'), venha o alias da semente ou da curadoria manual:
--      um alias da semente marcas-v1 (revisao_manual = false) também dá curada = true. Não significa "revisada
--      por pessoa"; para isso, ver marca_aliases.revisao_manual pelo alias_id.
--   4. Views (security_invoker, SELECT só para service_role):
--      v_marca_ocorrencias          1 linha por item vendido com a marca resolvida (PONTO DE EXTENSÃO das fontes)
--      v_fornecedor_marcas_ranking  CNPJ x marca: qtd_itens, valor_total, ultima_data, posicao (mín. 2 itens)
--      v_fornecedor_marcas          1 linha por CNPJ: marca_1..3 com qtd_itens, valor_total, ultima_data, curada
--      v_marca_aliases_pendentes    fila de curadoria: valores que contaram como marca bruta (sem alias)
--
-- Regras do ranking: só CNPJ de 14 dígitos (CPF fica em v_marca_ocorrencias com ni_tipo = 'cpf' e
-- entra_ranking = false), só linha com data_resultado (venda), mínimo de 2 itens por CNPJ x marca; ordem:
-- qtd_itens desc, valor_total desc, ultima_data desc, marca asc.
--
-- O que NÃO faz: não grava em fornecedores nem em precos_praticados_itens; não corrige as 380 linhas com
-- id_compra de 16 dígitos (UPDATE separado, decisão do Marcelo); não muda Edge Function nem grants de objetos
-- existentes; não altera os default privileges do schema (cada objeto novo recebe revoke explícito abaixo).
--
-- ACL: RLS ligado em marca_aliases sem policy; anon, authenticated e PUBLIC sem nenhum privilégio na tabela,
-- na sequence de identidade, nas 4 views e nas 2 funções (o default privileges do Supabase dá ALL/EXECUTE a
-- anon/authenticated/service_role em objeto novo: por isso o revoke explícito); service_role só com SELECT,
-- INSERT, UPDATE e DELETE na tabela (sem TRUNCATE/REFERENCES/TRIGGER/MAINTAIN), nada na sequence (id é
-- GENERATED ALWAYS AS IDENTITY: o INSERT usa a sequence sem checar privilégio nela), SELECT nas views e EXECUTE
-- nas funções.
--
-- Pré-condições (falham com mensagem clara antes de criar qualquer coisa): PostgreSQL 15+ (NULLS NOT DISTINCT e
-- security_invoker); service_role com USAGE em public e private e SELECT em precos_praticados_itens (as views são
-- security_invoker: quem consulta precisa dos privilégios nos objetos de origem). Se marca_aliases já existir em
-- outro formato, o CREATE TABLE IF NOT EXISTS não a altera: a migration confere colunas, tipos e constraints e
-- falha se divergir. No fim, confere EXECUTE de service_role nas funções e SELECT na tabela e nas views.
--
-- Verificação (só leitura): supabase/tests/marcas_resolvedor_acl_check.sql
-- Idempotente (pode rodar duas vezes). Merge na main aplica em produção.

begin;

-- 0) Pré-condições -----------------------------------------------------------------------------------------
-- NULLS NOT DISTINCT (unique de marca_aliases) e security_invoker (views) exigem PostgreSQL 15+.
do $pre$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'marcas_resolvedor: requer PostgreSQL 15+ (NULLS NOT DISTINCT, security_invoker); servidor %',
      current_setting('server_version');
  end if;
end $pre$;

create schema if not exists private;

-- As views são security_invoker: service_role (quem consulta) precisa de USAGE nos schemas e SELECT na origem.
do $pre$
declare
  v_faltas text[] := '{}';
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'marcas_resolvedor: papel service_role não existe';
  end if;
  if not has_schema_privilege('service_role', 'public', 'USAGE') then
    v_faltas := v_faltas || 'USAGE no schema public'::text;
  end if;
  if not has_schema_privilege('service_role', 'private', 'USAGE') then
    v_faltas := v_faltas || 'USAGE no schema private'::text;
  end if;
  if to_regclass('public.precos_praticados_itens') is null then
    v_faltas := v_faltas || 'tabela de origem public.precos_praticados_itens não existe'::text;
  elsif not has_table_privilege('service_role', 'public.precos_praticados_itens', 'SELECT') then
    v_faltas := v_faltas || 'SELECT em public.precos_praticados_itens'::text;
  end if;
  if array_length(v_faltas, 1) > 0 then
    raise exception 'marcas_resolvedor: service_role sem o necessário para as views security_invoker: %',
      array_to_string(v_faltas, '; ')
      using hint = 'Conceder os privilégios listados a service_role (pelo bot LicitaGym Supabase) e reaplicar.';
  end if;
end $pre$;

-- 1) Normalização ------------------------------------------------------------------------------------------
create or replace function private.marca_normalizar(p_valor text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select nullif(regexp_replace(t.s, '^(.+) \1$', '\1'), '')
    from (
      select btrim(regexp_replace(
               regexp_replace(
                 regexp_replace(
                   upper(translate(p_valor,
                     'áàâãäåéèêëíìîïóòôõöúùûüçñýÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
                     'aaaaaaeeeeiiiiooooouuuucnyAAAAAAEEEEIIIIOOOOOUUUUCNY')),
                   '[^A-Z0-9&]+', ' ', 'g'),
                 '(^| )LTDA( |$)', ' ', 'g'),
               ' +', ' ', 'g')) as s
    ) t
$fn$;

comment on function private.marca_normalizar(text) is
  'Marca -> forma normalizada: maiúsculas, sem acento, sem LTDA, pontuação vira espaço, espaços colapsados, frase repetida colapsada; vazio -> NULL. EXECUTE só service_role.';

-- 2) Aliases ----------------------------------------------------------------------------------------------
create table if not exists public.marca_aliases (
  id             bigint generated always as identity,
  valor_norm     text not null,
  modo           text not null default 'exato',
  cnpj_escopo    text,
  marca          text,
  tipo           text not null,
  origem         text not null,
  evidencia      text not null,
  revisao_manual boolean not null default false,
  seed_versao    text,
  ativo          boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint marca_aliases_pkey primary key (id),
  constraint marca_aliases_chave_key unique nulls not distinct (valor_norm, modo, cnpj_escopo),
  constraint marca_aliases_modo_check check (modo in ('exato', 'prefixo', 'regex')),
  constraint marca_aliases_tipo_check check (tipo in ('marca', 'grafia', 'modelo_marca', 'nao_marca')),
  constraint marca_aliases_origem_check
    check (origem in ('amostra_manual', 'web', 'seed_python', 'plugin_comprasgov', 'dados', 'curadoria')),
  constraint marca_aliases_cnpj_check check (cnpj_escopo is null or cnpj_escopo ~ '^[0-9]{14}$'),
  constraint marca_aliases_marca_check check ((tipo = 'nao_marca') = (marca is null)),
  constraint marca_aliases_marca_norm_check check (marca is null or marca = private.marca_normalizar(marca)),
  -- padrão vazio (ou só espaços) casaria com toda marca: proibido em qualquer modo
  constraint marca_aliases_valor_vazio_check check (btrim(valor_norm) <> ''),
  -- exato/prefixo guardam o valor já normalizado; regex precisa compilar (expressão inválida falha no INSERT) e não
  -- pode casar com a string vazia ('', '.*', '^', 'X?'...), porque casaria com toda marca
  constraint marca_aliases_valor_check check (
    (modo in ('exato', 'prefixo') and valor_norm = private.marca_normalizar(valor_norm))
    or (modo = 'regex' and not ('' ~ valor_norm)))
);

-- CREATE TABLE IF NOT EXISTS não altera uma tabela que já exista em outro formato: confere colunas, tipos,
-- NOT NULL, identidade e as constraints de que a semente (ON CONFLICT) e o resolvedor dependem.
do $fmt$
declare
  v_div text;
begin
  select string_agg(coalesce(e.col, a.col) || ': esperado ' || coalesce(e.tipo || case when e.nn then ' not null' else '' end, 'ausente')
                    || ', atual ' || coalesce(a.tipo || case when a.nn then ' not null' else '' end, 'ausente'),
                    '; ' order by coalesce(e.col, a.col))
    into v_div
    from (values ('id', 'bigint', true), ('valor_norm', 'text', true), ('modo', 'text', true), ('cnpj_escopo', 'text', false),
                 ('marca', 'text', false), ('tipo', 'text', true), ('origem', 'text', true), ('evidencia', 'text', true),
                 ('revisao_manual', 'boolean', true), ('seed_versao', 'text', false), ('ativo', 'boolean', true),
                 ('created_at', 'timestamp with time zone', true), ('updated_at', 'timestamp with time zone', true))
         as e(col, tipo, nn)
    full join (select att.attname::text as col, format_type(att.atttypid, att.atttypmod) as tipo, att.attnotnull as nn
                 from pg_attribute att
                where att.attrelid = 'public.marca_aliases'::regclass and att.attnum > 0 and not att.attisdropped) a
      on a.col = e.col
   where e.col is null or a.col is null or e.tipo <> a.tipo or e.nn <> a.nn;
  if v_div is not null then
    raise exception 'marcas_resolvedor: public.marca_aliases já existe com formato diferente do esperado: %', v_div
      using hint = 'Corrigir a tabela existente (ou removê-la, se vazia) antes de aplicar esta migration.';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.marca_aliases'::regclass and attname = 'id'
                    and attidentity = 'a') then
    raise exception 'marcas_resolvedor: public.marca_aliases.id deveria ser GENERATED ALWAYS AS IDENTITY';
  end if;
  select string_agg(e.nome, ', ' order by e.nome) into v_div
    from (values ('marca_aliases_pkey'), ('marca_aliases_chave_key'), ('marca_aliases_modo_check'), ('marca_aliases_tipo_check'),
                 ('marca_aliases_origem_check'), ('marca_aliases_cnpj_check'), ('marca_aliases_marca_check'),
                 ('marca_aliases_marca_norm_check'), ('marca_aliases_valor_vazio_check'), ('marca_aliases_valor_check')) e(nome)
   where not exists (select 1 from pg_constraint c where c.conrelid = 'public.marca_aliases'::regclass and c.conname = e.nome);
  if v_div is not null then
    raise exception 'marcas_resolvedor: public.marca_aliases já existe sem as constraints: %', v_div;
  end if;
  if not exists (select 1 from pg_constraint c join pg_index i on i.indexrelid = c.conindid
                  where c.conrelid = 'public.marca_aliases'::regclass and c.conname = 'marca_aliases_chave_key'
                    and i.indnullsnotdistinct) then
    raise exception 'marcas_resolvedor: marca_aliases_chave_key deveria ser UNIQUE NULLS NOT DISTINCT';
  end if;
end $fmt$;

comment on table public.marca_aliases is
  'Resolvedor de marca: valor normalizado (exato/prefixo) ou regex -> marca canônica (NULL = não é marca). cnpj_escopo restringe a um fornecedor (ex.: PRÓPRIA de fabricante). Curadoria: revisao_manual = true (a semente da migration não sobrescreve e a linha manual vence em empate). Só service_role.';
comment on column public.marca_aliases.tipo is
  'marca (canônica), grafia (outra escrita da mesma marca), modelo_marca (linha/modelo que identifica a marca), nao_marca (placeholder, produto, medida).';
comment on column public.marca_aliases.origem is
  'De onde veio a evidência: amostra_manual, web, seed_python (listas do coletor), plugin_comprasgov, dados (co-ocorrência em precos_praticados_itens), curadoria.';
comment on column public.marca_aliases.seed_versao is
  'Versão da semente que gravou a linha (ex.: marcas-v1). NULL = linha criada pela curadoria.';

-- Semente marcas-v1 (não sobrescreve revisão manual)
insert into public.marca_aliases as a (valor_norm, modo, cnpj_escopo, marca, tipo, origem, evidencia, seed_versao)
select v.valor_norm, v.modo, v.cnpj_escopo, v.marca, v.tipo, v.origem, v.evidencia, 'marcas-v1'
  from (values
  ('FLEX EQUIPMENT', 'prefixo', null, 'FLEX EQUIPMENT', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('ARKTUS', 'prefixo', null, 'ARKTUS', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('PENALTY', 'prefixo', null, 'PENALTY', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('NEDEL', 'exato', null, 'NEDEL', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('SS ESPORTES', 'prefixo', null, 'SS ESPORTES', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('INK FITNESS', 'prefixo', null, 'INK FITNESS', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('FISIOMAQ', 'prefixo', null, 'FISIOMAQ', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('PISTA E CAMPO', 'exato', null, 'PISTA E CAMPO', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('MAGUSSY', 'exato', null, 'MAGUSSY', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('KLOPF', 'exato', null, 'KLOPF', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('DALEBOL', 'exato', null, 'DALEBOL', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('FORTIX', 'exato', null, 'FORTIX', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('MIKASA', 'exato', null, 'MIKASA', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('ANILHAS MINAS', 'exato', null, 'ANILHAS MINAS', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('DREAM', 'prefixo', null, 'DREAM', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('EMBREEX', 'prefixo', null, 'EMBREEX', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('MOVEMENT', 'prefixo', null, 'MOVEMENT', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('EVOLUTION', 'exato', null, 'EVOLUTION', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('SPEEDO', 'prefixo', null, 'SPEEDO', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('ATHLETIC', 'prefixo', null, 'ATHLETIC', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('WCT', 'prefixo', null, 'WCT', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('GALLANT', 'prefixo', null, 'GALLANT', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('SUPERTECH', 'exato', null, 'SUPERTECH', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('VONDER', 'exato', null, 'VONDER', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('KAVE', 'exato', null, 'KAVE', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('CLINK', 'exato', null, 'CLINK', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('EVOX', 'prefixo', null, 'EVOX', 'marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): classificado como marca'),
  ('PROMED', 'exato', null, 'PROMED', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('MACSPORT', 'prefixo', null, 'MACSPORT', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('MATRIX', 'exato', null, 'MATRIX', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('LIDER', 'exato', null, 'LIDER', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('WELMY', 'exato', null, 'WELMY', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('BALMAK', 'exato', null, 'BALMAK', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('LION', 'prefixo', null, 'LION', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('TOTAL HEALTH', 'exato', null, 'TOTAL HEALTH', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('WETTOR FITNESS', 'exato', null, 'WETTOR FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('ALFA FITNESS', 'exato', null, 'ALFA FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('PHYSICUS', 'exato', null, 'PHYSICUS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('RIGHETTO', 'exato', null, 'RIGHETTO', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('PROTEUS', 'exato', null, 'PROTEUS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('G TECH', 'exato', null, 'G TECH', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('LIFE FITNESS', 'exato', null, 'LIFE FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('TECHNOGYM', 'exato', null, 'TECHNOGYM', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('SLADE FITNESS', 'exato', null, 'SLADE FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('KAUFFER PILATES', 'exato', null, 'KAUFFER PILATES', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('FUNDIDOS UNIBRAS', 'exato', null, 'FUNDIDOS UNIBRAS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('CROW FITNESS', 'exato', null, 'CROW FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('GLADIUS', 'exato', null, 'GLADIUS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('EQUILIBRIO', 'exato', null, 'EQUILIBRIO', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('RINO FORCE', 'exato', null, 'RINO FORCE', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('VOLLO', 'exato', null, 'VOLLO', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('PRAXIS', 'exato', null, 'PRAXIS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('POLIMET', 'exato', null, 'POLIMET', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('JOHNSON', 'exato', null, 'JOHNSON', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('KIKOS', 'prefixo', null, 'KIKOS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('OLYMPIKUS', 'exato', null, 'OLYMPIKUS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('GEARS', 'exato', null, 'GEARS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('MK FITNESS', 'exato', null, 'MK FITNESS', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): lista MARCAS'),
  ('ANILHAS E HALTERES', 'exato', null, 'ANILHAS E HALTERES', 'marca', 'web', 'anilhasehalteres.com.br: Muscular Anilhas e Halteres Fitness Ltda, Cláudio/MG, atacado de pesos (consulta 02/10/2026)'),
  ('LIVE UP', 'prefixo', null, 'LIVE UP', 'marca', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA): _ALIAS LIVEUP->LIVE UP'),
  ('VAXX', 'prefixo', null, 'VAXX', 'marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5: VAXX = VAXXFITNESS = VAXX DELVA, marca própria da Delva'),
  ('WJ FUNDIDOS', 'exato', null, 'WJ FUNDIDOS', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: 104 linhas, 4 CNPJs'),
  ('AAZ SAUDE', 'prefixo', null, 'AAZ SAUDE', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: AAZ SAUDE/AAZ SAUDE IMPORTACAO, mesmos CNPJs (A A Z SAUDE e revenda)'),
  ('SIGMETAL', 'prefixo', null, 'SIGMETAL', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: SIGMETAL e SIGMETAL AR LIVRE; razão social SIGMETAL INDUSTRIA'),
  ('ARCIELO', 'prefixo', null, 'ARCIELO FITNESS', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: ARCIELO FITNESS/ARCIELO INDUSTRIAL, 1 CNPJ só'),
  ('UP LIFT', 'prefixo', null, 'UP LIFT', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: UP LIFT/UP LIFT PRO/UP LIFT PRV'),
  ('ODIN FIT', 'prefixo', null, 'ODIN FIT', 'marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5: grafias ODIN FIT/Odin Fit/ODIN FIT VMAX'),
  ('MBFIT', 'prefixo', null, 'MBFIT', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: MBFIT/MB FIT, mesmos revendedores'),
  ('FLEX', 'exato', null, 'FLEX EQUIPMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS FLEX->FLEX EQUIPMENT; precos_praticados_itens 02/10/2026: só CNPJs que vendem FLEX EQUIPMENT'),
  ('INK', 'exato', null, 'INK FITNESS', 'grafia', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5 alias INK; cirtrox: INK FITNESS EQUIPAMENTOS ESPORTIVOS 45196517000136'),
  ('INK FTINESS', 'exato', null, 'INK FITNESS', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: grafia da própria INK FITNESS (45196517000136)'),
  ('VAXXFITNESS', 'exato', null, 'VAXX', 'grafia', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5: três grafias de uma marca'),
  ('LIFEFITNESS', 'exato', null, 'LIFE FITNESS', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: o mesmo CNPJ (LIFE FITNESS COMERCIO) usa LIFE FITNESS e LIFEFITNESS'),
  ('UPLIFT', 'exato', null, 'UP LIFT', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: mesmos CNPJs (W.E.V, MAXIMUS) usam UP LIFT e UPLIFT'),
  ('LIVEUP', 'exato', null, 'LIVE UP', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS LIVEUP->LIVE UP'),
  ('LIVEUP SPORTS', 'exato', null, 'LIVE UP', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS LIVEUP->LIVE UP'),
  ('WJFUNDIDOS', 'exato', null, 'WJ FUNDIDOS', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: grafia sem espaço'),
  ('FISOMAQ', 'exato', null, 'FISIOMAQ', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: METACORP usa FISIOMAQ e FISOMAQ'),
  ('HIDROLIGTH', 'exato', null, 'HIDROLIGHT', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: transposição de HIDROLIGHT'),
  ('HIDROLIGHT', 'exato', null, 'HIDROLIGHT', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: 32 linhas, 12 CNPJs'),
  ('ANILHAS DE MINAS', 'exato', null, 'ANILHAS MINAS', 'grafia', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): Anilhas de Minas, Cláudio/MG'),
  ('EVOLUTION FITNESS', 'exato', null, 'EVOLUTION', 'grafia', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): EVOLUTION = Evolution Fitness'),
  ('ODINFIT', 'prefixo', null, 'ODIN FIT', 'grafia', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5: grafias de ODIN FIT'),
  ('MB FIT', 'exato', null, 'MBFIT', 'grafia', 'dados', 'precos_praticados_itens 02/10/2026: grafia com espaço'),
  ('LYON', 'exato', null, 'LION', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('LION FITNESS', 'exato', null, 'LION', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MK', 'exato', null, 'MK FITNESS', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MOVIMENT', 'exato', null, 'MOVEMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MONVIMENT', 'exato', null, 'MOVEMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MOVEMNT', 'exato', null, 'MOVEMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MOVMENET', 'exato', null, 'MOVEMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('MOVIMENT ASSALT', 'exato', null, 'MOVEMENT', 'grafia', 'seed_python', 'services/coletor-externo/coletor/perfil_item.py (MARCAS/_ALIAS/_NAO_MARCA) _ALIAS'),
  ('CLASSIC', 'prefixo', null, 'FLEX EQUIPMENT', 'modelo_marca', 'web', 'flex.ind.br/linha/profissional-classic; pregão IFRN 69/2022 ''FLEX EQUIPMENT | CLASSIC''; precos_praticados_itens 02/10/2026: só CNPJs da Flex e revendas Flex'),
  ('XI', 'exato', null, 'FLEX EQUIPMENT', 'modelo_marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): linha Flex; precos_praticados_itens 02/10/2026: 5 linhas, só 08973569000145 (Flex curada), Metalúrgica Flex e Pro Sport. Sem confirmação web'),
  ('XR', 'exato', null, 'FLEX EQUIPMENT', 'modelo_marca', 'plugin_comprasgov', 'plugin comprasgov-dados-abertos 0.3.1 MODELO_MARCA XR->Flex Equipment; precos_praticados_itens 02/10/2026: só 08973569000145 (Flex curada)'),
  ('NEW EDGE', 'prefixo', null, 'MOVEMENT', 'modelo_marca', 'web', 'Catálogo Movement 2024 (movement.com.br) ''LINHA NEW EDGE''; modelos.py _LINHAS MOVEMENT; amostra manual 02/10/2026 (historico/amostra-marca-manual.py)'),
  ('EDGE', 'exato', null, 'MOVEMENT', 'modelo_marca', 'web', 'Movement linha EDGE (fasafit.com.br, manualslib Movement EDGE); modelos.py _LINHAS MOVEMENT'),
  ('R55V5', 'exato', null, 'SPEEDO', 'modelo_marca', 'web', 'fitnessdesconto.com: Bicicleta Horizontal Speedo R55-V5; amostra manual 02/10/2026 (historico/amostra-marca-manual.py)'),
  ('^EVO ?[0-9]{4}( |$)', 'regex', null, 'EVOLUTION', 'modelo_marca', 'amostra_manual', 'amostra manual 02/10/2026 (historico/amostra-marca-manual.py): EVO 3850/EVO 3850 AC/EVO6500 = Evolution; plugin MODELO_MARCA EVO 3850->Evolution. EVO sem número não entra (MACSPORT tem linha EVO)'),
  ('^(MARCA |ACADEMIA )?P ?ROPR?I[AO0]( |$)', 'regex', '08973569000145', 'FLEX EQUIPMENT', 'marca', 'seed_python', 'coletor/data/fabricantes_marcas.json: 08973569000145 -> FLEX EQUIPMENT (flex.ind.br, Cedral-SP)'),
  ('^(MARCA |ACADEMIA )?P ?ROPR?I[AO0]( |$)', 'regex', '09135430000195', 'VAXX', 'marca', 'dados', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §5: Delva (fabricante) declara VAXX 69x e PRÓPRIA; VAXX DELVA. Revisar'),
  ('^(MARCA |ACADEMIA )?P ?ROPR?I[AO0]( |$)', 'regex', '50937669000182', 'SIGMETAL', 'marca', 'dados', 'precos_praticados_itens 02/10/2026: fabricante 50937669000182 (SIGMETAL INDUSTRIA DE EQUIPAMENTOS) declara SIGMETAL 6x e PRÓPRIA 412x. Revisar'),
  ('SIMILAR', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONFORME EDITAL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONFORME TR', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONF EDITAL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONF TR', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONFORME SOLICITADO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CONF DESC', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('S M', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('SM', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('S N', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('SEM', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('S MARCA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('N A', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('NA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('NAO SE APLICA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('DIVERSOS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('DIVERSAS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('DIVERSA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('IMPORT', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('IMP', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('UNIDADE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('UN', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('UND', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('UNID', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PAR', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PC', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PCS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PECA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('0', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('XXX', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('MARCA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('MODELO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PADRAO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('CORRESPONDENTE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('EQUIVALENTE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('COMPATIVEL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('ORIGINAL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('UNICO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('FABRICANTE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('FAB', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('FABRICACAO PROPRIA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('OFICIAL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('FITNESS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('SPORT', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('SPORTS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('ESPORTE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('ESPORTES', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('BRASIL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('NATURAL', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('EVA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('LIVRE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('AR LIVRE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('PESO LIVRE', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('VULCANIZADO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('VULCANIZADA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('EMBORRACHADO', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('EMBORRACHADA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('BANCO DE PRECOS', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('POLIESTER', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('ACADEMIA', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('SIMPLES', 'exato', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): placeholder, produto ou material'),
  ('TR', 'exato', null, null, 'nao_marca', 'dados', 'precos_praticados_itens 02/10/2026: 142 linhas em 41 CNPJs; provável ''conforme TR'' (termo de referência). Revisar'),
  ('^(MARCA |ACADEMIA )?P ?ROPR?I[AO0]( |$)', 'regex', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4: PRÓPRIA/PRÓPRIO/MARCA PRÓPRIA (1 127 linhas) não é marca sem fabricante curado'),
  ('^(CONF|CONFORME|DE ACORDO|VIDE|VER|NAC|NACIONAL|IMPORTAD[OA]|SEM MARCA|SEM MODELO|MARCAS DIVERSAS|DIVERS[OA]S?|GENERIC[OA]|NAO INFORMAD[OA]|SIMILAR)( |$)', 'regex', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5: CONFORME EDITAL/TR, NAC/IMP, SEM MARCA, GENÉRICO, DIVERSOS, NÃO INFORMADO'),
  ('^(ANILHAS?|HALTER(E|ES)?|KETT?LEBELL|KETBELL|DUMB?BELL?|CANELEIRAS?|COLCHONETES?|BOLAS?|VOLEI(BOL)?|BICICLETA|ESTEIRA|APARELHOS?|BANCO|BARRAS?|PUXADOR|PUXADA|SUPORTES?|STEP|CORDAS?|MESAS?|CAMA ELASTICA|TRAMPOLIM|JOELHEIRAS?|COTOVELEIRAS?|ESCADA|ACESSORIOS?|TREINAMENTO|GINASTICA|ESTACAO|MINI BIKE|KIT|TAPETES?|CONES?|COLETES?|ESTANTES?|ESQUI|ESCALADA|CADEIRAS?|EMBORRACHAD[OA]S?|EQUIPAMENTOS?|COLCHAO|RODA|REFORMER|LADDER|FAIXAS?|EXPOSITOR(ES)?|PRESSAO|LEG PRESS|LEG DUPLO|PECK DECK)( |$)', 'regex', null, null, 'nao_marca', 'amostra_manual', 'estudo MARCAS-COMPRASGOV.md 02/10/2026 §4/§5 e amostra manual 02/10/2026 (historico/amostra-marca-manual.py): nome de produto no campo marca (ANILHA EMBORRACHADA, HALTER BOLA, ESTANTE ANILHAS, ESQUI TRIPLO, CADEIRA COMBO…)')
  ) as v(valor_norm, modo, cnpj_escopo, marca, tipo, origem, evidencia)
on conflict (valor_norm, modo, cnpj_escopo) do update
   set marca = excluded.marca, tipo = excluded.tipo, origem = excluded.origem, evidencia = excluded.evidencia,
       seed_versao = excluded.seed_versao, updated_at = now()
 where not a.revisao_manual
   and (a.marca, a.tipo, a.origem, a.evidencia, a.seed_versao)
       is distinct from (excluded.marca, excluded.tipo, excluded.origem, excluded.evidencia, excluded.seed_versao);

-- 3) Resolvedor -------------------------------------------------------------------------------------------
create or replace function private.marca_resolver(p_marca text, p_cnpj text)
returns table (marca_norm text, marca text, metodo text, curada boolean, alias_id bigint)
language sql
stable
set search_path = ''
as $fn$
  with n as (select private.marca_normalizar(p_marca) as v)
  select n.v, r.marca, r.metodo, r.curada, r.alias_id
    from n
    cross join lateral (
      select c.marca, c.metodo, c.curada, c.alias_id
        from (
          select a.marca,
                 case when a.tipo = 'nao_marca' then 'nao_marca' else 'alias_' || a.modo end as metodo,
                 -- curada = resolvida por alias que aponta marca (semente ou manual; revisao_manual não entra)
                 a.tipo <> 'nao_marca' as curada, a.id as alias_id,
                 1 as grupo, a.cnpj_escopo is null as global,
                 case a.modo when 'exato' then 0 when 'prefixo' then 1 else 2 end as ordem_modo,
                 length(a.valor_norm) as tamanho, a.revisao_manual as manual
            from public.marca_aliases a
           where n.v is not null
             and a.ativo
             and btrim(a.valor_norm) <> ''  -- defesa extra: padrão vazio nunca casa (a constraint já recusa)
             and (a.cnpj_escopo is null or a.cnpj_escopo = p_cnpj)
             and case a.modo
                   when 'exato' then a.valor_norm = n.v
                   when 'prefixo' then n.v = a.valor_norm or left(n.v, length(a.valor_norm) + 1) = a.valor_norm || ' '
                   else n.v ~ a.valor_norm
                 end
          union all
          -- sem alias: vazio, código de modelo/medida ou prefixo COD/MOD/REF -> não conta. Código/medida = começa
          -- com até 4 letras + dígito E (não tem palavra de 5+ letras OU tem medida: 10KG, 75CM, 60X30). Assim
          -- "3 SECONDS FITNESS", "3G FITNESS" e "D1FITNESS" ficam como marca; "1130PC", "R55V5", "LLM014" não.
          select null, case when n.v is null or length(n.v) < 2 then 'vazio' else 'codigo_ou_medida' end,
                 false, null, 2, true, 0, 0, false
            from n
           where n.v is null or length(n.v) < 2
              or (n.v ~ '^[A-Z]{0,4} ?[0-9]'
                  and (n.v !~ '[A-Z]{5,}' or n.v ~ '[0-9] ?(KG|KGS|CM|MM|MT|ML|LT|X)( |$|[0-9])'))
              or n.v ~ '^(COD|MOD|MODELO|REF)( |$)'
          union all
          select n.v, 'bruta', false, null, 3, true, 0, 0, false
            from n
        ) c
       order by c.grupo, c.global, c.ordem_modo, c.tamanho desc, c.manual desc, c.alias_id
       limit 1
    ) r
$fn$;

comment on function private.marca_resolver(text, text) is
  'Marca bruta + CNPJ -> (marca_norm, marca canônica ou NULL, metodo, curada, alias_id). Ordem: escopo do CNPJ > global; exato > prefixo mais longo > regex; manual > semente; sem alias: vazio/código/medida -> NULL, senão a string normalizada (curada=false). curada = resolvida por alias (semente ou manual), não revisada por pessoa. EXECUTE só service_role.';

-- 4) Views ------------------------------------------------------------------------------------------------
create or replace view public.v_marca_ocorrencias
with (security_invoker = true)
as
with fontes as (
  -- Fonte 1: Pesquisa de Preço do Compras.gov (vencedor do item; uma linha = uma venda)
  select 'precos_praticados'::text as fonte,
         p.id_compra || ':' || p.id_item_compra::text as ref_item,
         p.ni_fornecedor as ni,
         p.marca as marca_bruta,
         p.data_resultado as data_venda,
         p.quantidade * p.preco_unitario as valor
    from public.precos_praticados_itens p
   where p.data_resultado is not null
  -- PONTO DE EXTENSÃO (outro PR, com create or replace view mantendo as colunas):
  --   union all Paradigma/SFIEC: licitacao_resultados com vencedor = true e situacao <> 'Cancelado' (marca, cnpj)
  --   union all catálogo de fabricantes, se virar fonte de "quem vende"
),
-- Resolve cada par (marca, NI) distinto uma vez só. A chave é o próprio par, com NULL e '' distintos: com
-- coalesce(…, '') como chave, NULL e '' do mesmo NI viravam dois pares com a mesma chave e cada venda casava
-- com os dois (ocorrência duplicada).
-- Sem MATERIALIZED de propósito: inline, o filtro por CNPJ desce até fontes e o resolvedor só roda para as vendas
-- daquele CNPJ. Medido com 100 mil vendas sintéticas (95 mil com data, 59 711 pares): v_fornecedor_marcas de 1 CNPJ
-- 0,27 s (311 chamadas) sem MATERIALIZED x 6,3 s (59 711 chamadas) com; a varredura completa custa 10,4 s (uma
-- chamada por venda, 95 015) x 6,8 s com. O uso esperado é por fornecedor; carga em lote deve materializar no
-- consumidor (tabela ou materialized view), não aqui.
pares as (
  select distinct f.marca_bruta, f.ni
    from fontes f
),
resolvidos as (
  select pr.marca_bruta, pr.ni, r.marca_norm, r.marca, r.metodo, r.curada, r.alias_id
    from pares pr
    cross join lateral private.marca_resolver(pr.marca_bruta, pr.ni) r
)
select f.fonte,
       f.ref_item,
       f.ni,
       case when f.ni ~ '^[0-9]{14}$' then 'cnpj' when f.ni ~ '^[0-9]{11}$' then 'cpf' else 'outro' end as ni_tipo,
       f.marca_bruta,
       r.marca_norm,
       r.marca,
       r.metodo,
       r.curada,
       r.alias_id,
       f.data_venda,
       f.valor,
       (coalesce(f.ni ~ '^[0-9]{14}$', false) and r.marca is not null) as entra_ranking  -- NI NULL: false, não NULL
  from fontes f
  -- A igualdade é "is not distinct from" nas duas colunas (NULL casa só com NULL, '' só com ''). As igualdades por
  -- coalesce ao lado não mudam o resultado (são implicadas pelas de cima); existem só para o planner poder usar
  -- hash join: "is not distinct from" sozinho vira nested loop (95 mil vendas x 60 mil pares no teste sintético).
  join resolvidos r
    on r.marca_bruta is not distinct from f.marca_bruta
   and r.ni is not distinct from f.ni
   and coalesce(r.marca_bruta, '') = coalesce(f.marca_bruta, '')
   and coalesce(r.ni, '') = coalesce(f.ni, '');

create or replace view public.v_fornecedor_marcas_ranking
with (security_invoker = true)
as
with agg as (
  select o.ni as cnpj,
         o.marca,
         count(*) as qtd_itens,
         sum(o.valor) as valor_total,
         max(o.data_venda) as ultima_data,
         bool_or(o.curada) as curada,
         array_agg(distinct o.fonte order by o.fonte) as fontes
    from public.v_marca_ocorrencias o
   where o.entra_ranking
   group by o.ni, o.marca
  having count(*) >= 2
)
select agg.cnpj,
       agg.marca,
       agg.qtd_itens,
       agg.valor_total,
       agg.ultima_data,
       agg.curada,
       agg.fontes,
       row_number() over (partition by agg.cnpj
                          order by agg.qtd_itens desc, agg.valor_total desc nulls last,
                                   agg.ultima_data desc nulls last, agg.marca) as posicao,
       count(*) over (partition by agg.cnpj) as qtd_marcas
  from agg;

create or replace view public.v_fornecedor_marcas
with (security_invoker = true)
as
select r.cnpj,
       max(r.qtd_marcas) as qtd_marcas,
       max(r.marca)       filter (where r.posicao = 1) as marca_1,
       max(r.qtd_itens)   filter (where r.posicao = 1) as marca_1_qtd_itens,
       max(r.valor_total) filter (where r.posicao = 1) as marca_1_valor_total,
       max(r.ultima_data) filter (where r.posicao = 1) as marca_1_ultima_data,
       bool_or(r.curada)  filter (where r.posicao = 1) as marca_1_curada,
       max(r.marca)       filter (where r.posicao = 2) as marca_2,
       max(r.qtd_itens)   filter (where r.posicao = 2) as marca_2_qtd_itens,
       max(r.valor_total) filter (where r.posicao = 2) as marca_2_valor_total,
       max(r.ultima_data) filter (where r.posicao = 2) as marca_2_ultima_data,
       bool_or(r.curada)  filter (where r.posicao = 2) as marca_2_curada,
       max(r.marca)       filter (where r.posicao = 3) as marca_3,
       max(r.qtd_itens)   filter (where r.posicao = 3) as marca_3_qtd_itens,
       max(r.valor_total) filter (where r.posicao = 3) as marca_3_valor_total,
       max(r.ultima_data) filter (where r.posicao = 3) as marca_3_ultima_data,
       bool_or(r.curada)  filter (where r.posicao = 3) as marca_3_curada
  from public.v_fornecedor_marcas_ranking r
 where r.posicao <= 3
 group by r.cnpj;

create or replace view public.v_marca_aliases_pendentes
with (security_invoker = true)
as
select o.marca_norm,
       count(*) as ocorrencias,
       count(distinct o.ni) as qtd_fornecedores,
       min(o.marca_bruta) as exemplo_bruto,
       max(o.data_venda) as ultima_data
  from public.v_marca_ocorrencias o
 where o.metodo = 'bruta'
 group by o.marca_norm;

comment on view public.v_marca_ocorrencias is
  'Uma linha por item vendido (hoje: precos_praticados_itens com data_resultado) com a marca resolvida por private.marca_resolver. ni_tipo cnpj/cpf/outro; entra_ranking = CNPJ de 14 dígitos e marca não nula. Ponto de extensão para Paradigma e catálogo. security_invoker; SELECT só service_role.';
comment on view public.v_fornecedor_marcas_ranking is
  'CNPJ x marca resolvida com mínimo de 2 itens: qtd_itens, valor_total, ultima_data, curada, posicao (qtd_itens desc, valor desc, data desc, marca). security_invoker; SELECT só service_role.';
comment on view public.v_fornecedor_marcas is
  'marca_1..3 por CNPJ (14 dígitos) com qtd_itens, valor_total, ultima_data e curada de cada uma. Não grava em fornecedores. security_invoker; SELECT só service_role (front lê só via Edge Function).';
comment on view public.v_marca_aliases_pendentes is
  'Fila de curadoria: valores normalizados que contaram como marca sem alias (metodo = bruta). security_invoker; SELECT só service_role.';

-- 5) ACL --------------------------------------------------------------------------------------------------
alter table public.marca_aliases enable row level security;

revoke all on table public.marca_aliases from PUBLIC, anon, authenticated, service_role;
grant select, insert, update, delete on table public.marca_aliases to service_role;

-- id é GENERATED ALWAYS AS IDENTITY: o INSERT avança a sequence sem checar privilégio nela, então ninguém precisa
-- de grant na sequence (nem service_role).
revoke all on sequence public.marca_aliases_id_seq from PUBLIC, anon, authenticated, service_role;

revoke all on table public.v_marca_ocorrencias, public.v_fornecedor_marcas_ranking, public.v_fornecedor_marcas,
                    public.v_marca_aliases_pendentes
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.v_marca_ocorrencias, public.v_fornecedor_marcas_ranking, public.v_fornecedor_marcas,
                      public.v_marca_aliases_pendentes
  to service_role;

revoke all on function private.marca_normalizar(text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.marca_normalizar(text) to service_role;
revoke all on function private.marca_resolver(text, text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.marca_resolver(text, text) to service_role;

-- 6) Pós-checagem: o que as views security_invoker usam, com os privilégios de service_role -----------------
do $pos$
declare
  v_faltas text[] := '{}';
  v_obj text;
begin
  foreach v_obj in array array['private.marca_normalizar(text)', 'private.marca_resolver(text,text)'] loop
    if not has_function_privilege('service_role', v_obj, 'EXECUTE') then
      v_faltas := v_faltas || ('EXECUTE em ' || v_obj);
    end if;
  end loop;
  foreach v_obj in array array['public.marca_aliases', 'public.precos_praticados_itens', 'public.v_marca_ocorrencias',
                               'public.v_fornecedor_marcas_ranking', 'public.v_fornecedor_marcas',
                               'public.v_marca_aliases_pendentes'] loop
    if not has_table_privilege('service_role', v_obj, 'SELECT') then
      v_faltas := v_faltas || ('SELECT em ' || v_obj);
    end if;
  end loop;
  if not has_schema_privilege('service_role', 'private', 'USAGE') then
    v_faltas := v_faltas || 'USAGE no schema private'::text;
  end if;
  if array_length(v_faltas, 1) > 0 then
    raise exception 'marcas_resolvedor: service_role não consegue ler as views security_invoker: %',
      array_to_string(v_faltas, '; ');
  end if;
end $pos$;

commit;
