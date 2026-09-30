# API Temporária — Discover Piso PDM

API Edge Function para buscar PDMs de piso via Todas as Licitações e extrair informações de grupo/classe/item.

---

## Motivação

O PDM de piso **NÃO está em 78/7830** (grupo/classe padrão de academia). Esta API:
1. Consulta a API pública do Todas as Licitações
2. Busca por descrições contendo "piso"
3. Extrai codigo_pdm, codigo_grupo, codigo_classe
4. Retorna sugestões ordenadas por relevância para academia

---

## Endpoints

### GET `/functions/v1/discover-piso-pdm`

**Autenticação:** exige usuário logado. Envie `Authorization: Bearer <access_token>` de uma sessão do Supabase Auth; sem sessão (ou com a anon key) a resposta é `401 Unauthorized`. A função está no `supabase/config.toml` (`verify_jwt = false`, JWT validado no código) e é republicada a cada merge na `main`.

**Query Parameters:**

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `termo` | string | `"piso"` | Termo de busca (ex: "borracha", "piso vinílico") |
| `categoria` | string | `"equipamentos-esportivos-e-lazer"` | Categoria no Todas as Licitações |
| `estado` | string | — | Filtro opcional por UF (ex: "sp", "rj") |
| `limite` | number | `100` | Máximo de resultados a retornar |

**Exemplo:**
```bash
curl -H "Authorization: Bearer $LICITAGYM_USER_JWT" "http://localhost:54321/functions/v1/discover-piso-pdm?termo=piso&estado=sp&limite=20"
```

**Response (200 OK):**
```json
{
  "sucesso": true,
  "pdmsEncontrados": [
    {
      "codigoPdm": "123456",
      "nomePdm": "Piso de Borracha 50x50cm — Tipo fitness",
      "codigoGrupo": "45",
      "codigoClasse": "4567",
      "fonte": "api-todaslicitacoes",
      "descricaoOriginal": "Material de revestimento borracha..."
    },
    {
      "codigoPdm": "234567",
      "nomePdm": "Piso Vinílico 1m x 1m — Academia",
      "codigoGrupo": "45",
      "codigoClasse": "4568",
      "fonte": "api-todaslicitacoes",
      "descricaoOriginal": "Piso vinílico, 1m x 1m, resistente..."
    }
  ],
  "totalResultados": 2,
  "avisos": []
}
```

---

## Como usar

### 1. Desenvolvimento local com Supabase CLI

```bash
# Iniciar Supabase local
supabase start

# Em outro terminal, testar a API
curl -H "Authorization: Bearer $LICITAGYM_USER_JWT" "http://localhost:54321/functions/v1/discover-piso-pdm?termo=piso&limite=10" | jq .
```

### 2. Via script Deno (recomendado)

```bash
# Executar descoberta com Deno
deno run --allow-net scripts/discover-piso-api.ts

# Com filtros
deno run --allow-net scripts/discover-piso-api.ts --termo "borracha" --estado "sp" --limite 20
```

**Saída esperada:**
```
🔍 Discovering Piso PDMs via API...

   Termo: piso
   Categoria: equipamentos-esportivos-e-lazer
   Limite: 20

✅ 3 PDMs encontrados:

┌─────────┬──────────────────────────────────────────┬──────────┬────────────────┐
│ PDM ID  │ Nome                                     │ Grupo/Cl │ Fonte          │
├─────────┼──────────────────────────────────────────┼──────────┼────────────────┤
│ 123456  │ Piso de Borracha 50x50cm — Tipo fitness │ 45/4567  │ api-todaslic   │
│ 234567  │ Piso Vinílico 1m x 1m — Academia       │ 45/4568  │ api-todaslic   │
│ 345678  │ Piso de Madeira — Modular              │ 46/4678  │ api-todaslic   │
└─────────┴──────────────────────────────────────────┴──────────┴────────────────┘

💾 SQL para marcar PDM de piso (escolha um):

-- Piso de Borracha 50x50cm — Tipo fitness
UPDATE public.catalogo_itens
SET categoria_licitagym = 'piso',
    taxonomias = jsonb_set(taxonomias, '{material}', '"piso"')
WHERE codigo_pdm = '123456';
```

### 3. Via cURL direto (em produção)

```bash
# Desenvolvimento
curl -H "Authorization: Bearer $LICITAGYM_USER_JWT" "http://localhost:54321/functions/v1/discover-piso-pdm?termo=piso" | jq .

# Produção (quando deployado)
curl -H "Authorization: Bearer $LICITAGYM_USER_JWT" "https://seu-project.supabase.co/functions/v1/discover-piso-pdm?termo=piso" | jq .
```

---

## Estratégias de discovery

A API tenta 3 estratégias em sequência:

### 1️⃣ API JSON (Todas as Licitações)
```
GET https://www.todaslicitacoes.com.br/api/licitacoes
?categoria=equipamentos-esportivos-e-lazer&limit=100
```
Retorna lista de licitações/itens com descrição de material.

### 2️⃣ GraphQL (se Compras.gov usa)
```graphql
query BuscarPisos {
  material(where: {descricao_contains: "piso"}, limit: 100) {
    codigoPdm
    nomePdm
    codigoGrupo
    codigoClasse
  }
}
```

### 3️⃣ Fallback (dados de teste)
Se ambas falham, retorna 3 PDMs de teste conhecidos:
- `123456` — Piso de Borracha 50x50cm
- `234567` — Piso Vinílico 1x1m
- `345678` — Piso de Madeira

(Isso é apenas para desenvolvimento — em produção, avisar que a API está indisponível)

---

## Fluxo de integração

Uma vez descoberto o `codigoPdm` de piso:

```
1. Executar script discover-piso-api.ts
   ↓
2. Copiar o codigoPdm do resultado
   ↓
3. Executar SQL de marcação
   UPDATE catalogo_itens SET categoria_licitagym = 'piso' WHERE codigo_pdm = 'XXXXXX'
   ↓
4. Atualizar section 1.8 em schemas-consultas.md com valores reais
   ↓
5. Executar migration 202609192030_piso_curadoria.sql
   ↓
6. Query CAT-06 agora retorna itens de piso
```

---

## Limitações

- **API externa bloqueada em CCR**: A chamada a `todaslicitacoes.com.br/api/` pode falhar por restrições de proxy
- **Fallback automático**: Se API falhar, retorna dados de teste
- **Sem autenticação**: API pública não requer token
- **Rate limiting**: Respeitar limites de chamada (típico 100-1000 req/dia em APIs públicas)

---

## Próximos passos

1. ✅ Edge Function criada
2. ✅ Cliente Deno criado
3. 🔄 **Executar descoberta** (scripts/discover-piso-api.ts)
4. 📋 Copiar codigoPdm do resultado
5. 📝 Atualizar schemas-consultas.md seção 1.8
6. 🚀 Deploy da migration

---

## Debugging

**Se a API não responder:**

```bash
# 1. Verificar status local
curl http://localhost:54321/functions/v1/discover-piso-pdm -v

# 2. Ver logs da Edge Function
supabase functions serve discover-piso-pdm

# 3. Testar API externa manualmente
curl "https://www.todaslicitacoes.com.br/api/licitacoes?categoria=equipamentos-esportivos-e-lazer&limit=10" -v
```

**Erro comum:** `403 Forbidden` — proxy bloqueando. Usar dados de fallback ou proxy externo.
