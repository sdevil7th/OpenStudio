param(
    [Parameter(Mandatory = $true)][string]$ProjectFixturePath,
    [switch]$ExerciseNativeFrontend,
    [switch]$SkipBuild,
    [ValidateRange(30, 600)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
if (-not $ExerciseNativeFrontend) { throw 'This integration fixture opens a native frontend window. Opt in with -ExerciseNativeFrontend.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$fixture = (Resolve-Path -LiteralPath $ProjectFixturePath).Path
$run = Join-Path $repoRoot ('output/review/automation-editor-flush-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $run | Out-Null
if (-not $SkipBuild) {
    Push-Location (Join-Path $repoRoot 'frontend')
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' } } finally { Pop-Location }
    & cmake --build (Join-Path $repoRoot 'build') --config Debug
    if ($LASTEXITCODE -ne 0) { throw 'Debug build failed' }
}
$jobPath = Join-Path $run 'job.json'
$resultPath = Join-Path $run 'result.json'
@{ jobType='automation_editor_flush'; projectFixturePath=$fixture; sourceAudioPath=''; clipId=''; resultJsonPath=$resultPath } |
    ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $jobPath
$app = Join-Path $repoRoot 'build/OpenStudio_artefacts/Debug/OpenStudio.exe'
$process = Start-Process -FilePath $app -ArgumentList @('--pitch-regression', ('"' + $jobPath + '"')) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill(); throw "Native frontend integration timed out: $run" }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Native frontend did not report a result: $run" }
    $report = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    if ($process.ExitCode -ne 0 -or -not $report.success) { throw "Native frontend integration failed: $resultPath" }
    Write-Output "Automation editor flush: $($report.automationEditorChecks.Count) checks passed. Evidence: $run"
} finally { $process.Dispose() }
