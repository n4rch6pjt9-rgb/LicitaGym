$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$global:PcaTestRequests = @()
$global:PcaTestScenario = ''
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
function Invoke-WebRequest {
  param($Method, $Uri, $Headers, $Body, $TimeoutSec, [switch]$UseBasicParsing)
  if ($Uri -notlike 'http://127.0.0.1:1/*') { throw 'Destino fora do teste isolado' }
  $request = $Body | ConvertFrom-Json
  $global:PcaTestRequests += $request
  if ($global:PcaTestScenario -eq 'scope') {
    if ($request.PSObject.Properties.Name -contains 'pagina_inicial' -or
        $request.PSObject.Properties.Name -contains 'codigos_classificacao') {
      throw 'Script substituiu o checkpoint ou mudou o escopo'
    }
    if ($global:PcaTestRequests.Count -eq 1) {
      $response = @{ status='incompleta'; erros=0; sync_id='sintetico'; por_codigo=@{
        '7830'=@{ultima_pagina=1;paginas_restantes=1;erros=0};
        '7220'=@{ultima_pagina=1;paginas_restantes=0;erros=0}
      }; continuation=@{pending=@('7830')} }
    } else {
      $response = @{ status='concluida'; erros=0; sync_id='sintetico'; por_codigo=@{
        '7830'=@{ultima_pagina=2;paginas_restantes=0;erros=0}
      }; continuation=@{pending=@()} }
    }
  } else {
    $ultima = if ($global:PcaTestScenario -eq 'mismatch') { 2 } else { 1 }
    $erros = if ($global:PcaTestScenario -eq 'erro') { 1 } else { 0 }
    $response = @{status='incompleta';erros=$erros;por_codigo=@{'7830'=@{ultima_pagina=$ultima;paginas_restantes=1}}}
  }
  return [pscustomobject]@{Content=($response | ConvertTo-Json -Depth 10)}
}
$files = @('invoke-sync-licitagym-scope.ps1','reimport-pca.ps1','invoke-validate-pca-anti-churn.ps1')
foreach ($name in $files) {
  $tokens = $null; $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo "scripts/$name"), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
}
$global:PcaTestScenario='scope'; $global:PcaTestRequests=@(); $global:LASTEXITCODE=0
& "$repo/scripts/invoke-sync-licitagym-scope.ps1" -BaseUrl 'http://127.0.0.1:1' -Secret 'sintetico' -SkipCatmat -SkipLink
if ($LASTEXITCODE -ne 0 -or $global:PcaTestRequests.Count -ne 2) { throw 'Retomada do script de escopo falhou' }
foreach ($case in @('erro','mismatch')) {
  $global:PcaTestScenario=$case; $global:PcaTestRequests=@(); $global:LASTEXITCODE=0
  & "$repo/scripts/reimport-pca.ps1" -BaseUrl 'http://127.0.0.1:1' -Secret 'sintetico' -PaginaInicial 1 -PaginaFinal 1 -MaxTentativas 1 -PausaSegundos 0
  if ($LASTEXITCODE -ne 1 -or $global:PcaTestRequests.Count -ne 1) { throw "Reimport aceitou $case como sucesso" }
}
$global:PcaTestScenario='anti'; $global:PcaTestRequests=@(); $global:LASTEXITCODE=0
& "$repo/scripts/invoke-validate-pca-anti-churn.ps1" -BaseUrl 'http://127.0.0.1:1' -Secret 'sintetico'
if ($LASTEXITCODE -ne 2 -or $global:PcaTestRequests.Count -ne 1) { throw 'Anti-churn aceitou carga incompleta' }
$global:PcaTestRequests=@(); $bloqueado=$false
try {
  & "$repo/scripts/reimport-pca.ps1" -BaseUrl 'http://127.0.0.1:1' -Secret 'sintetico' -LimparAntes
} catch { $bloqueado=$_.Exception.Message -like '*desativado*' }
if (-not $bloqueado -or $global:PcaTestRequests.Count -ne 0) { throw 'LimparAntes nao foi bloqueado' }
Write-Output 'PASS: sintaxe e cinco cenarios operacionais sem chamadas de rede'

$global:LASTEXITCODE = 0
exit 0
