<claude-mem-context>
# Recent Activity

### Oct 5, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #8840 | 8:01 PM | ○ | Catálogo de fontes Sistema S mapeado — 9 portais cadastrados, sescsp e sesc_senac_rs em modo aviso_fornecedor (robots.txt) | ~439 |
| #8836 | 8:00 PM | ○ | Schema de órgãos e clusters mapeado — tipo_orgao, grupo_tipo, esfera_canon, escopo_termos como infraestrutura de filtro por cluster | ~511 |
| #8833 | 7:58 PM | ○ | Migrations mapeadas — cluster, esfera, natureza_juridica e tipo_orgao existem no schema Supabase | ~408 |
| #8830 | 7:56 PM | ○ | orgaos table expanded with Compras.gov columns — entidade_id and cnpj now nullable | ~405 |
| #8829 | " | ○ | cnpj_cpf_orgao_norm is in compras_orgaos_uasgs table, not in entidades/orgaos | ~229 |
| #8820 | 7:51 PM | ○ | private.cnpj_valido() — SQL function with full checksum validation per RFC 10291 | ~342 |
| #8819 | " | ○ | last_seen_sync_id column — only in pca, contratacoes, irp, catmat_compras tables, NOT in entidades/orgaos | ~288 |
| #8816 | " | ○ | entidades/orgaos/unidades schema — key constraints and design decisions | ~384 |
| #8794 | 7:38 PM | ○ | orgaos table schema confirmed — last_seen_sync_id column missing, orgao_id_pncp is bigint | ~401 |
| #8703 | 2:50 PM | ○ | validar-migrations.sh test suite run — 3 ACL/view check failures in staging database | ~482 |
| #8701 | 2:10 PM | ○ | marca_aliases schema diverges from migration 20261005170000 assumptions — column names differ | ~423 |
| #8697 | 2:08 PM | ● | marca_normalizar rewritten in PL/pgSQL — recursive CTE replaced with imperative WHILE loop | ~408 |
| #8696 | 2:07 PM | ◆ | Migration 20261005170000 — idempotência marca_normalizar + regex manual precedence fix | ~442 |

### Oct 13, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #9020 | 4:07 PM | ○ | revisor-migration review returned — no blockers, 3 important findings on compat block | ~591 |
| #9013 | 3:59 PM | ○ | Full schema diff between migration v1 and v2 confirmed — PR #349 merged both versions sequentially | ~395 |
| #9011 | " | ○ | Migration 20261012020000 has two commits — first version lacked "fonte" column, second added it | ~434 |
| #9000 | 3:52 PM | ○ | Migration review complete: no blockers — one suggestion about backfill assumption documentation | ~380 |
| #8985 | 3:46 PM | ○ | catalogo_produto_atributos schema: PK(produto_id, atributo), CHECK ensures at least one value column non-null | ~275 |
| #8984 | " | ○ | catalogo_produtos.ativo column confirmed via drift — Dashboard has catmat catalog components but no api-catalogo-ficha caller | ~377 |
| #8981 | 3:45 PM | ○ | Migration 20261002220000 adds composite indexes and catalogo_precos / catalogo_de_para tables | ~359 |
| #8980 | " | ○ | ontologia_atributos seed confirmed — 6 esteira_eletrica attributes with eliminatorio and sentido | ~391 |
| #8979 | 3:44 PM | ○ | catalogo_produtos full schema confirmed — no price column, tenant_id added via drift migration | ~383 |
| #8977 | " | ○ | catalogo_produtos RLS: SELECT open to all authenticated — tenant filter is Edge Function responsibility | ~380 |
| #8969 | 3:35 PM | ○ | Dashboard /catalogo route map — frontend ready, backend missing listar action | ~866 |
| #8952 | 3:25 PM | ○ | carga_maxima_kg and peso_equipamento_kg columns predate PR #356 | ~329 |
| #8948 | 3:24 PM | ○ | Full ontologia_atributos seeded values and esteira dictionary nodes confirmed | ~459 |
| #8947 | " | ○ | Migration 20261011100600 confirms attribute name contract violated by PR #356 | ~439 |
| #8940 | 3:18 PM | ○ | Correct no_taxonomia slug for treadmill is "esteira_eletrica" — fichaTecnica() hardcodes wrong value | ~370 |
| #8938 | " | ○ | ontologia_atributos seeds use slug format — fichaTecnica() "ESTEIRA ERGOMETRICA" won't match | ~477 |
| #8937 | " | ○ | TAXONOMIA_ESTEIRA constant "ESTEIRA ERGOMETRICA" matches existing codebase taxonomy slug pattern | ~376 |
| #8936 | " | ○ | PR #356 schema prerequisites confirmed — all target columns and tables exist in migrations | ~427 |
| #8919 | 2:53 PM | ○ | coletor.pncp is a standalone module — NOT invoked by main.py; has its own CLI with --modo/--lote/--termos flags | ~344 |
| #8914 | 2:52 PM | ○ | PNCP editais cron is intentionally commented out — sync-pncp-contratacoes-editais blocked by design | ~432 |
| #8910 | 2:41 PM | ○ | licitacoes_externas_prioridade_efetiva view logic — full body mapped | ~627 |
| #8909 | " | ○ | Migration #319 prioridade_prazo_encerrado — structure confirmed | ~282 |
</claude-mem-context>