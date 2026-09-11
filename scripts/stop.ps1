param(
    [int]$Port = 4127,
    [string]$TaskName = "CodexTokenMonitor"
)

$root = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $root "data\server.pid"
$stopped = $false

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
        if ($proc -and $proc.CommandLine -and $proc.CommandLine.Contains($root)) {
            Stop-Process -Id $proc.ProcessId -Force
            $stopped = $true
        }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

$needle = (Join-Path $root "server.js").Replace("\", "\\")
$matches = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Replace("\", "\\").Contains($needle) }

foreach ($item in $matches) {
    if ($item.ProcessId -ne $PID) {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
}

$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $stopped = $true
    }
}

if ($stopped) {
    Write-Output "Stopped Codex Token Monitor."
} else {
    Write-Output "No Codex Token Monitor process found."
}
