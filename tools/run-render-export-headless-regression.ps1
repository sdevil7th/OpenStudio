param(
    [string]$AppPath,
    [string]$OutputRoot,
    [string]$Label = "render-export-regression",
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",
    [int]$TimeoutSeconds = 180,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-AppPath {
    if ($AppPath -and (Test-Path -LiteralPath $AppPath)) {
        return (Resolve-Path -LiteralPath $AppPath).Path
    }

    $candidates = @(
        (Join-Path $repoRoot "build\OpenStudio_artefacts\$Configuration\OpenStudio.exe"),
        (Join-Path $repoRoot "build-check\OpenStudio_artefacts\$Configuration\OpenStudio.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "OpenStudio.exe not found. Build first or pass -AppPath."
}

if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot "build") --config $Configuration
    if ($LASTEXITCODE -ne 0) {
        throw "$Configuration build failed."
    }
}

$root = if ($OutputRoot) {
    $OutputRoot
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) "OpenStudio-render-export-runs"
}
$safeLabel = $Label -replace '[^A-Za-z0-9._-]', '_'
$runDirectory = Join-Path $root ("{0}_{1}" -f (Get-Date -Format "yyyyMMdd_HHmmss"), $safeLabel)
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$reportPath = Join-Path $runDirectory "render_export_regression_result.json"
$resolvedAppPath = Resolve-AppPath

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $resolvedAppPath
$startInfo.Arguments = "--render-export-regression-headless --output-dir `"$runDirectory`" --report `"$reportPath`""
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$process = [System.Diagnostics.Process]::Start($startInfo)
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "Render/export headless regression timed out after $TimeoutSeconds seconds."
}

if (-not (Test-Path -LiteralPath $reportPath)) {
    throw "Render/export regression did not write its result: $reportPath"
}

$result = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
Write-Host "Render/export regression result: $reportPath"
Write-Host "Objective gate status: $($result.objectiveGateStatus)"
foreach ($check in $result.checks) {
    Write-Host ("[{0}] {1} - {2}" -f $check.status, $check.id, $check.detail)
}

if ($process.ExitCode -ne 0 -or $result.objectiveGateStatus -ne "pass") {
    exit 2
}
exit 0
