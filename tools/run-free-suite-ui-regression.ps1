param(
    [string]$AppPath = "build/OpenStudio_artefacts/Debug/OpenStudio.exe",
    [ValidateRange(1024, 65535)][int]$Port = 5195
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$reportDirectory = Join-Path $workspace 'output/review/free-suite-ui'
$report = Join-Path $reportDirectory 'editor-schemas.json'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

# Build the current source before invoking this wrapper. The headless exporter
# supplies native parameter contracts; the browser bridge does not process audio.
if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force }
& (Join-Path $PSScriptRoot 'run-free-plugin-headless-regression.ps1') -AppPath $AppPath -ReportPath $report -CaseName 'editor-schemas'
if (-not (Test-Path -LiteralPath $report -PathType Leaf)) { throw "Native editor schema export was not produced: $report" }
$previousSchema = $env:OPENSTUDIO_FREE_SUITE_SCHEMAS
$previousPort = $env:OPENSTUDIO_E2E_PORT
try {
    $env:OPENSTUDIO_FREE_SUITE_SCHEMAS = $report
    $env:OPENSTUDIO_E2E_PORT = [string]$Port
    Push-Location (Join-Path $workspace 'frontend')
    try {
        # Windows PowerShell 5 wraps redirected native stderr in ErrorRecords.
        # Keep warnings/logs visible and judge the test process by its exit code.
        # setup-node and the system installation may both be on PATH. Preserve
        # PATH priority and invoke one executable, not an array of command paths.
        $npmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $previousErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            # Native commands update the global automatic variable even when
            # this wrapper is invoked from another script (as it is in CI).
            $global:LASTEXITCODE = $null
            & $npmPath exec -- playwright test e2e/free-suite-design03.spec.ts e2e/free-suite-effects.spec.ts e2e/free-suite-precision.spec.ts e2e/release-review-ui.spec.ts --project=chromium
            $browserExitCode = $global:LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousErrorAction }
        if ($null -eq $browserExitCode -or $browserExitCode -ne 0) { throw "Free-suite browser regression failed (exit $browserExitCode). See output/playwright/test-results." }
    }
    finally { Pop-Location }
}
finally {
    $env:OPENSTUDIO_FREE_SUITE_SCHEMAS = $previousSchema
    $env:OPENSTUDIO_E2E_PORT = $previousPort
}
