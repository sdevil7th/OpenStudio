param(
    [string]$AppPath = "build/OpenStudio_artefacts/Debug/OpenStudio.exe",
    [string]$ReportPath = "output/free-plugin-regression.json",
    [string]$CaseName = ""
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$application = if ([IO.Path]::IsPathRooted($AppPath)) { $AppPath } else { Join-Path $workspace $AppPath }
$report = if ([IO.Path]::IsPathRooted($ReportPath)) { $ReportPath } else { Join-Path $workspace $ReportPath }
$fixtures = Join-Path $workspace 'tests/fixtures/free-plugins/legacy'
if (-not (Test-Path -LiteralPath $application -PathType Leaf)) { throw "Build the Debug app first: $application" }
# Start-Process joins arguments into a Windows command line; quote paths with spaces.
$arguments = @('--free-plugin-regression-headless', '--report', ('"' + $report + '"'), '--fixtures', ('"' + $fixtures + '"'))
if ($CaseName) { $arguments += @('--case', ('"' + $CaseName + '"')) }
$process = Start-Process -FilePath $application -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Free-plugin regression failed (exit $($process.ExitCode)); inspect $report" }
$result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
if (-not $result.overallPass) { throw "Free-plugin regression reported failure: $report" }
Write-Output "PASS: $($result.checks.Count) checks. Audio quality: not_asserted. Report: $report"
if ($CaseName) { Write-Output "Selected group only: $CaseName. Full suite: not_asserted." }
