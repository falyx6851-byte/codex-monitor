param(
    [int]$Port = 4127,
    [string]$TaskName = "CodexTokenMonitor"
)

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\start-hidden.ps1"
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Port $Port"

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Local Codex token monitor" -Force -ErrorAction Stop | Out-Null
Write-Output "Installed startup task: $TaskName"
