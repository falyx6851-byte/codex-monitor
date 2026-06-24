param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsForNode
)

$script = Join-Path $PSScriptRoot "codex-token-report.mjs"
node $script @ArgsForNode
