param(
    [switch]$SkipFrontend,
    [string]$OriginalFile,
    [string]$ReferenceFile,
    [string]$CandidateFile,
    [double]$WindowStart = 0.0,
    [double]$WindowEnd = 0.0,
    [int]$SampleRate = 48000
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $repoRoot "frontend"

Write-Host "[regression] Building native target..."
cmake --build (Join-Path $repoRoot "build") --config Debug --target OpenStudio

if (-not $SkipFrontend) {
    Write-Host "[regression] Building frontend..."
    Push-Location $frontendRoot
    try {
        npm.cmd run build
    }
    finally {
        Pop-Location
    }
}

Write-Host "[regression] Build gates complete."
Write-Host "[regression] For the in-app backend suite, call nativeBridge.runAutomatedRegressionSuite() from the native frontend shell."

if ($OriginalFile -and $ReferenceFile -and $CandidateFile) {
    $pythonExe = Join-Path $repoRoot "tools\python\python.exe"
    $compareScript = Join-Path $repoRoot "tools\reference_audio_match.py"

    if (-not (Test-Path $pythonExe)) {
        throw "Bundled Python runtime not found at $pythonExe"
    }
    if (-not (Test-Path $compareScript)) {
        throw "Reference comparison script not found at $compareScript"
    }

    $args = @(
        $compareScript,
        "--original", $OriginalFile,
        "--reference", $ReferenceFile,
        "--candidate", $CandidateFile,
        "--sample-rate", $SampleRate
    )

    if ($WindowEnd -gt $WindowStart) {
        $args += @("--window-start", $WindowStart, "--window-end", $WindowEnd)
    }

    Write-Host "[regression] Running reference audio comparison..."
    & $pythonExe @args
}
