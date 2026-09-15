param([string]$StopScript,[string]$Sandbox)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path "$Sandbox/scripts" -Force | Out-Null
Copy-Item -LiteralPath $StopScript -Destination "$Sandbox/scripts/stop.ps1"
Copy-Item -LiteralPath (Join-Path (Split-Path $StopScript -Parent) 'process-identity.ps1') -Destination "$Sandbox/scripts/process-identity.ps1"
Set-Content -LiteralPath (Join-Path $Sandbox 'server.js') -Value '// Test identity only'
$global:monitorTestStops=@()
$global:monitorTestCommand='node.exe C:\unrelated-app\server.js'
function Get-ScheduledTask { param($TaskName,$ErrorAction) return $null }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) return [pscustomobject]@{ProcessId=424242;Name='node.exe';CommandLine=$global:monitorTestCommand} }
function Get-NetTCPConnection { param($LocalAddress,$LocalPort,$State,$ErrorAction) return [pscustomobject]@{OwningProcess=424242} }
function Stop-Process { param($Id,[switch]$Force,$ErrorAction) $global:monitorTestStops+=$Id }
& "$Sandbox/scripts/stop.ps1" -Port 49999 -TaskName 'MockOnly' | Out-Null
if ($global:monitorTestStops.Count -ne 0) { throw 'Stopped an unrelated process' }
$global:monitorTestCommand='node.exe --no-warnings "'+(Join-Path $Sandbox 'server.js')+'"'
& "$Sandbox/scripts/stop.ps1" -Port 49999 -TaskName 'MockOnly' | Out-Null
if ($global:monitorTestStops.Count -eq 0) { throw 'Did not stop the matching monitor process' }
Write-Output 'Both process identity checks passed; no real process was stopped.'
