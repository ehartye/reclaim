$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-folder-totals.cs')
  if ($request.inspect) {
    [ReclaimFolderTotals]::Inspect([string]$request.root, [string[]]$request.exclusions, [bool]$request.skipCloud, [int]$request.offset, [int]$request.limit)
  } else {
    [ReclaimFolderTotals]::Run([string]$request.root, [string[]]$request.exclusions, [bool]$request.skipCloud, [string]$request.cacheFile, [long]$request.folderMinBytes)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
