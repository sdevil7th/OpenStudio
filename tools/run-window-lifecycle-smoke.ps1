[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')]
    [string]$AppPath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Validate')]
    [switch]$ValidateOnly,

    [Parameter(Mandatory = $true, ParameterSetName = 'Validate')]
    [Parameter(ParameterSetName = 'Run')]
    [string]$ReportPath = '',

    [ValidateSet('normal', 'safe')]
    [string]$StartupMode = 'normal',

    [Parameter(ParameterSetName = 'Run')]
    [switch]$StaleRuntimeOverride,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$RequireStandardUser,

    [Parameter(ParameterSetName = 'Run')]
    [ValidateRange(30, 600)]
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

function Assert-LifecycleReport($Report, [string]$ExpectedMode) {
    if ($Report.harnessMode -ne 'window_lifecycle' -or $Report.success -isnot [bool] -or !$Report.success) {
        throw 'Native window lifecycle report did not report success.'
    }
    if ($Report.startupMode -ne $ExpectedMode) { throw "Expected startupMode '$ExpectedMode'." }
    if ($Report.offlineRequested -isnot [bool] -or !$Report.offlineRequested -or
        $Report.audioDeviceOpened -isnot [bool] -or $Report.audioDeviceOpened) {
        throw 'Lifecycle report must prove explicit offline startup with no audio device.'
    }
    foreach ($key in @('audioDeviceStartCount', 'audioCallbackCount')) {
        if ($Report.$key -isnot [ValueType] -or $Report.$key -is [bool] -or $Report.$key -ne 0) {
            throw "Missing or nonzero hardware evidence: $key."
        }
    }
    if (@($Report.checks | Where-Object { $_.status -eq 'fail' }).Count) {
        throw 'Native window lifecycle report contains failed checks.'
    }
    $required = @(
        'lifecycle_no_hardware_device_opened', 'no_orphan_secondary_browser_components',
        'main_frontend_ready', 'main_native_chrome', 'main_move_resize', 'main_bounds_stable', 'main_restore_geometry',
        'mixer_frontend_ready', 'mixer_native_move_resize', 'mixer_bounds_stable', 'mixer_reopened_frontend_ready',
        'pitch_native_move_resize', 'midi_frontend_ready', 'midi_native_move_resize', 'midi_bounds_stable', 'midi_reopened_frontend_ready',
        'plugin_frontend_ready', 'plugin_editor_geometry_contract', 'plugin_compact_native_resize', 'plugin_compact_bounds_stable',
        'plugin_restore_preferred_geometry', 'plugin_native_move_resize', 'plugin_bounds_stable', 'plugin_reopened_frontend_ready',
        'plugin_track_failed_removal_keeps_editor', 'plugin_input_failed_removal_keeps_editor',
        'plugin_master_failed_removal_keeps_editor', 'plugin_monitor_failed_removal_keeps_editor',
        'plugin_track_removal_closes_editor', 'plugin_input_removal_closes_editor',
        'plugin_master_removal_closes_editor', 'plugin_monitor_removal_closes_editor',
        'plugin_track_delete_cancels_queued_reopen', 'plugin_removed_editor_stays_closed'
    )
    $documents = @('main', 'mixer', 'mixer_reopened', 'midi', 'midi_reopened', 'plugin', 'plugin_reopened')
    if ($ExpectedMode -eq 'safe') {
        $required += @('pitch_safe_cycle_1_frontend_ready', 'pitch_safe_cycle_2_frontend_ready')
        $documents += @('pitch_safe_cycle_1', 'pitch_safe_cycle_2')
    } else {
        $required += @('pitch_analysis_hydrated', 'pitch_cycle_1_interactive_ready', 'pitch_cycle_2_interactive_ready',
            'pitch_checkpoint_preserved', 'pitch_native_relative_shift_committed', 'pitch_native_correction_file_published',
            'pitch_native_undo_preserved', 'pitch_owner_loss_retains_checkpoint')
        $documents += @('pitch_cycle_1', 'pitch_cycle_2')
    }
    $passed = @($Report.checks | Where-Object { $_.status -eq 'pass' } | ForEach-Object { $_.id })
    $missing = @($required | Where-Object { $_ -notin $passed })
    if ($missing.Count) { throw "Missing successful lifecycle checks: $($missing -join ', ')." }
    foreach ($role in $documents) {
        $evidence = @($Report.frontendDocuments | Where-Object { $_.role -eq $role })
        if ($evidence.Count -ne 1 -or $evidence[0].documentRequests -isnot [ValueType] -or
            $evidence[0].documentRequests -is [bool] -or $evidence[0].documentRequests -ne 1 -or $evidence[0].startupState -ne 'ready') {
            throw "Missing single ready frontend document: $role."
        }
    }
    $preflight = $Report.startupSelfTest
    foreach ($key in @('shellReady', 'browserBackendSupported', 'packagedFrontendPresent')) {
        if ($preflight.$key -isnot [bool] -or !$preflight.$key) {
            throw "Packaged shell/browser preflight is not ready: $key."
        }
    }
    if ($onWindows) {
        if ($preflight.browserBackend -ne 'webview2') { throw 'Windows lifecycle must use WebView2.' }
        if ([string]::IsNullOrWhiteSpace($Report.executablePath) -or
            [string]::IsNullOrWhiteSpace($preflight.webView2UserDataPath)) {
            throw 'Missing executable or WebView2 user-data path evidence.'
        }
        $install = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Report.executablePath)).TrimEnd('\')
        $userData = [IO.Path]::GetFullPath($preflight.webView2UserDataPath).TrimEnd('\')
        foreach ($key in @('browserExecutableFolderOverride', 'userDataFolderOverride')) {
            if ($Report.$key -isnot [string]) { throw "Missing WebView2 process override evidence: $key." }
        }
        $effectiveUserData = if ([string]::IsNullOrWhiteSpace($Report.userDataFolderOverride)) {
            $userData
        } else { [IO.Path]::GetFullPath($Report.userDataFolderOverride).TrimEnd('\') }
        foreach ($candidate in @($userData, $effectiveUserData)) {
            if ($candidate.Equals($install, [StringComparison]::OrdinalIgnoreCase) -or
                $candidate.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'WebView2 user data resolves inside the installation directory.'
            }
        }
    }
}

function Read-LifecycleReport([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing window lifecycle report: $Path" }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "Invalid window lifecycle report JSON: $($_.Exception.Message)" }
}

if ($ValidateOnly) {
    Assert-LifecycleReport (Read-LifecycleReport $ReportPath) $StartupMode
    Write-Output "Window lifecycle report validated ($StartupMode): $ReportPath"
    return
}

# Use the same normalization as the reported executable below: on Windows,
# Resolve-Path alone can retain an 8.3 alias which GetFullPath expands.
$resolvedAppPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $AppPath).Path)
# Reject older executables before launching: unknown flags are ignored by them,
# which could otherwise reopen the user's saved low-buffer ASIO device.
$binary = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($resolvedAppPath))
if (!$binary.Contains('--window-lifecycle-offline')) {
    throw 'This executable predates the hardware-free lifecycle flag. Rebuild before running this harness.'
}
$binary = $null
if ($StaleRuntimeOverride -and !$onWindows) { throw 'Stale WebView2 runtime injection is Windows-only.' }
$standardUser = $null
if ($onWindows) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $standardUser = !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if ($RequireStandardUser -and $standardUser -ne $true) { throw 'Run this qualification from a non-elevated Windows process.' }
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path ([IO.Path]::GetTempPath()) ('OpenStudio_WindowLifecycle_' + [guid]::NewGuid().ToString('N') + '.json')
}
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
if ($ReportPath -eq $resolvedAppPath) { throw 'ReportPath must not replace the executable.' }
$reportDirectory = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
if (Test-Path -LiteralPath $ReportPath) { Remove-Item -LiteralPath $ReportPath -Force }
$arguments = @('--window-lifecycle-harness', '--window-lifecycle-offline', '--report', $ReportPath)
if ($StartupMode -eq 'safe') { $arguments += '--ui-safe-mode' }
$previousPackagedUI = $env:OPENSTUDIO_FORCE_PACKAGED_UI
$previousRuntime = $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER
$qualification = [ordered]@{
    status = 'running'; executable = $resolvedAppPath; executableSha256 = (Get-FileHash -LiteralPath $resolvedAppPath -Algorithm SHA256).Hash.ToLowerInvariant()
    fileVersion = (Get-Item -LiteralPath $resolvedAppPath).VersionInfo.FileVersion
    startupMode = $StartupMode; standardUser = $standardUser; operatingSystem = [Environment]::OSVersion.VersionString
    staleRuntimeOverride = [bool]$StaleRuntimeOverride; injectedRuntimeFolder = ''; report = $ReportPath
    visibleInspection = 'not_asserted'; windows10Qualification = 'not_asserted'; hardwareAudio = 'not_asserted'
}
$process = $null
try {
    Import-Module (Join-Path $PSScriptRoot 'OwnedDesktopProcess.psm1') -Force
    $env:OPENSTUDIO_FORCE_PACKAGED_UI = '1'
    if ($StaleRuntimeOverride) {
        $qualification.injectedRuntimeFolder = Join-Path $reportDirectory ('missing-webview-runtime-' + [guid]::NewGuid().ToString('N'))
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $qualification.injectedRuntimeFolder
    }
    try {
        $process = Start-OwnedDesktopProcess -FilePath $resolvedAppPath -ArgumentList $arguments
    } finally {
        $env:OPENSTUDIO_FORCE_PACKAGED_UI = $previousPackagedUI
        $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $previousRuntime
    }
    if (!$process.WaitForExit($TimeoutSeconds * 1000)) { throw "Window lifecycle smoke test timed out after $TimeoutSeconds seconds." }
    if ($process.ExitCode -ne 0) { throw "Window lifecycle process exited with code $($process.ExitCode). Report: $ReportPath" }
    $report = Read-LifecycleReport $ReportPath
    Assert-LifecycleReport $report $StartupMode
    if (![IO.Path]::GetFullPath($report.executablePath).Equals($resolvedAppPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Lifecycle report belongs to a different executable.'
    }
    $frontendPath = $report.startupSelfTest.packagedFrontendPath
    if ([string]::IsNullOrWhiteSpace($frontendPath) -or !(Test-Path -LiteralPath $frontendPath -PathType Leaf)) {
        throw 'The reported packaged frontend entry point is missing.'
    }
    $qualification.frontendIndexPath = $frontendPath
    $qualification.frontendIndexSha256 = (Get-FileHash -LiteralPath $frontendPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $qualification.frontendIndexModifiedUtc = (Get-Item -LiteralPath $frontendPath).LastWriteTimeUtc.ToString('o')
    if ($StaleRuntimeOverride -and ![string]::IsNullOrWhiteSpace($report.browserExecutableFolderOverride)) {
        throw 'The stale fixed-runtime override was not removed in the application process.'
    }
    $qualification.status = 'pass'
    $qualification.hardwareAudio = 'not_opened: explicit offline mode and zero hardware counters verified'
} catch {
    $qualification.status = 'fail'
    $qualification.error = $_.Exception.Message
    throw
} finally {
    $env:OPENSTUDIO_FORCE_PACKAGED_UI = $previousPackagedUI
    $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = $previousRuntime
    try {
        if ($null -ne $process) { $process.Dispose() }
    } catch {
        $qualification.status = 'fail'
        $qualification.error = ($qualification.error, ('Owned process cleanup failed: ' + $_.Exception.Message) | Where-Object { $_ }) -join '; '
        throw
    } finally {
        $qualification | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ([IO.Path]::ChangeExtension($ReportPath, '.qualification.json')) -Encoding UTF8
    }
}
Write-Output "Window lifecycle smoke test passed ($StartupMode). Report: $ReportPath"
