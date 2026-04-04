param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$ReleasePageUrl,

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [string]$BuildDir = "build-release-macos",

    [Parameter(Mandatory = $false)]
    [string]$MacOutputDir = "dist/macos",

    [Parameter(Mandatory = $false)]
    [string]$MetadataOutputDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$NetlifyOutputDir = "dist/netlify-release-site",

    [Parameter(Mandatory = $false)]
    [string]$NotesFile = "packaging/release-notes-template.md",

    [Parameter(Mandatory = $false)]
    [string]$RepoSlug = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MinimumSupportedVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$MacEdSignature = "",

    [Parameter(Mandatory = $false)]
    [string]$MacMinimumSystemVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$FullReleaseNotesUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$CompiledManifestUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$CompiledAppcastUrl = "",

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
$resolvedMacOutputDir = Join-Path $repoRoot $MacOutputDir
$resolvedMetadataOutputDir = Join-Path $repoRoot $MetadataOutputDir
$resolvedNetlifyOutputDir = Join-Path $repoRoot $NetlifyOutputDir
$macDmgPath = Join-Path $resolvedMacOutputDir "OpenStudio-macOS.dmg"
$appBundlePath = $null

if ([string]::IsNullOrWhiteSpace($MacAssetUrl)) {
    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        $MacAssetUrl = "https://github.com/$RepoSlug/releases/latest/download/OpenStudio-macOS.dmg"
    } else {
        throw "Provide -MacAssetUrl or -RepoSlug so metadata can point to the macOS download."
    }
}

if ([string]::IsNullOrWhiteSpace($CompiledManifestUrl)) {
    $CompiledManifestUrl = "https://openstudio.org.in/releases/$Channel/latest.json"
}

if ([string]::IsNullOrWhiteSpace($CompiledAppcastUrl)) {
    $CompiledAppcastUrl = "https://openstudio.org.in/appcast/macos-$Channel.xml"
}

Invoke-Step "Preparing clean release directories" {
    Remove-Item -LiteralPath $resolvedBuildDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $resolvedMacOutputDir | Out-Null
    New-Item -ItemType Directory -Force -Path $resolvedMetadataOutputDir | Out-Null
}

if (-not $SkipFrontendBuild) {
    Invoke-Step "Building frontend production bundle" {
        Push-Location $frontendDir
        try {
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw "npm ci failed."
            }

            npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed."
            }
        } finally {
            Pop-Location
        }
    }
}

Invoke-Step "Configuring OpenStudio release build" {
    cmake -S $repoRoot -B $resolvedBuildDir `
        "-DOPENSTUDIO_APP_VERSION=$Version" `
        "-DOPENSTUDIO_UPDATE_MANIFEST_URL_VALUE=$CompiledManifestUrl" `
        "-DOPENSTUDIO_UPDATE_APPCAST_URL_VALUE=$CompiledAppcastUrl" `
        "-DOPENSTUDIO_RELEASES_PAGE_URL_VALUE=$ReleasePageUrl" `
        "-DOPENSTUDIO_UPDATE_CHANNEL_VALUE=$Channel" `
        "-DOPENSTUDIO_BUNDLE_STEM_RUNTIME=OFF" `
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

Invoke-Step "Finding app bundle" {
    $appBundle = Get-ChildItem -Path $resolvedBuildDir -Recurse -Directory -Filter OpenStudio.app | Select-Object -First 1
    if (-not $appBundle) {
        throw "OpenStudio.app was not found under '$resolvedBuildDir'."
    }

    $script:appBundlePath = $appBundle.FullName
    Write-Host "Using app bundle: $appBundlePath"
}

Invoke-Step "Validating macOS runtime bundle" {
    $arguments = @(
        "-Platform", "macos",
        "-BundlePath", $appBundlePath,
        "-ExpectedVersion", $Version,
        "-EnforceLeanBundle"
    )

    & (Join-Path $repoRoot "tools/validate-runtime-bundle.ps1") @arguments
}

Invoke-Step "Running macOS startup shell self-test" {
    $reportPath = Join-Path ([System.IO.Path]::GetTempPath()) "OpenStudio_StartupSelfTest.txt"
    if (Test-Path $reportPath) {
        Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue
    }

    & (Join-Path $appBundlePath "Contents/MacOS/OpenStudio") --startup-self-test --report $reportPath
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $reportPath) {
            Get-Content -LiteralPath $reportPath
        }

        throw "macOS startup self-test failed."
    }
}

Invoke-Step "Packaging macOS DMG" {
    chmod +x (Join-Path $repoRoot "tools/package-macos-release.sh")
    & (Join-Path $repoRoot "tools/package-macos-release.sh") $appBundlePath $Version $resolvedMacOutputDir
    if ($LASTEXITCODE -ne 0) {
        throw "macOS packaging failed."
    }
}

Invoke-Step "Generating release metadata" {
    $arguments = @(
        "-Version", $Version,
        "-Channel", $Channel,
        "-ReleasePageUrl", $ReleasePageUrl,
        "-OutputDir", $MetadataOutputDir,
        "-NotesFile", $NotesFile,
        "-MacAssetPath", $macDmgPath,
        "-MacAssetUrl", $MacAssetUrl
    )

    if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
        $arguments += @("-MinimumSupportedVersion", $MinimumSupportedVersion)
    }
    if (-not [string]::IsNullOrWhiteSpace($MacEdSignature)) {
        $arguments += @("-MacEdSignature", $MacEdSignature)
    }
    if (-not [string]::IsNullOrWhiteSpace($MacMinimumSystemVersion)) {
        $arguments += @("-MacMinimumSystemVersion", $MacMinimumSystemVersion)
    }
    if (-not [string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) {
        $arguments += @("-FullReleaseNotesUrl", $FullReleaseNotesUrl)
    }

    & (Join-Path $repoRoot "tools/generate-release-metadata.ps1") @arguments
}

Invoke-Step "Validating release metadata" {
    & (Join-Path $repoRoot "tools/validate-release-metadata.ps1") `
        -MetadataDir $MetadataOutputDir `
        -Channel $Channel `
        -MacAssetPath $macDmgPath
}

Invoke-Step "Preparing Netlify updater bundle" {
    $arguments = @(
        "-MetadataDir", $MetadataOutputDir,
        "-OutputDir", $NetlifyOutputDir,
        "-MacDownloadUrl", $MacAssetUrl
    )

    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        $arguments += @("-RepoSlug", $RepoSlug)
    }

    & (Join-Path $repoRoot "tools/prepare-netlify-release-site.ps1") @arguments
}

Write-Host ""
Write-Host "OpenStudio macOS release preflight completed successfully."
Write-Host "DMG:      $macDmgPath"
Write-Host "Metadata: $resolvedMetadataOutputDir"
Write-Host "Netlify:  $resolvedNetlifyOutputDir"
