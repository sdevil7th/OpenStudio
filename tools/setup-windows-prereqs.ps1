param(
    [Parameter(Mandatory = $false)]
    [string]$Destination = "thirdparty/windows-prereqs",

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedDestination = if ([System.IO.Path]::IsPathRooted($Destination)) {
    $Destination
} else {
    Join-Path $repoRoot $Destination
}

$downloads = @(
    @{
        Name = "WebView2 Evergreen Standalone Installer (x64)"
        FileName = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
        Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124701"
    },
    @{
        Name = "Visual C++ x64 Redistributable"
        FileName = "vc_redist.x64.exe"
        Url = "https://aka.ms/vc14/vc_redist.x64.exe"
    }
)

New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null

foreach ($download in $downloads) {
    $targetPath = Join-Path $resolvedDestination $download.FileName

    if ((-not $Force) -and (Test-Path $targetPath)) {
        Write-Host "$($download.Name) already present at $targetPath"
        continue
    }

    Write-Host "Downloading $($download.Name)..."
    Invoke-WebRequest -Uri $download.Url -OutFile $targetPath

    if (-not (Test-Path $targetPath)) {
        throw "Failed to download $($download.Name) to '$targetPath'."
    }

    Write-Host "Saved $($download.Name) to $targetPath"
}

Write-Host "Windows prerequisite installers are ready in $resolvedDestination"
