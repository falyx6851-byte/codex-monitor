param(
    [int]$Port = 4127,
    [string]$HostName = "127.0.0.1"
)

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$pidPath = Join-Path $dataDir "server.pid"
$logPath = Join-Path $dataDir "server.log"

function Test-LocalPort {
    param([int]$PortValue)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect("127.0.0.1", $PortValue, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (Test-Path -LiteralPath $pidPath) {
    $oldPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid -and (Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue)) {
        if (Test-LocalPort -PortValue $Port) {
            Write-Output "Already running at http://127.0.0.1:$Port"
            exit 0
        }
    }
}

if (Test-LocalPort -PortValue $Port) {
    Write-Output "Port $Port is already listening. Open http://127.0.0.1:$Port"
    exit 0
}

$escapedRoot = $root.Replace("'", "''")
$escapedLog = $logPath.Replace("'", "''")
$cmd = @"
`$env:CODEX_TOKEN_MONITOR_PORT='$Port'
`$env:CODEX_TOKEN_MONITOR_HOST='$HostName'
Set-Location -LiteralPath '$escapedRoot'
node --no-warnings .\server.js *> '$escapedLog'
"@

$proc = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $cmd) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru

Set-Content -LiteralPath $pidPath -Value ([string]$proc.Id) -Encoding ASCII
Start-Sleep -Milliseconds 700
Write-Output "Started http://127.0.0.1:$Port pid=$($proc.Id)"
