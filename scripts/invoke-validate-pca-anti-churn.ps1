# Duas chamadas sync-pncp-pca (7830): 2a deve ser ignorada ou mostly inalterada (pos-deploy upsert)
param(
  [int]$Ano = (Get-Date).Year,
  [int]$MaxPaginas = 1,
  [int]$TamanhoPagina = 200,
  [int]$TimeoutSec = 1200,
  [string]$BaseUrl = "https://ifaiagegyicjzlpskafh.supabase.co",
  [string]$Secret
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\_load-sync-env.ps1"

if (-not $Secret) { $Secret = Get-SyncCronSecret }
if (-not $Secret) { throw "SYNC_CRON_SECRET ausente." }

$headers = @{
  Authorization  = "Bearer $Secret"
  "Content-Type" = "application/json"
}

function Invoke-PcaRodada {
  param([string]$Label)
  $body = @{
    ano                   = $Ano
    codigos_classificacao = @("7830")
    pagina_inicial        = 1
    max_paginas           = $MaxPaginas
    tamanho_pagina        = $TamanhoPagina
  }
  Write-Host "`n=== $Label ===" -ForegroundColor Cyan
  $response = Invoke-WebRequest `
    -Method POST `
    -Uri "$BaseUrl/functions/v1/sync-pncp-pca" `
    -Headers $headers `
    -Body ($body | ConvertTo-Json) `
    -TimeoutSec $TimeoutSec `
    -UseBasicParsing
  $json = $response.Content | ConvertFrom-Json
  Write-Host ($json | ConvertTo-Json -Depth 8)
  return $json
}

$run1 = Invoke-PcaRodada -Label "Rodada 1 (baseline)"
if ($run1.status -eq "incompleta") {
  Write-Host "Carga incompleta: conclua a cadeia antes de avaliar anti-churn." -ForegroundColor Yellow
  exit 2
}
if ($run1.status -notin @("concluida", "ignorado") -or [int]$run1.erros -gt 0) { exit 1 }
Start-Sleep -Seconds 5
$run2 = Invoke-PcaRodada -Label "Rodada 2 (anti-churn)"
if ($run2.status -eq "incompleta") {
  Write-Host "Segunda carga incompleta: anti-churn nao verificado." -ForegroundColor Yellow
  exit 2
}
if ($run2.status -notin @("concluida", "ignorado") -or [int]$run2.erros -gt 0) { exit 1 }

Write-Host "`n--- Interpretacao ---" -ForegroundColor Yellow
if ($run2.status -eq "ignorado") {
  Write-Host "OK: periodo inalterado (idempotente)." -ForegroundColor Green
  exit 0
}

$inalterados2 = if ($null -ne $run2.inalterados) { [int]$run2.inalterados } else { 0 }
$alterados2 = if ($null -ne $run2.alterados) { [int]$run2.alterados } else { 0 }
$novos2 = if ($null -ne $run2.novos) { [int]$run2.novos } else { 0 }

if ($novos2 -eq 0 -and $alterados2 -eq 0 -and $inalterados2 -gt 0) {
  Write-Host "OK: 2a rodada sem novos/alterados ($inalterados2 inalterados)." -ForegroundColor Green
  exit 0
}

Write-Host "Revisar: novos=$novos2 alterados=$alterados2 inalterados=$inalterados2 (pode ser churn ou mudanca PNCP)." -ForegroundColor Yellow
exit 1
