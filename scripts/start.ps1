param(
    [int]$Port = 4127,
    [string]$HostName = "127.0.0.1"
)

$root = Split-Path -Parent $PSScriptRoot
$env:CODEX_TOKEN_MONITOR_PORT = [string]$Port
$env:CODEX_TOKEN_MONITOR_HOST = $HostName
Set-Location -LiteralPath $root
node --no-warnings .\server.js
