$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-folder-measurement.cs')
$result = [ReclaimFolderReader]::Measure([string]$request.path, [int]$request.timeoutMs)
[Console]::WriteLine((@{ type = 'result'; result = $result } | ConvertTo-Json -Compress -Depth 5))
