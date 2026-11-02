param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($OutputDirectory)
$allowed = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../review/data-owner-lifetime'))
if (!$resolved.StartsWith($allowed + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be in ignored owner experiment evidence.' }
New-Item -ItemType Directory -Force -Path $resolved | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Existing C# compiler required.' }
& $compiler /nologo /target:exe /platform:x64 /main:OwnerCandidateEntry /r:System.Web.Extensions.dll (('/out:') + (Join-Path $resolved 'owner-reference-candidate.exe')) (Join-Path $PSScriptRoot 'native-harness.cs') (Join-Path $PSScriptRoot 'reference-candidate.cs')
if ($LASTEXITCODE -ne 0) { throw 'Candidate compilation failed.' }
