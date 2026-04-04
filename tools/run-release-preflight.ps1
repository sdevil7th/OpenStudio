param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$ReleasePageUrl,

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [string]$BuildDir = "build-release-windows",

    [Parameter(Mandatory = $false)]
    [string]$WindowsOutputDir = "dist/windows",

    [Parameter(Mandatory = $false)]
    [string]$MetadataOutputDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$NetlifyOutputDir = "dist/netlify-release-site",

    [Parameter(Mandatory = $false)]
    [string]$NotesFile = "packaging/release-notes-template.md",

    [Parameter(Mandatory = $false)]
    [string]$RepoSlug = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MinimumSupportedVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$FullReleaseNotesUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$CompiledManifestUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$CompiledAppcastUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsInstallerArguments = "",

    [Parameter(Mandatory = $false)]
    [string]$CertificateFile = "",

    [Parameter(Mandatory = $false)]
    [string]$CertificatePassword = "",

    [Parameter(Mandatory = $false)]
    [string]$CertificateThumbprint = "",

    [Parameter(Mandatory = $false)]
    [string]$SignToolPath = "",

    [Parameter(Mandatory = $false)]
    [string]$TimestampUrl = "http://timestamp.digicert.com",

    [Parameter(Mandatory = $false)]
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Title"
    & $Action
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot "frontend"
$resolvedBuildDir = Join-Path $repoRoot $BuildDir
$resolvedWindowsOutputDir = Join-Path $repoRoot $WindowsOutputDir
$resolvedMetadataOutputDir = Join-Path $repoRoot $MetadataOutputDir
$resolvedNetlifyOutputDir = Join-Path $repoRoot $NetlifyOutputDir
$windowsBundleDir = Join-Path $resolvedBuildDir "OpenStudio_artefacts/Release"
$windowsInstallerPath = Join-Path $resolvedWindowsOutputDir "OpenStudio-Setup-x64.exe"

if ([string]::IsNullOrWhiteSpace($WindowsAssetUrl)) {
    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        $WindowsAssetUrl = "https://github.com/$RepoSlug/releases/latest/download/OpenStudio-Setup-x64.exe"
    } else {
        throw "Provide -WindowsAssetUrl or -RepoSlug so metadata can point to the installer download."
    }
}

if ([string]::IsNullOrWhiteSpace($CompiledManifestUrl)) {
    $CompiledManifestUrl = "https://openstudio.org.in/releases/$Channel/latest.json"
}

if ([string]::IsNullOrWhiteSpace($CompiledAppcastUrl)) {
    $CompiledAppcastUrl = "https://openstudio.org.in/appcast/windows-$Channel.xml"
}

Invoke-Step "Preparing clean release directories" {
    Remove-Item -LiteralPath $resolvedBuildDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $resolvedWindowsOutputDir | Out-Null
    New-Item -ItemType Directory -Force -Path $resolvedMetadataOutputDir | Out-Null
}

if (-not $SkipFrontendBuild) {
    Invoke-Step "Building frontend production bundle" {
        Push-Location $frontendDir
        try {
            cmd /c npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed."
            }

            cmd /c npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed."
            }
        } finally {
            Pop-Location
        }
    }
}

Invoke-Step "Configuring OpenStudio release build" {
    cmake -S $repoRoot -B $resolvedBuildDir -A x64 `
        "-DOPENSTUDIO_APP_VERSION=$Version" `
        "-DOPENSTUDIO_UPDATE_MANIFEST_URL_VALUE=$CompiledManifestUrl" `
        "-DOPENSTUDIO_UPDATE_APPCAST_URL_VALUE=$CompiledAppcastUrl" `
        "-DOPENSTUDIO_RELEASES_PAGE_URL_VALUE=$ReleasePageUrl" `
        "-DOPENSTUDIO_UPDATE_CHANNEL_VALUE=$Channel" `
        "-DOPENSTUDIO_BUNDLE_STEM_RUNTIME=ON" `
        -DFETCHCONTENT_UPDATES_DISCONNECTED=ON
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed."
    }
}

Invoke-Step "Building OpenStudio release target" {
    cmake --build $resolvedBuildDir --config Release --target OpenStudio
    if ($LASTEXITCODE -ne 0) {
        throw "Release build failed."
    }
}

Invoke-Step "Validating Windows runtime bundle" {
    & (Join-Path $repoRoot "tools/validate-runtime-bundle.ps1") `
        -Platform windows `
        -BundlePath $windowsBundleDir `
        -ExpectedVersion $Version `
        -ExpectBundledStemRuntime
}

Invoke-Step "Packaging Windows installer" {
    $arguments = @(
        "-Version", $Version,
        "-SourceDir", $windowsBundleDir,
        "-OutputDir", $WindowsOutputDir
    )

    if (-not [string]::IsNullOrWhiteSpace($CertificateFile)) {
        $arguments += @("-CertificateFile", $CertificateFile)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificatePassword)) {
        $arguments += @("-CertificatePassword", $CertificatePassword)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        $arguments += @("-CertificateThumbprint", $CertificateThumbprint)
    }
    if (-not [string]::IsNullOrWhiteSpace($SignToolPath)) {
        $arguments += @("-SignToolPath", $SignToolPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) {
        $arguments += @("-TimestampUrl", $TimestampUrl)
    }

    & (Join-Path $repoRoot "tools/package-windows-release.ps1") @arguments
}

Invoke-Step "Generating release metadata" {
    $arguments = @(
        "-Version", $Version,
        "-Channel", $Channel,
        "-ReleasePageUrl", $ReleasePageUrl,
        "-OutputDir", $MetadataOutputDir,
        "-NotesFile", $NotesFile,
        "-WindowsAssetPath", $windowsInstallerPath,
        "-WindowsAssetUrl", $WindowsAssetUrl
    )

    if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
        $arguments += @("-MinimumSupportedVersion", $MinimumSupportedVersion)
    }
    if (-not [string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) {
        $arguments += @("-FullReleaseNotesUrl", $FullReleaseNotesUrl)
    }
    if (-not [string]::IsNullOrWhiteSpace($WindowsInstallerArguments)) {
        $arguments += @("-WindowsInstallerArguments", $WindowsInstallerArguments)
    }

    & (Join-Path $repoRoot "tools/generate-release-metadata.ps1") @arguments
}

Invoke-Step "Validating release metadata" {
    & (Join-Path $repoRoot "tools/validate-release-metadata.ps1") `
        -MetadataDir $MetadataOutputDir `
        -Channel $Channel `
        -WindowsAssetPath $windowsInstallerPath
}

Invoke-Step "Preparing Netlify updater bundle" {
    $arguments = @(
        "-MetadataDir", $MetadataOutputDir,
        "-OutputDir", $NetlifyOutputDir,
        "-WindowsDownloadUrl", $WindowsAssetUrl
    )

    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        $arguments += @("-RepoSlug", $RepoSlug)
    }

    & (Join-Path $repoRoot "tools/prepare-netlify-release-site.ps1") @arguments
}

Write-Host ""
Write-Host "OpenStudio Windows release preflight completed successfully."
Write-Host "Installer: $windowsInstallerPath"
Write-Host "Metadata:  $resolvedMetadataOutputDir"
Write-Host "Netlify:   $resolvedNetlifyOutputDir"
