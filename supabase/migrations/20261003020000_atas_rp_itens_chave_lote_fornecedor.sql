-- =============================================================================
-- Migration: 20261003020000_atas_rp_itens_chave_lote_fornecedor.sql
-- Chave natural de public.atas_rp_itens passa a incluir lote/grupo e fornecedor.
--
-- Por quê: a chave antiga uq_atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item)
-- ignorava o fornecedor. Quando o item tem mais de um vencedor registrado (cadastro de reserva, vários fornecedores
-- na mesma ata), o upsert de um sobrescrevia o outro. Regra do owner: com mais de um vencedor o edital é por lote,
-- e o lote tem de estar mapeado. Nova chave:
--   (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)
--   UNIQUE NULLS NOT DISTINCT, constraint uq_atas_rp_itens_lote_fornecedor.
--
-- numero_grupo (nova, nullable): lote/grupo do item na compra. NULL = sem lote ou não informado pela fonte.
--   O item de ARP do Compras.gov (2_consultarARPItem) não traz lote; o módulo Contratações traz numeroGrupo
--   (0 = sem grupo). Para 0 e "não informado" não virarem duas chaves diferentes, só aceita NULL ou > 0.
-- ni_fornecedor passa a NOT NULL: sem fornecedor a linha não tem chave (o coletor já descarta).
--
-- A 20261002160000 (já aplicada em produção) não é editada; esta migration troca a constraint depois dela.
-- Não altera nem apaga dados. Antes de trocar a constraint, conta linhas sem fornecedor e chaves repetidas na nova
-- chave e aborta com mensagem clara se houver (quem decide qual linha fica é uma pessoa). Em produção, em
-- 02/10/2026, atas_rp_itens tinha 0 linhas (consulta só leitura). Idempotente: pode rodar 2x.
-- =============================================================================

begin;

set local lock_timeout = '10s';

alter table public.atas_rp_itens add column if not exists numero_grupo integer;

comment on column public.atas_rp_itens.numero_grupo is
  'Lote/grupo do item na compra (numeroGrupo do módulo Contratações do Compras.gov). NULL = sem lote ou não informado pela fonte: o item de ARP (2_consultarARPItem) não traz lote. Compõe uq_atas_rp_itens_lote_fornecedor.';

do $$
declare
  v_sem_ni bigint;
  v_grupo_invalido bigint;
  v_dup bigint;
begin
  select count(*) into v_sem_ni
    from public.atas_rp_itens
   where ni_fornecedor is null or btrim(ni_fornecedor) = '';
  if v_sem_ni > 0 then
    raise exception 'atas_rp_itens: % linha(s) sem ni_fornecedor. Sem fornecedor a linha não tem chave; corrija ou remova manualmente antes desta migration; nada foi alterado.', v_sem_ni;
  end if;

  select count(*) into v_grupo_invalido
    from public.atas_rp_itens
   where numero_grupo is not null and numero_grupo <= 0;
  if v_grupo_invalido > 0 then
    raise exception 'atas_rp_itens: % linha(s) com numero_grupo <= 0 (sem lote deve ser NULL); corrija manualmente antes desta migration; nada foi alterado.', v_grupo_invalido;
  end if;

  select count(*) into v_dup from (
    select 1 from public.atas_rp_itens
    group by numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor
    having count(*) > 1
  ) d;
  if v_dup > 0 then
    raise exception 'atas_rp_itens: % chave(s) duplicada(s) em (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor) contando NULL = NULL. Deduplique manualmente; nada foi alterado.', v_dup;
  end if;
end $$;

alter table public.atas_rp_itens alter column ni_fornecedor set not null;

do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.atas_rp_itens'::regclass and conname = 'ck_atas_rp_itens_numero_grupo'
  ) then
    alter table public.atas_rp_itens
      add constraint ck_atas_rp_itens_numero_grupo check (numero_grupo is null or numero_grupo > 0);
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.atas_rp_itens'::regclass and c.conname = 'uq_atas_rp_itens_lote_fornecedor';
  if v_def is distinct from
     'UNIQUE NULLS NOT DISTINCT (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)' then
    if v_def is not null then
      alter table public.atas_rp_itens drop constraint uq_atas_rp_itens_lote_fornecedor;
    end if;
    alter table public.atas_rp_itens
      add constraint uq_atas_rp_itens_lote_fornecedor unique nulls not distinct
      (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor);
  end if;

  -- A chave antiga (sem fornecedor) é justamente o que fazia vencedores diferentes colidirem: sai.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.atas_rp_itens'::regclass and conname = 'uq_atas_rp_itens'
  ) then
    alter table public.atas_rp_itens drop constraint uq_atas_rp_itens;
  end if;
end $$;

comment on constraint uq_atas_rp_itens_lote_fornecedor on public.atas_rp_itens is
  'Chave natural do item de ata: ata + UASG gerenciadora + lote (NULL = sem lote/não informado) + item + fornecedor. Vários vencedores do mesmo item não colidem. Alvo do on_conflict do coletor compras_arp.';

commit;
