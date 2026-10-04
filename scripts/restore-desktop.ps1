param([string]$Installation = (Join-Path $env:LOCALAPPDATA 'Programs\Lolka'))
$ErrorActionPreference = 'Stop'
$installationRoot = [IO.Path]::GetFullPath($Installation)
$exe = Join-Path $installationRoot 'Lolka.exe'
if (Get-CimInstance Win32_Process -Filter "Name = 'Lolka.exe'" | Where-Object ExecutablePath -eq $exe) { throw 'Close Lolka before restoring.' }
$resources = Join-Path $installationRoot 'resources'
$original = Join-Path $resources '_app.asar'
$archive = Join-Path $resources 'app.asar'
$manifestPath = Join-Path $resources 'lolkamod\install.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expected = $manifest.originalHash
if ($expected -notmatch '^[a-f0-9]{64}$' -or $manifest.shimHash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid installation manifest' }
if (Test-Path -LiteralPath (Join-Path $resources '.lolkamod-transaction.json')) { throw 'Interrupted transaction: use the installer to recover it first.' }
foreach ($checkedPath in @($original, $archive, $manifestPath)) { if ((Get-Item -LiteralPath $checkedPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked restore paths are unsupported.' } }
if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Original backup integrity mismatch' }
$current = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($current -ne $manifest.shimHash -and $current -ne $expected) { throw 'Current archive changed. Refusing to restore an old backup over another version.' }
$stagedArchive = Join-Path $resources ('.lolkamod-restore-' + [Guid]::NewGuid().ToString() + '.tmp')
$replacedArchive = Join-Path $resources ('.lolkamod-replaced-' + [Guid]::NewGuid().ToString() + '.tmp')
try {
  Copy-Item -LiteralPath $original -Destination $stagedArchive
  if ((Get-FileHash -LiteralPath $stagedArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Staged restore integrity mismatch' }
  [IO.File]::Replace($stagedArchive, $archive, $replacedArchive)
} finally {
  if (Test-Path -LiteralPath $stagedArchive) { Remove-Item -LiteralPath $stagedArchive }
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Restore verification failed' }
if (Test-Path -LiteralPath $replacedArchive) { Remove-Item -LiteralPath $replacedArchive }
Write-Output 'Original app.asar restored. Backup, settings and inactive mod files retained; run uninstall for cleanup.'
