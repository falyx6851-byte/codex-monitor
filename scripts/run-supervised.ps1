param(
    [int]$Port = 4127,
    [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$logPath = Join-Path $dataDir 'server.log'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$env:CODEX_TOKEN_MONITOR_PORT = [string]$Port
$env:CODEX_TOKEN_MONITOR_HOST = $HostName
Set-Location -LiteralPath $root

# Keep Node attached to the scheduled task so Windows owns its lifetime.
# Only start when the port is free; never terminate an unrelated listener.
while ($true) {
    $client = New-Object System.Net.Sockets.TcpClient
    $listening = $false
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($pending.AsyncWaitHandle.WaitOne(500)) {
            $client.EndConnect($pending)
            $listening = $true
        }
    } catch {
        $listening = $false
    } finally {
        $client.Close()
    }
    if (-not $listening) {
        Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) supervisor starting Node"
        try {
            & $nodePath --no-warnings (Join-Path $root 'server.js') >> $logPath 2>&1
            Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) Node exited code=$LASTEXITCODE; retry in 5s"
        } catch {
            Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) Node failed: $($_.Exception.Message); retry in 5s"
        }
    }
    Start-Sleep -Seconds 5
}
