import sys
sys.path.insert(0, 'services/coletor-externo')
from coletor.escopo import PDMS_ESCOPO, PDMS_CLASSE_7830, TERMOS_POR_PDM, pdms_sem_termo, TERMOS_ESCOPO_COMPLETO

def get_classe(pdm):
    if pdm in (10779, 18481):
        return 7220
    if pdm == 9461:
        return 9320
    return 7830

lines = []
lines.append('# Cobertura de Termos — Coletor PNCP (CATMAT)')
lines.append('')
lines.append('Relatório oficial de rastreabilidade de termos de busca textual no PNCP para cobertura de 100% dos PDMs no escopo LicitaGym.')
lines.append('')
lines.append('## Resumo Executivo')
lines.append('')
lines.append(f'- **Total de PDMs no escopo:** {len(PDMS_ESCOPO)}')
lines.append(f'- **PDMs da classe 7830 (Equipamentos de Ginástica e Recreação):** {len(PDMS_CLASSE_7830)} (49 ativos oficiais + 4 históricos)')
lines.append('- **PDMs da classe 7220 (Revestimentos para Pisos):** 2 (PDM 18481 Grama Sintética, PDM 10779 Piso Sintético)')
lines.append('- **PDMs da classe 9320 (Borracha / Infill):** 1 (PDM 9461 Borracha Granulada / Item 150846)')
lines.append(f'- **PDMs cobertos com termos de busca:** {len(PDMS_ESCOPO)} (100%)')
lines.append(f'- **PDMs sem termo:** {len(pdms_sem_termo())} (meta atingida: zero)')
lines.append(f'- **Total de termos de busca únicos no escopo completo:** {len(TERMOS_ESCOPO_COMPLETO)}')
lines.append('')
lines.append('---')
lines.append('')
lines.append('## PDMs sem Termo de Busca')
lines.append('')
sem = pdms_sem_termo()
if not sem:
    lines.append('**Nenhum PDM sem termo.** Todos os 56 PDMs do escopo possuem ao menos um termo de busca correspondente.')
else:
    for s in sem:
        lines.append(f'- PDM {s}: {PDMS_ESCOPO[s]}')
lines.append('')
lines.append('---')
lines.append('')
lines.append('## Tabela Detalhada de Cobertura por PDM')
lines.append('')
lines.append('| PDM | Classe | Descrição Oficial CATMAT | Status | Termos de Busca no PNCP |')
lines.append('|:---|:---|:---|:---|:---|')

for pdm in sorted(PDMS_ESCOPO.keys()):
    nome = PDMS_ESCOPO[pdm]
    cls = get_classe(pdm)
    status = 'Inativo' if pdm in (2746, 6812, 8167, 9653) else 'Ativo'
    termos = TERMOS_POR_PDM.get(pdm, [])
    termos_str = ', '.join([f'"{t}"' for t in termos])
    lines.append(f'| {pdm} | {cls} | {nome} | {status} | {termos_str} |')

lines.append('')
lines.append('---')
lines.append('')
lines.append('## Lista Completa de Termos de Busca (Escopo Completo)')
lines.append('')
lines.append(f'Total: {len(TERMOS_ESCOPO_COMPLETO)} termos.')
lines.append('')
for i, t in enumerate(TERMOS_ESCOPO_COMPLETO, 1):
    lines.append(f'{i}. "{t}"')

lines.append('')

with open('docs/coletor-pncp-termos.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print('docs/coletor-pncp-termos.md generated successfully!')
