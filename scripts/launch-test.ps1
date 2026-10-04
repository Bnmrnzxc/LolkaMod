param([int]$Port = 19321, [switch]$Disable)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $taskRoot '.runtime'
$exe = Join-Path $runtimeRoot 'desktop\Lolka.exe'
if (Get-CimInstance Win32_Process -Filter "Name = 'Lolka.exe'" | Where-Object ExecutablePath -eq $exe) { throw 'Test Lolka is already running' }
New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'logs') -Force | Out-Null
$env:ELECTRON_ENABLE_LOGGING = '1'
$testArguments = @("--remote-debugging-port=$Port", '--remote-debugging-address=127.0.0.1')
if ($Disable) { $testArguments += '--lolkamod-disable' }
$testProcess = Start-Process -FilePath $exe -ArgumentList $testArguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'logs\stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'logs\stderr.log') -PassThru
Remove-Item Env:\ELECTRON_ENABLE_LOGGING
$testProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeRoot 'test.pid') -Encoding ascii
@{ pid = $testProcess.Id; executable = $exe; port = $Port } | ConvertTo-Json -Compress
