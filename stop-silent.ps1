param([ValidateRange(1, 65535)][int]$Port = 8770)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $projectDir "data\server-windows-$Port.pid"

function Get-ScoreboardIdentity {
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/host-info?identity=1")
        $request.Proxy = $null
        $request.Timeout = 1000
        $request.ReadWriteTimeout = 1000
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch {
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "No silent scoreboard process was recorded for port $Port."
    exit 0
}

$savedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($savedPid -match '^\d+$') {
    $savedProcessId = [int]$savedPid
    $process = Get-Process -Id $savedProcessId -ErrorAction SilentlyContinue
    $isScoreboard = $false
    if ($process) {
        $identity = Get-ScoreboardIdentity
        if ($identity -and $identity.process_id) {
            $isScoreboard = $identity.process_id -eq $savedProcessId -and $identity.project_root -eq $projectDir
        } else {
            # Retain support for a server started before the identity endpoint existed.
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId" -ErrorAction SilentlyContinue
            $commandLine = if ($processInfo) { [string]$processInfo.CommandLine } else { '' }
            $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.OwningProcess -eq $savedProcessId } |
                Select-Object -First 1
            $isScoreboard = $process.Name -match '^python(?:w)?$' -and
                $commandLine -match '(^|[\\/\s"])server\.py([\s"]|$)' -and [bool]$listener
        }
    }
    if ($isScoreboard) {
        Stop-Process -Id $process.Id
        $process.WaitForExit()
    } elseif ($process) {
        Write-Host "Removed a stale scoreboard PID record; PID $savedPid belongs to another process."
    }
}
Remove-Item -LiteralPath $pidFile -Force
if ($isScoreboard) { Write-Host "Scoreboard server on port $Port has stopped." }
