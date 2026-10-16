<claude-mem-context>
# Recent Activity

### Sep 21, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #7187 | 2:10 PM | ● | PNCP collector fixed — removed date params causing HTTP 400, limited to 3-page test | ~365 |
| #7185 | 2:09 PM | ◆ | collector_pncp_contratacoes.py created — Fase 3 PNCP price history collector | ~392 |
| #7179 | 1:55 PM | ○ | licitagym git status — full untracked file inventory | ~473 |
| #7176 | 1:50 PM | ◆ | collector_pesquisa_preco.py created — price/supplier data for G72/G78 items | ~424 |
| #7175 | " | ○ | E7 background run completed — output file grew from 236 bytes to 4.95MB | ~362 |
| #7172 | 1:45 PM | ○ | E5 collector queries by codigoGrupo+codigoClasse — catalog-level, not purchase-context | ~391 |
| #7169 | 1:40 PM | ○ | Dry-run reveals grupo names and E2/E3 not detected by test script | ~350 |
| #7164 | 1:36 PM | ○ | E3 collector live run — 20 PDMs for G72, 53 PDMs for G78 | ~215 |
| #7163 | 1:35 PM | ○ | E2 collector live run — 1 class record each for G72 and G78 | ~225 |
| #7161 | 1:31 PM | ○ | E1 JSON uses "resultado" key, not "data" — load_resultado() format mismatch confirmed; G78 = Sports Equipment | ~377 |
| #7160 | " | ○ | Dry-run reveals E1 collector JSON has unexpected format — load_resultado fails silently | ~346 |
| #7158 | 1:30 PM | ○ | enrich_e7 maps wrong fields — E7 API response schema mismatch in upsert script | ~411 |
| #7157 | " | ○ | upsert_icatmat_consolidado.py uses dummy Supabase service key — not runnable against real DB | ~365 |
| #7155 | 1:28 PM | ↻ | E7 collector refactored to load real item codes from E4 output | ~364 |
| #7154 | " | ○ | E7 endpoint confirmed working — returns structured characteristics for real items | ~451 |
| #7153 | 1:27 PM | ○ | E4 item structure revealed — G72 is floor coverings, not fitness equipment | ~439 |
| #7144 | 12:26 PM | ○ | E7 collector — while loop and main() still call old grupo/classe API after rename | ~323 |
| #7143 | " | ● | E7 collector — fetch_caracteristicas refactored to filter by codigoItem | ~340 |

### Sep 22, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #7215 | 7:59 AM | ○ | L6A mapping: Edge sync function behavior confirmed — orgaos bootstrapped from pca_planos, legislation is HTML scraper | ~595 |
| #7214 | 7:57 AM | ○ | L6 inventory: 8 Edge sync functions, 4 API functions, 15 shared PNCP modules confirmed on disk | ~319 |
| #7213 | " | ⚖ | L6 refactoring plan locked — 10-lot sequence starting with LOTE 0 (tests) then LOTE 1 (HTTP P0 fixes) | ~506 |
| #7212 | " | ○ | L6 pre-read: Database audit — 3 P0 schema defects including dual precos_praticados_itens definitions | ~589 |
| #7211 | " | ○ | L6 pre-read: PNCP audit — Python lab collector diverges critically from Edge production sync | ~546 |
| #7207 | 12:33 AM | ⚖ | L6 PNCP phase scope locked — discovery ≠ hydration, no price phase yet | ~804 |
| #7200 | 12:10 AM | ○ | E7 collector uses "data" key with item_N structure, not "resultado" — runtime test had format mismatch | ~564 |
| #7199 | " | ○ | E7 characteristics collector output has 0 records — file exists but resultado array is empty | ~471 |

### Sep 25, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #7454 | 3:43 PM | ○ | PR #46 — Residual null_sentinel and Stale Migration Name Found in Docs and test_upsert_dryrun.py | ~376 |
| #7439 | 1:00 PM | ○ | LicitaGym PR #46 — collector_unidade_fornecimento.py Has `load_pdms_for_collector` with Hardcoded Fallback PDM Logic | ~456 |

### Sep 26, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #7862 | 7:17 PM | ✓ | PR #60 Submetido — P0 Reprojeção PCA Completa com Legacy V0/V1/V2, Paginação e Snapshot JSON | ~497 |
| #7675 | 10:52 AM | ○ | Active Branch fix/p0-normalize-classificacao — 8 Modified Files + 6 Audit Artefacts | ~422 |

### Oct 4, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #8425 | 12:08 PM | ○ | lg-validar-migrations-1874 — 4 Roles Supabase Confirmados no Container Efêmero | ~301 |
| #8420 | 11:29 AM | ○ | validar-migrations.sh — Arquitetura: Docker pgvector/pg16 Efêmero via Network Container | ~358 |

### Oct 13, 2026

| ID | Time | T | Title | Read |
|----|------|---|-------|------|
| #9018 | 4:04 PM | ○ | validar-migrations.sh confirmed — runs migrations + idempotency check + all check tests against disposable pgvector/pg17 | ~377 |
| #8998 | 3:52 PM | ○ | validar-migrations.sh runs all *_check.sql in supabase/tests/ — pendentes.txt allows known failures with expected error snippets | ~333 |
| #8917 | 2:53 PM | ○ | PNCP leads written by coletor-externo/coletor/pncp.py — separate scripts/collector_pncp_contratacoes.py also exists | ~397 |
</claude-mem-context>