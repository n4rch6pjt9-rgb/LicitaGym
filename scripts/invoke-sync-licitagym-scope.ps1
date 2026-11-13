# Pipeline escopo LicitaGym. Nenhum body envia classe. A Edge resolve a policy.
param(
  [int]$Ano = (Get-Date).Year,
  [int]$PcaPaginasPorRodada = 2,
  [int]$PcaTamanhoPagina = 250,
  [int]$PcaTimeoutSec = 1200,
  [switch]$SkipCatmat,
  [switch]$SkipPca,
  [switch]$SkipLink,
  [switch]$ForcarPca,
  [switch]$SkipCaracteristicas,
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

function Invoke-EdgeJson {
  param(
    [string]$FunctionName,
    [hashtable]$Body,
    [int]$TimeoutSec = 300
  )
  $response = Invoke-WebRequest `
    -Method POST `
    -Uri "$BaseUrl/functions/v1/$FunctionName" `
    -Headers $headers `
    -Body ($Body | ConvertTo-Json) `
    -TimeoutSec $TimeoutSec `
    -UseBasicParsing
  return $response.Content | ConvertFrom-Json
}

Write-Host "=== LicitaGym scope (policy da Edge; sem classe no body) ===" -ForegroundColor Cyan
Write-Host "Base: $BaseUrl"

if (-not $SkipCatmat) {
  Write-Host "`n[1/3] sync-compras-catmat (sem codigo_grupo/codigo_classe)..." -ForegroundColor Cyan
  if ($SkipCaracteristicas) {
    & "$PSScriptRoot\invoke-sync-compras-catmat.ps1" -BaseUrl $BaseUrl -Secret $Secret -SkipCaracteristicas
  } else {
    & "$PSScriptRoot\invoke-sync-compras-catmat.ps1" -BaseUrl $BaseUrl -Secret $Secret
  }
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not $SkipPca) {
  Write-Host "`n[2/3] sync-pncp-pca (sem codigos_classificacao) em lotes de $PcaPaginasPorRodada pagina(s)..." -ForegroundColor Cyan
  $pagina = 1
  $rodada = 0
  $classesAbertas = @()
  do {
    $rodada++
    $body = @{
      ano            = $Ano
      max_paginas    = $PcaPaginasPorRodada
      tamanho_pagina = $PcaTamanhoPagina
    }
    if ($ForcarPca -and $rodada -eq 1) { $body.forcar = $true }

    $lista = if ($classesAbertas.Count -gt 0) { $classesAbertas -join "," } else { "(policy)" }
    Write-Host "  Rodada $rodada pagina_inicial=$pagina classes=$lista..." -ForegroundColor DarkCyan
    try {
      $json = Invoke-EdgeJson -FunctionName "sync-pncp-pca" -Body $body -TimeoutSec $PcaTimeoutSec
    }
    catch {
      Write-Host "  Falha PCA (BLOCKED, nao e zero): $($_.Exception.Message)" -ForegroundColor Red
      exit 1
    }

    if ($json.status -eq "blocked" -or $json.status -eq "already_running" -or $json.error) {
      Write-Host "  PCA BLOCKED: $($json.status) $($json.reason) $($json.error)" -ForegroundColor Yellow
      exit 1
    }
    if ($json.status -eq "ignorado") {
      Write-Host "  PCA ignorado: $($json.motivo)" -ForegroundColor Yellow
      break
    }

    $rows = @()
    if ($json.por_codigo) {
      foreach ($prop in @($json.por_codigo.PSObject.Properties)) {
        $rows += [pscustomobject]@{
          classe     = [string]$prop.Name
          restantes  = [int]$prop.Value.paginas_restantes
          ultima     = [int]$prop.Value.ultima_pagina
          recebidos  = [int]$prop.Value.recebidos
          erros      = [int]$prop.Value.erros
          sync_id    = [string]$json.sync_id
        }
      }
    }
    if ($rows.Count -eq 0) {
      Write-Host "  PCA sem por_codigo. Classe nao executada (BLOCKED)." -ForegroundColor Red
      exit 1
    }
    $classesAbertas = @()
    $proxima = $pagina
    foreach ($row in $rows) {
      Write-Host ("  classe={0} sync_id={1} recebidos={2} erros={3} ultima_pag={4} restantes={5}" -f `
          $row.classe, $row.sync_id, $row.recebidos, $row.erros, $row.ultima, $row.restantes) -ForegroundColor Green
      if ($row.erros -gt 0) {
        Write-Host "  classe $($row.classe) com erros (BLOCKED)." -ForegroundColor Red
        exit 1
      }
      if ($row.restantes -gt 0) {
        $classesAbertas += $row.classe
        if (($row.ultima + 1) -gt $proxima) { $proxima = $row.ultima + 1 }
      }
    }
    if ($rodada -eq 1 -and $rows.Count -lt 2) {
      Write-Host "  AVISO: uma classe na resposta. Confira se a funcao implantada resolve a policy completa." -ForegroundColor Yellow
    }
    if ($classesAbertas.Count -eq 0) { break }
    if ($json.status -ne "incompleta" -or -not $json.continuation) {
      throw "PCA sem checkpoint valido; atualize a funcao antes de retomar."
    }
    $pagina = $proxima
    Start-Sleep -Seconds 3
  } while ($true)
}

if (-not $SkipLink) {
  Write-Host "`n[3/3] link-catmat-pca (sem classe_catmat) paginado..." -ForegroundColor Cyan
  $linkOffset = 0
  $linkRodada = 0
  $totNovos = 0
  do {
    $linkRodada++
    try {
      $json = Invoke-EdgeJson -FunctionName "link-catmat-pca" -Body @{
        limiar_similaridade = 0.55
        limite              = 500
        offset              = $linkOffset
      } -TimeoutSec 300
    }
    catch {
      Write-Host "  Falha link (BLOCKED, nao e zero): $($_.Exception.Message)" -ForegroundColor Red
      exit 1
    }
    if ($json.error -or ($json.status -eq "blocked")) {
      Write-Host "  link BLOCKED: $($json.error) $($json.reason)" -ForegroundColor Red
      exit 1
    }
    $batches = @()
    if ($json.resultados) { $batches = @($json.resultados) } else { $batches = @($json) }
    if ($batches.Count -eq 0) {
      Write-Host "  link sem lotes. Classe nao executada (BLOCKED)." -ForegroundColor Red
      exit 1
    }
    $anyMore = $false
    $nextOffset = $linkOffset
    foreach ($batch in $batches) {
      $analisados = if ($null -ne $batch.analisados) { [int]$batch.analisados } else { 0 }
      $vinculos = if ($null -ne $batch.vinculos_novos) { [int]$batch.vinculos_novos } else { 0 }
      $pdmV = if ($null -ne $batch.pdm_vinculos) { [int]$batch.pdm_vinculos } else { 0 }
      $totNovos += $vinculos
      Write-Host ("  classe={0} rodada={1} offset={2} analisados={3} novos={4} pdm={5} tem_mais={6}" -f `
          $batch.classe_catmat, $linkRodada, $linkOffset, $analisados, $vinculos, $pdmV, $batch.tem_mais) -ForegroundColor Green
      if ($batch.tem_mais) {
        $anyMore = $true
        $cand = [int]$batch.proximo_offset
        if ($cand -gt $nextOffset) { $nextOffset = $cand }
      }
    }
    if ($linkRodada -eq 1 -and -not $json.resultados) {
      Write-Host "  AVISO: resposta plana de uma classe. Confira se a funcao implantada resolve a policy completa." -ForegroundColor Yellow
    }
    if (-not $anyMore) { break }
    $linkOffset = $nextOffset
    Start-Sleep -Seconds 2
  } while ($true)
  Write-Host "  Total vinculos_novos nesta execucao: $totNovos" -ForegroundColor Cyan
}

Write-Host "`nPipeline escopo concluido." -ForegroundColor Cyan
