param(
    [switch]$SkipFrontend
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
