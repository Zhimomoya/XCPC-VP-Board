param(
    [int]$Port = 8770,
    [switch]$DebugMode
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $projectDir 'data\logs'
$pidFile = Join-Path $projectDir "data\server-windows-$Port.pid"
$stdoutLog = Join-Path $logDir "server-windows-$Port.log"
$stderrLog = Join-Path $logDir "server-windows-$Port.error.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-ScoreboardProcess([int]$ProcessId) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $processInfo) { return $false }

    $commandLine = [string]$processInfo.CommandLine
    if ($processInfo.Name -notmatch '^python(?:w)?(?:\.exe)?$' -or $commandLine -notmatch '(^|[\\/\s"])server\.py([\s"]|$)') {
        return $false
    }

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $ProcessId } |
        Select-Object -First 1
    return [bool]$listener
}

if (Test-Path -LiteralPath $pidFile) {
    $savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($savedPid -match '^\d+$' -and (Test-ScoreboardProcess ([int]$savedPid))) {
        Write-Host "Scoreboard server is already running (PID $savedPid, port $Port)."
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python was not found. Verify that python --version works.' }

$arguments = @('server.py', '--lan', '--port', [string]$Port)
if ($DebugMode) { $arguments += '--debug' }

$process = Start-Process -FilePath $python.Source `
    -ArgumentList $arguments `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    if ($process.HasExited) { break }
    if (Test-ScoreboardProcess $process.Id) {
        $ready = $true
        break
    }
}
if (-not $ready) {
    $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Raw).Trim() } else { '' }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw "Scoreboard server failed to start. $details"
}

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Write-Host "Scoreboard server started silently: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Log: $stdoutLog"
