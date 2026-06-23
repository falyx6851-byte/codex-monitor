param(
    [string]$TaskName = "CodexTokenMonitor"
)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Removed startup task if it existed: $TaskName"
