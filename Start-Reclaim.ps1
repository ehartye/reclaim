param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 4318 }
$url = "http://127.0.0.1:$port"
try {
  $existing = Invoke-RestMethod "$url/api/state" -TimeoutSec 2
  if ($existing.product -ne 'reclaim') { throw 'Another service is using this port.' }
} catch {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is already in use by another service. Set PORT to a different number." }
  $node = (Get-Command node -ErrorAction Stop).Source
  if ([int]((& $node --version) -replace '^v(\d+).*','$1') -lt 24) { throw 'Reclaim requires Node.js 24 or newer.' }
  if (!(Test-Path -LiteralPath (Join-Path $project 'dist/index.html'))) { throw 'Run npm ci and npm run build in the project folder first.' }
  $data = Join-Path $project '.reclaim'
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  $process = Start-Process -FilePath $node -ArgumentList @('server/index.mjs') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'server.log') -RedirectStandardError (Join-Path $data 'server-error.log') -PassThru
  $ready = $false
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try { $response = Invoke-RestMethod "$url/api/state" -TimeoutSec 1; if ($response.product -eq 'reclaim') { $ready=$true; break } } catch {}
    if ($process.HasExited) { throw 'Reclaim did not start. Check .reclaim/server-error.log.' }
  }
  if (!$ready) { throw 'Reclaim startup timed out. Check .reclaim/server-error.log.' }
  Write-Host "Reclaim started (PID $($process.Id))."
}
if (!$NoBrowser) { Start-Process $url }
Write-Host "Reclaim is ready at $url"
