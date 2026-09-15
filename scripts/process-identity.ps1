function Test-MonitorProcess {
    param($Process, [string]$ServerPath)
    if (-not $Process -or -not $Process.CommandLine -or $Process.Name -ne 'node.exe') {
        return $false
    }
    # FullPath expands existing Windows 8.3 names as well as normalizing separators.
    # Compare complete arguments so another project's server.js cannot match.
    $expected = [IO.Path]::GetFullPath($ServerPath)
    $arguments = [regex]::Matches($Process.CommandLine, '"[^"]*"|[^\s"]+')
    foreach ($argument in $arguments) {
        $candidate = $argument.Value.Trim('"').Replace('/', '\')
        if (-not [IO.Path]::IsPathRooted($candidate)) { continue }
        try {
            if ([string]::Equals([IO.Path]::GetFullPath($candidate), $expected,
                    [StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        } catch {
            # A non-path command-line argument is not process identity evidence.
        }
    }
    return $false
}
