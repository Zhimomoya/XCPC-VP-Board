param([int]$Port = 8770)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $projectDir "data\server-windows-$Port.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "No silent scoreboard process was recorded for port $Port."
    exit 0
}

$savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($savedPid -match '^\d+$') {
    $savedProcessId = [int]$savedPid
    $process = Get-Process -Id $savedProcessId -ErrorAction SilentlyContinue
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId" -ErrorAction SilentlyContinue
    $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { '' }
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $savedProcessId } |
        Select-Object -First 1
    $isScoreboard = $process -and $process.Name -match '^python(?:w)?$' -and
        $commandLine -match '(^|[\\/\s"])server\.py([\s"]|$)' -and [bool]$listener
    if ($isScoreboard) {
        Stop-Process -Id $process.Id
        $process.WaitForExit()
    } elseif ($process) {
        Write-Host "Removed a stale scoreboard PID record; PID $savedPid belongs to another process."
    }
}
Remove-Item -LiteralPath $pidFile -Force
if ($isScoreboard) { Write-Host "Scoreboard server on port $Port has stopped." }
