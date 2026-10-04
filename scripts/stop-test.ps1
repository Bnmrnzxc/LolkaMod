$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expected = Join-Path $taskRoot '.runtime\desktop\Lolka.exe'
$testProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Lolka.exe'" | Where-Object ExecutablePath -eq $expected)
foreach ($testProcess in $testProcesses) { Stop-Process -Id $testProcess.ProcessId -ErrorAction SilentlyContinue }
@{ stoppedTestProcesses = $testProcesses.Count; executable = $expected } | ConvertTo-Json -Compress
