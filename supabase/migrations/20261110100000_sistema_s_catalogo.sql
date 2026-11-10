-- LicitaGym: catálogo de produtos do Sistema S por portal (classes e produtos)
--
-- Contexto (spec 0052 fase 1; spec 0053 K-1):
-- Cada portal Paradigma do Sistema S tem um catálogo próprio em árvore Portal -> Classe -> Produto, o equivalente ao
-- Grupo -> Classe -> PDM -> Item do CATMAT. A fase 0 da 0052 (09/11/2026) mediu os 12 portais: nenhum compartilha
-- produto nem código interno com outro (veredito "independente"), então o catálogo se guarda por portal, com chave
-- (fonte, id do portal). Hoje as classes de academia estão fixas no código (CATEGORIAS_MAPEADAS) e casam por nome
-- exato: quando o portal renomeia, o catálogo some calado (FIEB, 09/11). Guardar a árvore no banco é a base da
-- seleção por tenant (fase 2) e do coletor por id de classe (fase 3).
--
-- O que muda:
--   * public.sistema_s_catalogo_classes: uma linha por (fonte, id_classe_fonte), com nome, código (quando o nome traz
--     "CÓDIGO - NOME", ex. PT030), datas da primeira e da última coleta e quantidade de produtos da última coleta;
--   * public.sistema_s_catalogo_produtos: uma linha por (fonte, id_produto_fonte), com o código interno da entidade
--     (sCdProdutoEmpresa), descrição, tipo, classe (FK composta para a classe do mesmo portal), payload_hash e datas.
--   Dado oficial: tudo vem do catálogo público do portal (PesquisarCatalogoProdutos), com a data da coleta. Campo que
--   o portal não informa fica nulo.
--
-- Quem escreve: o coletor (python -m coletor.catalogo_paradigma --gravar), com service_role. Produto que some do
-- portal não é apagado: fica com ultima_coleta_em antiga (service_role sem DELETE/TRUNCATE).
-- Quem lê: service_role (coletor e, na fase 2, a Edge Function api-catalogo-sistema-s). anon e authenticated: nada.
-- RLS ligada sem policy (intencional: o cliente lê só via Edge Function).
--
-- Volume: 505.141 produtos nos 12 portais medidos (09/11/2026); a carga é feita pelo operador depois do merge.
-- Como verificar: supabase/tests/sistema_s_catalogo_check.sql; em produção,
--   select fonte, count(*) from public.sistema_s_catalogo_produtos group by 1;
-- Volta: tabelas novas sem consumidor; drop table public.sistema_s_catalogo_produtos, public.sistema_s_catalogo_classes.
--
-- Idempotente.

begin;

-- 1) Classes do catálogo de cada portal ------------------------------------------------------------------------
create table if not exists public.sistema_s_catalogo_classes (
  id                 bigint generated always as identity primary key,
  fonte              text   not null references public.fontes_externas (slug),
  id_classe_fonte    bigint not null,                    -- nCdClasse (vale só dentro do portal)
  nome               text,                               -- sDsClasse; nulo se o portal não informar (nunca inventado)
  codigo             text,                               -- prefixo "CÓDIGO - " do nome, quando existe (ex.: PT030)
  qtd_produtos       int    check (qtd_produtos is null or qtd_produtos >= 0),
  primeira_coleta_em timestamptz not null default now(),
  ultima_coleta_em   timestamptz not null default now(),
  constraint sistema_s_catalogo_classes_fonte_classe_key unique (fonte, id_classe_fonte)
);

comment on table public.sistema_s_catalogo_classes is
  'Classes do catálogo de produtos de cada portal Paradigma do Sistema S (spec 0052 K-1). Escrita só pelo coletor (service_role); sem acesso de anon/authenticated.';

-- 2) Produtos do catálogo de cada portal -----------------------------------------------------------------------
create table if not exists public.sistema_s_catalogo_produtos (
  id                 bigint generated always as identity primary key,
  fonte              text   not null references public.fontes_externas (slug),
  id_produto_fonte   bigint not null,                    -- nCdProduto (vale só dentro do portal)
  id_classe_fonte    bigint,                             -- nCdClasse; nulo se o portal não informar
  codigo_entidade    text,                               -- sCdProdutoEmpresa (código interno da entidade)
  descricao          text,                               -- sDsProduto
  tipo               text,                               -- sDsProdutoTipo (Produto, Serviço, ...)
  payload_hash       text   not null,                    -- versão do conteúdo; muda só quando o dado muda
  primeira_coleta_em timestamptz not null default now(),
  ultima_coleta_em   timestamptz not null default now(),
  constraint sistema_s_catalogo_produtos_fonte_produto_key unique (fonte, id_produto_fonte),
  constraint sistema_s_catalogo_produtos_classe_fkey foreign key (fonte, id_classe_fonte)
    references public.sistema_s_catalogo_classes (fonte, id_classe_fonte)
);
create index if not exists sistema_s_catalogo_produtos_classe_idx
  on public.sistema_s_catalogo_produtos (fonte, id_classe_fonte);

comment on table public.sistema_s_catalogo_produtos is
  'Produtos do catálogo de cada portal Paradigma do Sistema S (spec 0052 K-2 / 0053 K-1), chave (fonte, id_produto_fonte). Escrita só pelo coletor (service_role); produto que some do portal não é apagado.';

-- 3) RLS e ACL ---------------------------------------------------------------------------------------------------
alter table public.sistema_s_catalogo_classes  enable row level security;
alter table public.sistema_s_catalogo_produtos enable row level security;

revoke all on table public.sistema_s_catalogo_classes, public.sistema_s_catalogo_produtos
  from anon, authenticated, PUBLIC;
revoke all on table public.sistema_s_catalogo_classes, public.sistema_s_catalogo_produtos from service_role;
grant select, insert, update on table public.sistema_s_catalogo_classes, public.sistema_s_catalogo_produtos
  to service_role;

revoke all on sequence public.sistema_s_catalogo_classes_id_seq, public.sistema_s_catalogo_produtos_id_seq
  from anon, authenticated, PUBLIC, service_role;
grant usage, select on sequence public.sistema_s_catalogo_classes_id_seq, public.sistema_s_catalogo_produtos_id_seq
  to service_role;

commit;
