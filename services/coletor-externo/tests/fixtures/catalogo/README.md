# Fixtures do catálogo (fase 1)

Páginas públicas capturadas para os testes offline. Não há cookie, formulário nem dado pessoal.

User-Agent das capturas: `LicitaGymBot/0.1 (diagnostico de catalogo publico; +https://licitagym.com.br)`.
`robots.txt` lido antes. Intervalo de 2,5 s entre GET no mesmo host. Nenhum 403, 429 ou desafio.

## Redução

HTML de Movement e Konnen: removidos `<style>` e `<script>` que não são JSON-LD. O HTML da ficha, da listagem, da galeria e do breadcrumb permanece.

Macsport equipamentos: só o `<script>self.__next_f.push(...)` com `produtosFiltrados` (o catálogo inteiro está nesse payload).

`movement-product-19675.json` é o corpo de `wp-json` como veio (sem corte).

## Origem

| Arquivo | URL | Quando (BRT) |
|---|---|---|
| `macsport-robots.txt` | https://macsport.com.br/robots.txt | 2026-10-02 23:16 |
| `macsport-equipamentos.html` | https://macsport.com.br/equipamentos | 2026-10-02 23:16 |
| `macsport-cr-0925.html` | https://macsport.com.br/produto/cromus/gluteo-deslizante-a-partir-de-80-kg-c-inox | 2026-10-02 23:18 |
| `macsport-ms-200i.html` | https://macsport.com.br/produto/cardio/esteira-ms200-profissional-c-inclinacao-220v | 2026-10-02 23:18 |
| `movement-robots.txt` | https://www.movement.com.br/robots.txt | 2026-10-02 23:16 |
| `movement-musculacao.html` | https://www.movement.com.br/produtos/musculacao/ | 2026-10-02 23:16 |
| `movement-cardio-pg1.html` | https://www.movement.com.br/produtos/cardio/ | 2026-10-02 23:16 |
| `movement-cardio-pg2.html` | https://www.movement.com.br/produtos/cardio/?pg=2 | 2026-10-03 00:00 |
| `movement-cardio-pg3.html` | https://www.movement.com.br/produtos/cardio/?pg=3 | 2026-10-02 23:17 |
| `movement-cardio-pg4.html` | https://www.movement.com.br/produtos/cardio/?pg=4 | 2026-10-02 23:17 |
| `movement-lat-pull-axis.html` | https://www.movement.com.br/produto/lat-pull-axis/ | 2026-10-02 23:16 |
| `movement-aria-itouch.html` | https://www.movement.com.br/produto/esteira-aria-itouch-3-0/ | 2026-10-02 23:18 |
| `movement-product-19675.json` | https://www.movement.com.br/wp-json/wp/v2/product/19675 | 2026-10-02 23:17 |
| `konnen-robots.txt` | https://www.konnenfitness.com.br/robots.txt | 2026-10-02 23:16 |
| `konnen-cardio-pg1.html` | https://www.konnenfitness.com.br/categoria-produto/cardio/ | 2026-10-02 23:16 |
| `konnen-cardio-pg2.html` | https://www.konnenfitness.com.br/categoria-produto/cardio/page/2/ | 2026-10-03 00:00 |
| `konnen-cardio-pg3.html` | https://www.konnenfitness.com.br/categoria-produto/cardio/page/3/ | 2026-10-02 23:19 |
| `konnen-cardio-pg4.html` | https://www.konnenfitness.com.br/categoria-produto/cardio/page/4/ (HTTP 404) | 2026-10-02 23:19 |
| `konnen-esteira-e12.html` | https://www.konnenfitness.com.br/produto/cardio-esteira-e12/ | 2026-10-02 23:18 |
| `konnen-supino-vertical.html` | https://www.konnenfitness.com.br/produto/exoform-supino-vertical/ | 2026-10-02 23:19 |

A página 2 de Movement e a página 2 de Konnen foram recapturadas em 2026-10-03 00:00 BRT (03:00 UTC) porque não estavam no pacote de 02/10. As duas voltaram HTTP 200, sem desafio.

Nonces de formulário público (`data-wp_nonce`, `_acf_nonce`) foram esvaziados nas fixtures. Não são usados pelo parser.
