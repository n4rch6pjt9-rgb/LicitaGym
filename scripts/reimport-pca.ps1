# Reimport PCA em lotes de 1 pagina (CATMAT 7830) - tolerante a 503/504 do PNCP
param(
  [int]$Ano = 2026,
  [int]$PaginaInicial = 1,
  [int]$PaginaFinal = 313,
  [int]$TamanhoPagina = 100,
  [string[]]$CodigosClassificacao = @("7830"),
  [int]$MaxTentativas = 6,
  [int]$PausaSegundos = 5,
  [int]$TimeoutSec = 300,
  [string]$BaseUrl = "https://ifaiagegyicjzlpskafh.supabase.co",
  [string]$Secret,
  [switch]$LimparAntes
)

. "$PSScriptRoot\_load-sync-env.ps1"

if (-not $Secret) {
  $Secret = Get-SyncCronSecret
}
if (-not $Secret) {
  throw "SYNC_CRON_SECRET ausente. Veja supabase/.env.functions.local"
}

function Invoke-SyncPagina {
  param([int]$Pagina)

  $body = New-Object System.Collections.Hashtable
  $body["ano"] = $Ano
  $body["codigos_classificacao"] = $CodigosClassificacao
  $body["max_paginas"] = 1
  $body["pagina_inicial"] = $Pagina
  $body["tamanho_pagina"] = $TamanhoPagina
  $body["forcar"] = $true

  $headers = New-Object System.Collections.Hashtable
  $headers["Authorization"] = "Bearer $Secret"
  $headers["Content-Type"] = "application/json"

  $uri = "$BaseUrl/functions/v1/sync-pncp-pca"
  $jsonBody = $body | ConvertTo-Json

  return Invoke-WebRequest -Method POST -Uri $uri -Headers $headers -Body $jsonBody -TimeoutSec $TimeoutSec -UseBasicParsing
}

function Get-RetryWaitSeconds($Attempt, $HttpStatus, $Message) {
  $isTimeout = "$Message" -match "tempo limite|timed out|timeout"
  $statusCode = 0
  if ($HttpStatus) {
    $statusCode = $HttpStatus
  }
  $isServerError = $statusCode -ge 500

  if ($isTimeout -or $isServerError) {
    $wait = 20 * $Attempt
    if ($wait -gt 120) { return 120 }
    return $wait
  }

  $wait = 5 * $Attempt
  if ($wait -gt 60) { return 60 }
  return $wait
}

if ($LimparAntes) {
  Write-Host "ATENCAO: rode no SQL Editor antes de continuar (ou confirme que ja rodou):" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "DELETE FROM public.pca_planos WHERE ano_exercicio = $Ano;" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "UPDATE private.pncp_sync_run" -ForegroundColor Yellow
  Write-Host "SET status = 'falhou', erro_principal = 'liberado para reimport', finalizada_em = now()" -ForegroundColor Yellow
  Write-Host "WHERE status = 'executando';" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Pressione Enter apos executar o SQL, ou Ctrl+C para cancelar." -ForegroundColor Yellow
  Read-Host
}

$ok = 0
$falhas = @()

for ($pagina = $PaginaInicial; $pagina -le $PaginaFinal; $pagina++) {
  $sucesso = $false

  for ($t = 1; $t -le $MaxTentativas; $t++) {
    try {
      Write-Host "Pagina $pagina/$PaginaFinal (tentativa $t/$MaxTentativas)..." -ForegroundColor Cyan
      $response = Invoke-SyncPagina -Pagina $pagina
      $json = $response.Content | ConvertFrom-Json

      if ($json.status -eq "already_running") {
        Write-Host "  Lock ativo - aguardando 60s..." -ForegroundColor Yellow
        Start-Sleep -Seconds 60
        continue
      }

      Write-Host ("  OK recebidos={0} novos={1} alterados={2} erros={3}" -f $json.recebidos, $json.novos, $json.alterados, $json.erros) -ForegroundColor Green
      $ok++
      $sucesso = $true
      break
    }
    catch {
      $status = $null
      if ($_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
      }
      $msg = $_.Exception.Message
      Write-Host "  Falha ($status): $msg" -ForegroundColor Red
      if ($t -lt $MaxTentativas) {
        $wait = Get-RetryWaitSeconds $t $status $msg
        Write-Host "  Aguardando ${wait}s antes de retentar..." -ForegroundColor Yellow
        Start-Sleep -Seconds $wait
      }
    }
  }

  if (-not $sucesso) {
    $falhas += $pagina
    Write-Host "  Pagina $pagina falhou apos $MaxTentativas tentativas." -ForegroundColor Red
  }

  if ($pagina -lt $PaginaFinal) {
    Start-Sleep -Seconds $PausaSegundos
  }
}

Write-Host "`nResumo: $ok paginas OK, $($falhas.Count) falhas." -ForegroundColor Cyan
if ($falhas.Count -gt 0) {
  Write-Host "Retomar com: .\scripts\reimport-pca.ps1 -PaginaInicial $($falhas[0]) -PaginaFinal $PaginaFinal" -ForegroundColor Yellow
}
