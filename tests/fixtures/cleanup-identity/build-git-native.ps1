param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$resolved = [System.IO.Path]::GetFullPath($OutputDirectory)
$reviewRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../review/cleanup-identity'))
if (!$resolved.StartsWith($reviewRoot + [System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain in ignored experiment receipts.' }
New-Item -ItemType Directory -Force -Path $resolved | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Existing native compiler unavailable.' }
& $compiler /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll ("/out:"+(Join-Path $resolved 'git-identity.exe')) (Join-Path $PSScriptRoot 'git-native-supervision.cs') (Join-Path $PSScriptRoot 'git-operator.cs')
if ($LASTEXITCODE -ne 0) { throw 'Git fixture compilation failed.' }
