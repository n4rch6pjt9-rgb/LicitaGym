# migrations_archive

Migrations que **nunca foram aplicadas** no projeto `ifaiagegyicjzlpskafh` e foram retiradas de
`supabase/migrations/` em 2026-09-28 para que `supabase db push` não as execute por engano.

Verificado no banco em 2026-09-28: nenhuma das tabelas abaixo existe no remoto.

| Arquivo | Cria / altera | Motivo |
|---|---|---|
| `202609211001..006_icatmat_*.sql` | staging `icatmat_classe/pdm/item/natureza/unidade/caracteristica_material` | modelo em uso é o consolidado `icatmat_pdm_completa` |
| `20260921_fase3_precos_praticados.sql` | `precos_praticados_itens` (FK para `icatmat_item_material`) | depende do staging; versão só com data quebra a ordem |
| `20260922110000_icatmat_additive_alignment.sql` | colunas/ACL nas tabelas de staging | depende do staging |

Para reativar alguma, criar migration nova com timestamp atual (14 dígitos), não mover o arquivo de volta.
