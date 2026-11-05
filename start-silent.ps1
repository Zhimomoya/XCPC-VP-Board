param(
    [ValidateRange(1, 65535)][int]$Port = 8770,
    [switch]$DebugMode
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $projectDir 'data\logs'
$pidFile = Join-Path $projectDir "data\server-windows-$Port.pid"
$stdoutLog = Join-Path $logDir "server-windows-$Port.log"
$stderrLog = Join-Path $logDir "server-windows-$Port.error.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

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

function Test-ScoreboardProcess([int]$ProcessId) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
    $identity = Get-ScoreboardIdentity
    if ($identity -and $identity.process_id) {
        return $identity.process_id -eq $ProcessId -and $identity.project_root -eq $projectDir
    }
    # Older services do not expose their process identity.
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

# Resolve install-manager aliases to the interpreter that actually owns the server.
$interpreter = (& $python.Source -c 'import sys; print(sys.executable)' | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or -not $interpreter -or -not (Test-Path -LiteralPath $interpreter.Trim())) {
    throw 'Could not locate the Python interpreter. Verify that python --version works.'
}
$interpreter = $interpreter.Trim()
$windowless = Join-Path (Split-Path -Parent $interpreter) 'pythonw.exe'
if (Test-Path -LiteralPath $windowless) { $interpreter = $windowless }

$serverScript = Join-Path $projectDir 'server.py'
$arguments = @('-u', ('"{0}"' -f $serverScript), '--lan', '--port', [string]$Port, '--log-dir', ('"{0}"' -f $logDir))
if ($DebugMode) { $arguments += '--debug' }

$process = Start-Process -FilePath $interpreter `
    -ArgumentList $arguments `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden `
    -PassThru

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
    if ($process.HasExited) { break }
    $identity = Get-ScoreboardIdentity
    if ($identity -and $identity.process_id -eq $process.Id -and $identity.project_root -eq $projectDir) {
        $ready = $true
        break
    }
}
if (-not $ready) {
    $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Encoding UTF8 -Tail 30) -join [Environment]::NewLine } else { '' }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw "Scoreboard server failed to start. $details"
}

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Write-Host "Scoreboard server started silently: http://127.0.0.1:$Port (PID $($process.Id))"
Write-Host "Log: $stdoutLog"
