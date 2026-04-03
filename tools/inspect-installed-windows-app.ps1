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
$lines.Add("")

$wvVersions = Get-WebView2RuntimeVersions
$lines.Add("Detected WebView2 runtime versions: $(if ($wvVersions) { $wvVersions -join ', ' } else { 'none' })")
$lines.Add("")

if (Test-Path $startupLog) {
    $lines.Add("Startup log tail:")
    $lines.AddRange((Get-Content $startupLog | Select-Object -Last 80))
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

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Host "Diagnostic report written to $reportPath"
