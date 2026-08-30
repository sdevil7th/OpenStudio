param(
    [ValidateSet("Debug", "Release")]
    [string] $Configuration = "Debug",
    [string] $ReportPath = ""
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $repositoryRoot "build\OpenStudio_artefacts\$Configuration\OpenStudio.exe"

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "OpenStudio executable not found: $executable"
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $repositoryRoot "build\plugin_scan_regression_$($Configuration.ToLowerInvariant()).json"
}

$resolvedReportPath = [System.IO.Path]::GetFullPath($ReportPath)
$process = Start-Process `
    -FilePath $executable `
    -ArgumentList @(
        "--plugin-scan-regression-headless",
        "--report",
        "`"$resolvedReportPath`""
    ) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
$exitCode = $process.ExitCode

if (Test-Path -LiteralPath $resolvedReportPath -PathType Leaf) {
    Get-Content -LiteralPath $resolvedReportPath -Raw
}

exit $exitCode
