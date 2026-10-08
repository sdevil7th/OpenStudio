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

$previousPackagedUI = $env:OPENSTUDIO_FORCE_PACKAGED_UI
$env:OPENSTUDIO_FORCE_PACKAGED_UI = '1'
Write-Host "Running native window lifecycle smoke test: $resolvedAppPath"
$startOptions = @{ FilePath = $resolvedAppPath; ArgumentList = $arguments; PassThru = $true }
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $startOptions.WindowStyle = 'Hidden'
}
$process = Start-Process @startOptions

try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw "Window lifecycle smoke test timed out after $TimeoutSeconds seconds."
    }

    if (-not (Test-Path -LiteralPath $ReportPath)) {
        if ($process.ExitCode -ne 0) {
            throw "Window lifecycle smoke test process exited with code $($process.ExitCode) and did not write its report: $ReportPath"
        }
        throw "Window lifecycle smoke test did not write its report: $ReportPath"
    }

    $reportText = Get-Content -LiteralPath $ReportPath -Raw
    try {
        $report = $reportText | ConvertFrom-Json
    }
    catch {
        Write-Host "Invalid window lifecycle report content:"
        Write-Host $reportText
        throw "Window lifecycle smoke test wrote invalid JSON: $($_.Exception.Message)"
    }

    if ($report.harnessMode -ne "window_lifecycle") {
        throw "Unexpected window lifecycle report type: '$($report.harnessMode)'."
    }

    if ($report.success -ne $true) {
        Write-Host "Failed window lifecycle report:"
        Write-Host $reportText
        $failedChecks = @($report.checks | Where-Object { $_.status -eq "fail" })
        $failedSummary = ($failedChecks | ForEach-Object { "$($_.id): $($_.detail)" }) -join "; "
        throw "Window lifecycle smoke test reported failure. $failedSummary"
    }

    if ($process.ExitCode -ne 0) {
        Write-Host "Window lifecycle report:"
        Write-Host $reportText
        throw "Window lifecycle smoke test process exited with code $($process.ExitCode) after reporting success."
    }

    $requiredChecks = @(
        "no_orphan_secondary_browser_components",
        "main_frontend_ready",
        "main_native_chrome",
        "main_move_resize",
        "main_bounds_stable",
        "main_restore_geometry",
        "mixer_frontend_ready",
        "mixer_native_move_resize",
        "mixer_bounds_stable",
        "mixer_reopened_frontend_ready",
        "pitch_analysis_hydrated",
        "pitch_cycle_1_interactive_ready",
        "pitch_cycle_2_interactive_ready",
        "pitch_native_move_resize",
        "pitch_checkpoint_preserved",
        "pitch_native_relative_shift_committed",
        "pitch_native_correction_file_published",
        "pitch_native_undo_preserved",
        "pitch_owner_loss_retains_checkpoint",
        "midi_frontend_ready",
        "midi_native_move_resize",
        "midi_bounds_stable",
        "midi_reopened_frontend_ready",
        "plugin_frontend_ready",
        "plugin_editor_geometry_contract",
        "plugin_compact_native_resize",
        "plugin_compact_bounds_stable",
        "plugin_restore_preferred_geometry",
        "plugin_native_move_resize",
        "plugin_bounds_stable",
        "plugin_reopened_frontend_ready",
        "plugin_track_failed_removal_keeps_editor",
        "plugin_input_failed_removal_keeps_editor",
        "plugin_master_failed_removal_keeps_editor",
        "plugin_monitor_failed_removal_keeps_editor",
        "plugin_track_removal_closes_editor",
        "plugin_input_removal_closes_editor",
        "plugin_master_removal_closes_editor",
        "plugin_monitor_removal_closes_editor",
        "plugin_track_delete_cancels_queued_reopen",
        "plugin_removed_editor_stays_closed"
    )

    $passedIds = @($report.checks | Where-Object { $_.status -eq "pass" } | ForEach-Object { $_.id })
    $missingChecks = @($requiredChecks | Where-Object { $_ -notin $passedIds })
    if ($missingChecks.Count -gt 0) {
        throw "Window lifecycle report omitted successful required checks: $($missingChecks -join ', ')."
    }

    Write-Host "Window lifecycle smoke test passed. Report: $ReportPath"
}
finally {
    $env:OPENSTUDIO_FORCE_PACKAGED_UI = $previousPackagedUI
    $process.Dispose()
}
