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

function Test-MicrosoftSignedInstaller {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $file = Get-Item -LiteralPath $Path
    if ($file.Length -lt 1MB) {
        return $false
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid `
        -and $null -ne $signature.SignerCertificate `
        -and $signature.SignerCertificate.Subject -match "(?:CN|O)=Microsoft Corporation(?:,|$)"
}

New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null

foreach ($download in $downloads) {
    $targetPath = Join-Path $resolvedDestination $download.FileName

    if ((-not $Force) -and (Test-MicrosoftSignedInstaller -Path $targetPath)) {
        Write-Host "$($download.Name) already present at $targetPath"
        continue
    }

    $temporaryPath = "$targetPath.download"
    Write-Host "Downloading $($download.Name)..."
    try {
        Invoke-WebRequest -Uri $download.Url -OutFile $temporaryPath

        if (-not (Test-MicrosoftSignedInstaller -Path $temporaryPath)) {
            throw "Downloaded $($download.Name) is missing a valid Microsoft Authenticode signature."
        }

        Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Saved $($download.Name) to $targetPath"
}

Write-Host "Windows prerequisite installers are ready in $resolvedDestination"
