param(
    [string]$InstallDir = "C:\Program Files\OpenStudio",
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "OpenStudio\Diagnostics"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$startupLog = Join-Path $env:APPDATA "OpenStudio\logs\OpenStudio_Startup.log"
$legacyStartupLog = Join-Path $InstallDir "OpenStudio_Debug.log"
$webView2UserData = Join-Path $env:APPDATA "OpenStudio\WebView2UserData"
$windowsPrereqsDir = Join-Path $InstallDir "prereqs\windows"
$reportPath = Join-Path $OutputDir "installed-app-report.txt"

function Get-WebView2RuntimeVersions {
    $roots = @(
        "C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        "C:\Program Files\Microsoft\EdgeWebView\Application"
    )

    $versions = @()
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) {
            continue
        }

        $versions += Get-ChildItem $root -Directory |
            Where-Object { $_.Name -match '^[0-9.]+$' } |
            Select-Object -ExpandProperty Name
    }

    return $versions | Sort-Object -Unique
}

function Get-RecentOpenStudioEvents {
    try {
        return Get-EventLog -LogName Application -Newest 200 |
            Where-Object {
                $_.Source -in @("Application Error", "Windows Error Reporting") -and
                $_.Message -match "OpenStudio.exe"
            } |
            Select-Object -First 10 TimeGenerated, Source, EventID, Message
    } catch {
        return @()
    }
}

function Get-VCRedistStatus {
    $registryPath = "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    if (-not (Test-Path $registryPath)) {
        return @{
            Installed = $false
            Version = ""
        }
    }

    try {
        $properties = Get-ItemProperty -Path $registryPath
        return @{
            Installed = ($properties.Installed -eq 1)
            Version = [string]($properties.Version ?? "")
        }
    } catch {
        return @{
            Installed = $false
            Version = ""
        }
    }
}

function Get-StartupSummary {
    param([string]$Path)

    $summary = [ordered]@{
        BackendSupported = ""
        FrontendState = ""
        StartupMode = ""
        StartupLog = ""
        TargetUrl = ""
    }

    if (-not (Test-Path $Path)) {
        return $summary
    }

    foreach ($line in Get-Content $Path) {
        if ($line -match '^Embedded browser backend supported:\s*(.+)$') {
            $summary.BackendSupported = $Matches[1]
        } elseif ($line -match '^Frontend startup state:\s*(.+)$') {
            $summary.FrontendState = $Matches[1]
        } elseif ($line -match '^Frontend startup mode:\s*(.+)$') {
            $summary.StartupMode = $Matches[1]
        } elseif ($line -match '^Startup log file:\s*(.+)$') {
            $summary.StartupLog = $Matches[1]
        } elseif ($line -match '^Frontend startup state: navigation-started -\s*(.+)$') {
            $summary.TargetUrl = $Matches[1]
        }
    }

    return $summary
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("OpenStudio installed app diagnostics")
$lines.Add("Generated: $(Get-Date -Format o)")
$lines.Add("")
$lines.Add("Install directory: $InstallDir")
$lines.Add("OpenStudio.exe present: $(Test-Path (Join-Path $InstallDir 'OpenStudio.exe'))")
$lines.Add("webui\\index.html present: $(Test-Path (Join-Path $InstallDir 'webui\\index.html'))")
$lines.Add("effects dir present: $(Test-Path (Join-Path $InstallDir 'effects'))")
$lines.Add("scripts dir present: $(Test-Path (Join-Path $InstallDir 'scripts'))")
$lines.Add("")
$lines.Add("Startup log (preferred): $startupLog")
$lines.Add("Startup log exists: $(Test-Path $startupLog)")
$lines.Add("Startup log (legacy): $legacyStartupLog")
$lines.Add("Legacy startup log exists: $(Test-Path $legacyStartupLog)")
$lines.Add("WebView2 user data dir: $webView2UserData")
$lines.Add("WebView2 user data exists: $(Test-Path $webView2UserData)")
$lines.Add("Windows prerequisite installer dir: $windowsPrereqsDir")
$lines.Add("WebView2 bootstrapper present: $(Test-Path (Join-Path $windowsPrereqsDir 'MicrosoftEdgeWebView2Setup.exe'))")
$lines.Add("VC++ redistributable installer present: $(Test-Path (Join-Path $windowsPrereqsDir 'vc_redist.x64.exe'))")
$lines.Add("")

$wvVersions = Get-WebView2RuntimeVersions
$lines.Add("Detected WebView2 runtime versions: $(if ($wvVersions) { $wvVersions -join ', ' } else { 'none' })")
$vcRedist = Get-VCRedistStatus
$lines.Add("VC++ redistributable installed: $($vcRedist.Installed)")
$lines.Add("VC++ redistributable version: $(if ($vcRedist.Version) { $vcRedist.Version } else { 'unknown' })")
$lines.Add("")

if (Test-Path $startupLog) {
    $startupSummary = Get-StartupSummary -Path $startupLog
    $lines.Add("Startup summary:")
    $lines.Add("  Backend supported: $($startupSummary.BackendSupported)")
    $lines.Add("  Frontend state: $($startupSummary.FrontendState)")
    $lines.Add("  Startup mode: $($startupSummary.StartupMode)")
    $lines.Add("  Target URL: $($startupSummary.TargetUrl)")
    $lines.Add("")
    $lines.Add("Startup log tail:")
    $startupLogLines = Get-Content $startupLog | Select-Object -Last 80
    foreach ($line in $startupLogLines) {
        $lines.Add([string]$line)
    }
    Copy-Item $startupLog (Join-Path $OutputDir "OpenStudio_Startup.log") -Force
    $lines.Add("")
}

if (Test-Path $legacyStartupLog) {
    Copy-Item $legacyStartupLog (Join-Path $OutputDir "OpenStudio_Debug.log") -Force
}

$events = Get-RecentOpenStudioEvents
if ($events.Count -gt 0) {
    $lines.Add("Recent Windows Application events mentioning OpenStudio.exe:")
    foreach ($event in $events) {
        $lines.Add("")
        $lines.Add("[$($event.TimeGenerated.ToString('o'))] $($event.Source) / $($event.EventID)")
        $lines.Add($event.Message)
    }
}

$lines.Add("")
$lines.Add("Safe startup relaunch:")
$lines.Add("  `"$InstallDir\OpenStudio.exe`" --ui-safe-mode")

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Host "Diagnostic report written to $reportPath"
