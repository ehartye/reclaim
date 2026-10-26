$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
$target = [IO.Path]::GetFullPath([string]$request.path)
if ($target -notmatch '^[A-Za-z]:\\' -or $target.Contains('..\')) { throw 'Only absolute local paths are supported.' }
function Check($p) {
  $attrs = [IO.File]::GetAttributes('\\?\' + $p)
  if (([int]$attrs -band 0x441400) -ne 0) { throw ('Link, offline or cloud object: ' + $p) }
  return $attrs
}
$ancestor = $target
while ($ancestor) {
  $null = Check $ancestor
  $next = [IO.Path]::GetDirectoryName($ancestor)
  if ($next -eq $ancestor) { break }
  $ancestor = $next
}
$stack = [Collections.Generic.Stack[string]]::new()
$stack.Push($target)
$count = 0
while ($stack.Count -gt 0) {
  if (++$count -gt 250000) { throw 'Safety inspection limit reached.' }
  $p = $stack.Pop()
  $attrs = Check $p
  if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries('\\?\' + $p)) { $stack.Push($entry.Substring(4)) }
  }
}
[Console]::WriteLine('safe')
