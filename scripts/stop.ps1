param(
    [int]$Port = 4127,
    [string]$TaskName = "CodexTokenMonitor"
)

$root = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $root "data\server.pid"
$stopped = $false
$serverPath = Join-Path $root 'server.js'
. (Join-Path $PSScriptRoot 'process-identity.ps1')

# Stop supervision first so it does not immediately restart Node.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $stopped = $true
}

if (Test-Path -LiteralPath $pidPath) {
    $oldPid = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldPid) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$oldPid)" -ErrorAction SilentlyContinue
        if (Test-MonitorProcess $proc $serverPath) {
            Stop-Process -Id $proc.ProcessId -Force
            $stopped = $true
        }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

$matches = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { Test-MonitorProcess $_ $serverPath }

foreach ($item in $matches) {
    if ($item.ProcessId -ne $PID) {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
}

$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (Test-MonitorProcess $proc $serverPath) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
}

if ($stopped) {
    Write-Output "Stopped Codex Token Monitor."
} else {
    Write-Output "No Codex Token Monitor process found."
}
