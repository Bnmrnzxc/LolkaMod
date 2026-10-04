param([string]$Source = (Join-Path $env:LOCALAPPDATA 'Programs\Lolka'))
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $taskRoot '.runtime'
$destination = Join-Path $runtimeRoot 'desktop'
if ([IO.Path]::GetFullPath($destination) -ne (Join-Path $taskRoot '.runtime\desktop')) { throw 'Unexpected destination' }
if (Test-Path -LiteralPath $destination) { throw 'Runtime already exists; refusing to overwrite.' }
$originalHash = (Get-FileHash -LiteralPath (Join-Path $Source 'resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($originalHash -ne 'fd94ecec264d7d7a56a0b5d1bb5ac1e416b6c9a4ee2d171b3704b0b72f0260a8') { throw 'Unsupported original archive' }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Copy-Item -LiteralPath $Source -Destination $destination -Recurse
$sourceFiles = @(Get-ChildItem -LiteralPath $Source -File -Recurse)
$copiedFiles = @(Get-ChildItem -LiteralPath $destination -File -Recurse)
if ($sourceFiles.Count -ne $copiedFiles.Count) { throw 'Copy file-count mismatch' }
foreach ($sourceFile in $sourceFiles) {
  $relative = [IO.Path]::GetRelativePath($Source, $sourceFile.FullName)
  $copiedFile = Join-Path $destination $relative
  if ((Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copiedFile -Algorithm SHA256).Hash) { throw "Copy hash mismatch: $relative" }
}
$manifest = @{ source = $Source; destination = $destination; files = $sourceFiles.Count; bytes = ($sourceFiles | Measure-Object Length -Sum).Sum; originalHash = $originalHash; verified = $true }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'copy-manifest.json') -Encoding utf8NoBOM
$manifest | ConvertTo-Json -Compress
