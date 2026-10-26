$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$options = [Console]::ReadLine() | ConvertFrom-Json
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 5)) }
function NativePath($target) {
  if ($target.StartsWith('\\?\')) { return $target }
  return '\\?\' + $target
}
function UnsafeAncestor($target) {
  $parent = [IO.Path]::GetDirectoryName((NativePath $target))
  while ($parent) {
    $attributes = [IO.File]::GetAttributes($parent)
    if (([int]$attributes -band 0x441400) -ne 0) { return $true }
    $next = [IO.Path]::GetDirectoryName($parent)
    if ($next -eq $parent) { break }
    $parent = $next
  }
  return $false
}
function Blocked($target) {
  $driveRoot = [IO.Path]::GetPathRoot($target)
  foreach ($systemName in @('Windows', 'System Volume Information', '$Recycle.Bin')) {
    $systemPath = $driveRoot + $systemName
    if ($target.Equals($systemPath, [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($systemPath + '\', [StringComparison]::OrdinalIgnoreCase)) { return 'Protected system folder' }
  }
  $parts = $target -split '[\\/]'
  foreach ($part in $parts) {
    if ($options.skipCloud -and $part -like 'OneDrive*') { return 'Cloud folder excluded' }
    foreach ($exclude in $options.exclusions) {
      if ($part -ieq $exclude -or $target.Equals($exclude, [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($exclude.TrimEnd('\','/') + '\', [StringComparison]::OrdinalIgnoreCase)) { return 'Your exclusion' }
    }
  }
  return $null
}
$stack = [Collections.Generic.Stack[string]]::new()
try {
  if (UnsafeAncestor $options.root) { Emit @{type='skip';path=$options.root;reason='Linked, offline or cloud ancestor'}; exit 0 }
} catch { Emit @{type='error';path=$options.root;reason=$_.Exception.Message}; exit 0 }
if ($options.filePaths) { foreach ($candidate in $options.filePaths) { $stack.Push($candidate) } }
else { $stack.Push($options.root) }
while ($stack.Count -gt 0) {
  $target = $stack.Pop()
  try {
    $blocked = Blocked $target
    if ($blocked) { Emit @{type='skip';path=$target;reason=$blocked}; continue }
    if ($options.filePaths -and (UnsafeAncestor $target)) { Emit @{type='skip';path=$target;reason='Linked, offline or cloud ancestor'}; continue }
    $attrs = [IO.File]::GetAttributes((NativePath $target))
    if (([int]$attrs -band 0x441400) -ne 0) { Emit @{type='skip';path=$target;reason='Link, offline file or cloud placeholder'}; continue }
    if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) {
      Emit @{type='directory';path=$target}
      try { foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries((NativePath $target))) { $stack.Push($entry.Substring(4)) } }
      catch { Emit @{type='error';path=$target;reason=$_.Exception.Message} }
    } else { Emit @{type='file';path=$target} }
  } catch { Emit @{type='error';path=$target;reason=$_.Exception.Message} }
}
