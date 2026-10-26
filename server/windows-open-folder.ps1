param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  $folder = $request.folder.Replace('/', '\')
  $nativeFolder = if ($folder.StartsWith('\\?\')) { $folder } else { '\\?\' + $folder }
  if (!([IO.Directory]::Exists($nativeFolder))) { throw 'This folder has moved or is no longer accessible. Rescan its location.' }
  if ($ValidateOnly) {
    [Console]::WriteLine((@{ok=$true} | ConvertTo-Json -Compress))
    exit 0
  }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $folder
  $start.UseShellExecute = $true
  $start.Verb = 'open'
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Normal
  $start.ErrorDialog = $false
  try { $process = [Diagnostics.Process]::Start($start) }
  catch { throw ('Windows could not open the folder: ' + $_.Exception.Message) }
  [Console]::WriteLine((@{ok=$true} | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
