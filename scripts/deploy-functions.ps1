# Deploy Edge Functions PNCP no projeto linkado (remoto)
param(
  [string]$ProjectRef = "ifaiagegyicjzlpskafh",
  [switch]$Debug,
  [switch]$UseApi
)

$ErrorActionPreference = "Stop"

$functions = @(
  "sync-pncp-pca",
  "import-catmat-curadoria",
  "sync-pncp-contratacoes-editais",
  "sync-pncp-contratacoes-atas",
  "sync-pncp-contratacoes-contratos",
  "sync-pncp-catalogo",
  "sync-compras-catmat",
  "link-catmat-pca",
  "sync-pncp-irp",
  "api-pncp-pca",
  "api-pncp-contratacoes",
  "api-pncp-irp",
  "calculate-distance-webrouter"
)

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  $tokenLine = Select-String -Path "$PSScriptRoot\..\supabase\.env.local" -Pattern '^SUPABASE_ACCESS_TOKEN=(.+)$' -ErrorAction SilentlyContinue
  if ($tokenLine) {
    $env:SUPABASE_ACCESS_TOKEN = $tokenLine.Matches.Groups[1].Value.Trim()
  }
}

Write-Host "Project ref: $ProjectRef"
Write-Host "CLI version:" (npx supabase -v)

$failed = @()

foreach ($name in $functions) {
  Write-Host "`n=== Deploy $name ===" -ForegroundColor Cyan
  $deployArgs = @(
    "functions", "deploy", $name,
    "--project-ref", $ProjectRef,
    "--no-verify-jwt"
  )
  if ($UseApi) { $deployArgs += "--use-api" }
  if ($Debug) { $deployArgs += "--debug" }

  & npx supabase @deployArgs
  if ($LASTEXITCODE -ne 0) {
    $failed += $name
  }
}

if ($failed.Count -gt 0) {
  Write-Host "`nFalharam: $($failed -join ', ')" -ForegroundColor Red
  Write-Host @"

403 'necessary privileges' no deploy de functions:
  1. Dashboard -> Organization (xtqywunwrnembbtqnxtt) -> Team: role Owner ou Admin
  2. Dashboard -> Edge Functions: a pagina abre? Se nao, e permissao de org/plano
  3. Token novo em Account -> Access Tokens (conta dona do projeto)
  4. npx supabase login --token sbp_...
  5. CLI mais recente: npx supabase@latest functions deploy ... --use-api --debug
  6. Alternativa: Dashboard -> Edge Functions -> Deploy from GitHub (repo LicitaGym)

Veja docs/pncp/deploy-checklist.md secao '403 Edge Functions'.
"@ -ForegroundColor Yellow
  exit 1
}

Write-Host "`nTodas as functions deployadas." -ForegroundColor Green
