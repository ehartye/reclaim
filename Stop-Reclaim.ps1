$ErrorActionPreference = 'Stop'
$port = if ($env:PORT) { [int]$env:PORT } else { 4318 }
$state = Invoke-RestMethod "http://127.0.0.1:$port/api/state" -TimeoutSec 5
if ($state.product -ne 'reclaim') { throw 'The service on this port is not Reclaim.' }
if ($state.job) { throw 'Stop the active scan in Reclaim before closing the service.' }
if ($state.cleanupBusy) { throw 'Wait for cleanup to finish in Reclaim before closing the service.' }
if ($state.measurementJob) { throw 'Cancel the active folder measurement or wait for it to finish before closing the service.' }
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'server[/\\]index\.mjs') { throw 'The process does not match Reclaim. No process was stopped.' }
Invoke-RestMethod "http://127.0.0.1:$port/api/shutdown" -Method Post -ContentType 'application/json' -Headers @{ 'X-Reclaim-Token' = $state.token } -Body '{}' | Out-Null
Write-Host 'Reclaim stopped.'
