param(
    [Parameter(Mandatory = $true)]
    [string]$AppPath,

    [Parameter(Mandatory = $false)]
    [string]$ReportPath = "",

    [Parameter(Mandatory = $false)]
    [ValidateRange(30, 600)]
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

$resolvedAppPath = (Resolve-Path -LiteralPath $AppPath).Path
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path ([System.IO.Path]::GetTempPath()) "OpenStudio_WindowLifecycleHarness.json"
}

$reportDirectory = Split-Path -Parent $ReportPath
if (-not [string]::IsNullOrWhiteSpace($reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}

if (Test-Path -LiteralPath $ReportPath) {
    Remove-Item -LiteralPath $ReportPath -Force
}

$arguments = @(
    "--window-lifecycle-harness",
    "--report",
    ('"{0}"' -f $ReportPath)
)

Write-Host "Running native window lifecycle smoke test: $resolvedAppPath"
$process = Start-Process -FilePath $resolvedAppPath -ArgumentList $arguments -PassThru

try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "Window lifecycle smoke test timed out after $TimeoutSeconds seconds."
    }

    if ($process.ExitCode -ne 0) {
        throw "Window lifecycle smoke test process exited with code $($process.ExitCode)."
    }

    if (-not (Test-Path -LiteralPath $ReportPath)) {
        throw "Window lifecycle smoke test did not write its report: $ReportPath"
    }

    $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    if ($report.harnessMode -ne "window_lifecycle") {
        throw "Unexpected window lifecycle report type: '$($report.harnessMode)'."
    }

    if ($report.success -ne $true) {
        $failedChecks = @($report.checks | Where-Object { $_.status -eq "fail" })
        $failedSummary = ($failedChecks | ForEach-Object { "$($_.id): $($_.detail)" }) -join "; "
        throw "Window lifecycle smoke test reported failure. $failedSummary"
    }

    $requiredReadyChecks = @(
        "main_frontend_ready",
        "mixer_frontend_ready",
        "mixer_reopened_frontend_ready",
        "midi_frontend_ready",
        "midi_reopened_frontend_ready",
        "plugin_frontend_ready",
        "plugin_reopened_frontend_ready"
    )

    $passedIds = @($report.checks | Where-Object { $_.status -eq "pass" } | ForEach-Object { $_.id })
    $missingReadyChecks = @($requiredReadyChecks | Where-Object { $_ -notin $passedIds })
    if ($missingReadyChecks.Count -gt 0) {
        throw "Window lifecycle report omitted successful frontend-ready checks: $($missingReadyChecks -join ', ')."
    }

    Write-Host "Window lifecycle smoke test passed. Report: $ReportPath"
}
finally {
    $process.Dispose()
}
