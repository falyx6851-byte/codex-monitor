param(
    [int]$Port = 4127,
    [string]$HostName = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$pidPath = Join-Path $dataDir 'server.pid'
$serverPath = Join-Path $root 'server.js'
. (Join-Path $PSScriptRoot 'process-identity.ps1')
$listener = Get-NetTCPConnection -LocalAddress $HostName -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
    if (Test-MonitorProcess $existing $serverPath) {
        Write-Output "Already running at http://${HostName}:$Port pid=$($existing.ProcessId)"
        exit 0
    }
    throw "Port $Port is occupied by another application."
}
$env:CODEX_TOKEN_MONITOR_PORT = [string]$Port
$env:CODEX_TOKEN_MONITOR_HOST = $HostName
$node = (Get-Command node.exe -ErrorAction Stop).Source
$proc = Start-Process -FilePath $node -ArgumentList @('--no-warnings', ('"' + $serverPath + '"')) `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')
Set-Content -LiteralPath $pidPath -Value ([string]$proc.Id) -Encoding ASCII
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($proc.HasExited) { throw "Monitor exited with code $($proc.ExitCode). See data/server-error.log." }
    try {
        $health = Invoke-RestMethod -Uri "http://${HostName}:$Port/api/health" -TimeoutSec 1
        if ($health.ok -and $health.pid -eq $proc.Id) {
            Write-Output "Started http://${HostName}:$Port pid=$($proc.Id)"
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 200
    $proc.Refresh()
}
throw 'Monitor started but the health check did not complete; inspect data/server-error.log.'
