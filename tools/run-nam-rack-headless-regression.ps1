param(
    [string]$AppPath,
    [string]$OutputRoot,
    [string]$Label = "nam-rack-regression",
    [int]$TimeoutSeconds = 90,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-AppPath {
    if ($AppPath -and (Test-Path $AppPath)) {
        return (Resolve-Path $AppPath).Path
    }

    $candidates = @(
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Debug\OpenStudio.exe"),
        (Join-Path $repoRoot "build-check\OpenStudio_artefacts\Release\OpenStudio.exe"),
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Release\OpenStudio.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    throw "OpenStudio.exe not found. Build first or pass -AppPath."
}

function New-RunDirectory {
    $root = if ($OutputRoot) { $OutputRoot } else { Join-Path $repoRoot "tmp_nam_rack_runs" }
    $safeLabel = ($Label -replace '[^A-Za-z0-9._-]', '_')
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $dir = Join-Path $root "${stamp}_${safeLabel}"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot "build") --config Debug
    if ($LASTEXITCODE -ne 0) {
        throw "Debug build failed."
    }
}

$runDir = New-RunDirectory
$resultPath = Join-Path $runDir "nam_rack_regression_result.json"
$resolvedAppPath = Resolve-AppPath

$processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processStartInfo.FileName = $resolvedAppPath
$processStartInfo.Arguments = "--nam-rack-regression-headless `"$resultPath`""
$processStartInfo.UseShellExecute = $false
$processStartInfo.CreateNoWindow = $true
$processStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$process = [System.Diagnostics.Process]::Start($processStartInfo)
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "NAM rack headless regression timed out after $TimeoutSeconds seconds."
}
if ($process.ExitCode -ne 0) {
    Write-Warning "NAM rack headless regression exited with code $($process.ExitCode). Reading result if available."
}

if (-not (Test-Path $resultPath)) {
    throw "NAM rack headless regression did not write result JSON: $resultPath"
}

$result = Get-Content -Raw -Path $resultPath | ConvertFrom-Json
Write-Host "NAM rack regression result: $resultPath"
Write-Host "Objective gate status: $($result.objectiveGateStatus)"
Write-Host "Subjective quality: $($result.subjectiveQuality)"
Write-Host "Summary: $($result.summary)"

if ($result.checks) {
    $result.checks | ForEach-Object {
        Write-Host ("[{0}] {1} - {2}" -f $_.status, $_.id, $_.detail)
    }
}

if ($result.objectiveGateStatus -eq "fail") {
    exit 2
}
exit 0
