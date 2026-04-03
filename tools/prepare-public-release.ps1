param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [string]$RepoSlug = "sdevil7th/OpenStudio",

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [string]$ReleaseSiteUrl = "https://openstudio.org.in",

    [Parameter(Mandatory = $false)]
    [string]$ReleasePageUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$FullReleaseNotesUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$NotesFile = "packaging/release-notes-template.md",

    [Parameter(Mandatory = $false)]
    [string]$BuildDir = "build-release-windows",

    [Parameter(Mandatory = $false)]
    [string]$WindowsOutputDir = "dist/windows",

    [Parameter(Mandatory = $false)]
    [string]$MetadataOutputDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$NetlifyOutputDir = "dist/netlify-release-site",

    [Parameter(Mandatory = $false)]
    [string]$BundleOutputDir = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MinimumSupportedVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsInstallerArguments = "/SP- /NOICONS",

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
    [switch]$SkipWindowsBuild,

    [Parameter(Mandatory = $false)]
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Resolve-RepoPath {
    param([string]$PathValue)

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return ""
    }

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return (Resolve-Path $PathValue).Path
    }

    return (Resolve-Path (Join-Path $script:RepoRoot $PathValue)).Path
}

function Join-RepoPath {
    param([string]$RelativePath)

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        return $RelativePath
    }

    return Join-Path $script:RepoRoot $RelativePath
}

function Resolve-OptionalAsset {
    param(
        [string]$ProvidedPath,
        [string[]]$Candidates,
        [string]$Label
    )

    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        $candidate = if ([System.IO.Path]::IsPathRooted($ProvidedPath)) { $ProvidedPath } else { Join-Path $script:RepoRoot $ProvidedPath }
        if (-not (Test-Path $candidate)) {
            throw "$Label was not found at '$candidate'."
        }

        return (Resolve-Path $candidate).Path
    }

    foreach ($relativeCandidate in $Candidates) {
        $candidate = Join-RepoPath $relativeCandidate
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    return ""
}

function Assert-FileExists {
    param(
        [string]$PathValue,
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($PathValue) -or -not (Test-Path $PathValue)) {
        throw "$Label was not found at '$PathValue'."
    }
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$normalizedVersion = $Version.Trim()
if ($normalizedVersion.StartsWith("v")) {
    $normalizedVersion = $normalizedVersion.Substring(1)
}

$tag = "v$normalizedVersion"

if ([string]::IsNullOrWhiteSpace($ReleasePageUrl)) {
    $ReleasePageUrl = "https://github.com/$RepoSlug/releases/tag/$tag"
}

if ([string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) {
    $FullReleaseNotesUrl = $ReleasePageUrl
}

if ([string]::IsNullOrWhiteSpace($BundleOutputDir)) {
    $BundleOutputDir = "dist/public-release/$normalizedVersion"
}

$windowsAssetUrl = "https://github.com/$RepoSlug/releases/download/$tag/OpenStudio-Setup-x64.exe"
$macAssetUrl = "https://github.com/$RepoSlug/releases/download/$tag/OpenStudio-macOS.dmg"

$resolvedWindowsInstallerPath = ""

if (-not $SkipWindowsBuild) {
    Write-Step "Running guarded Windows release build"

    $preflightArgs = @(
        "-Version", $normalizedVersion,
        "-ReleasePageUrl", $ReleasePageUrl,
        "-Channel", $Channel,
        "-BuildDir", $BuildDir,
        "-WindowsOutputDir", $WindowsOutputDir,
        "-MetadataOutputDir", $MetadataOutputDir,
        "-NetlifyOutputDir", $NetlifyOutputDir,
        "-NotesFile", $NotesFile,
        "-RepoSlug", $RepoSlug,
        "-WindowsAssetUrl", $windowsAssetUrl,
        "-FullReleaseNotesUrl", $FullReleaseNotesUrl,
        "-CompiledManifestUrl", "$ReleaseSiteUrl/releases/$Channel/latest.json",
        "-CompiledAppcastUrl", "$ReleaseSiteUrl/appcast/windows-$Channel.xml",
        "-WindowsInstallerArguments", $WindowsInstallerArguments
    )

    if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
        $preflightArgs += @("-MinimumSupportedVersion", $MinimumSupportedVersion)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificateFile)) {
        $preflightArgs += @("-CertificateFile", $CertificateFile)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificatePassword)) {
        $preflightArgs += @("-CertificatePassword", $CertificatePassword)
    }
    if (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        $preflightArgs += @("-CertificateThumbprint", $CertificateThumbprint)
    }
    if (-not [string]::IsNullOrWhiteSpace($SignToolPath)) {
        $preflightArgs += @("-SignToolPath", $SignToolPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) {
        $preflightArgs += @("-TimestampUrl", $TimestampUrl)
    }
    if ($SkipFrontendBuild) {
        $preflightArgs += "-SkipFrontendBuild"
    }

    & (Join-RepoPath "tools/run-release-preflight.ps1") @preflightArgs
    $resolvedWindowsInstallerPath = Resolve-OptionalAsset -ProvidedPath "" -Candidates @(
        "$WindowsOutputDir/OpenStudio-Setup-x64.exe",
        "dist/published-release-test/files/OpenStudio-Setup-x64.exe"
    ) -Label "Windows installer"
} else {
    Write-Step "Reusing an existing Windows installer"
    $resolvedWindowsInstallerPath = Resolve-OptionalAsset -ProvidedPath $WindowsAssetPath -Candidates @(
        "$WindowsOutputDir/OpenStudio-Setup-x64.exe",
        "dist/published-release-test/files/OpenStudio-Setup-x64.exe"
    ) -Label "Windows installer"
}

$resolvedMacAssetPath = Resolve-OptionalAsset -ProvidedPath $MacAssetPath -Candidates @(
    "dist/macos/OpenStudio-macOS.dmg",
    "dist/published-release-test/files/OpenStudio-macOS.dmg"
) -Label "macOS DMG"

Assert-FileExists -PathValue $resolvedWindowsInstallerPath -Label "Windows installer"
Assert-FileExists -PathValue $resolvedMacAssetPath -Label "macOS DMG"

Write-Step "Generating release metadata with Windows and macOS assets"
$generateMetadataScript = Join-RepoPath "tools/generate-release-metadata.ps1"
if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
    & $generateMetadataScript `
        -Version $normalizedVersion `
        -Channel $Channel `
        -ReleasePageUrl $ReleasePageUrl `
        -OutputDir $MetadataOutputDir `
        -NotesFile $NotesFile `
        -WindowsAssetPath $resolvedWindowsInstallerPath `
        -WindowsAssetUrl $windowsAssetUrl `
        -MacAssetPath $resolvedMacAssetPath `
        -MacAssetUrl $macAssetUrl `
        -WindowsInstallerArguments $WindowsInstallerArguments `
        -FullReleaseNotesUrl $FullReleaseNotesUrl `
        -MinimumSupportedVersion $MinimumSupportedVersion
} else {
    & $generateMetadataScript `
        -Version $normalizedVersion `
        -Channel $Channel `
        -ReleasePageUrl $ReleasePageUrl `
        -OutputDir $MetadataOutputDir `
        -NotesFile $NotesFile `
        -WindowsAssetPath $resolvedWindowsInstallerPath `
        -WindowsAssetUrl $windowsAssetUrl `
        -MacAssetPath $resolvedMacAssetPath `
        -MacAssetUrl $macAssetUrl `
        -WindowsInstallerArguments $WindowsInstallerArguments `
        -FullReleaseNotesUrl $FullReleaseNotesUrl
}

Write-Step "Validating release metadata"
& (Join-RepoPath "tools/validate-release-metadata.ps1") `
    -MetadataDir $MetadataOutputDir `
    -Channel $Channel `
    -WindowsAssetPath $resolvedWindowsInstallerPath `
    -MacAssetPath $resolvedMacAssetPath

Write-Step "Preparing Netlify release bundle"
& (Join-RepoPath "tools/prepare-netlify-release-site.ps1") `
    -MetadataDir $MetadataOutputDir `
    -OutputDir $NetlifyOutputDir `
    -RepoSlug $RepoSlug

$resolvedMetadataDir = Resolve-RepoPath $MetadataOutputDir
$resolvedNetlifyDir = Resolve-RepoPath $NetlifyOutputDir
$resolvedBundleRoot = Join-RepoPath $BundleOutputDir
$bundleAssetsDir = Join-Path $resolvedBundleRoot "github-release-assets"
$bundleMetadataDir = Join-Path $resolvedBundleRoot "release-metadata"
$bundleNetlifyDir = Join-Path $resolvedBundleRoot "netlify-release-site"

Write-Step "Staging upload-ready release bundle"
Remove-Item -LiteralPath $resolvedBundleRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $bundleAssetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundleMetadataDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundleNetlifyDir | Out-Null

Copy-Item -LiteralPath $resolvedWindowsInstallerPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-Setup-x64.exe") -Force
Copy-Item -LiteralPath $resolvedMacAssetPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-macOS.dmg") -Force
Copy-Item -Path (Join-Path $resolvedMetadataDir "*") -Destination $bundleMetadataDir -Recurse -Force
Copy-Item -Path (Join-Path $resolvedNetlifyDir "*") -Destination $bundleNetlifyDir -Recurse -Force

$nextSteps = @(
    "OpenStudio public release bundle",
    "Version: $normalizedVersion",
    "",
    "GitHub release assets:",
    "  $bundleAssetsDir\OpenStudio-Setup-x64.exe",
    "  $bundleAssetsDir\OpenStudio-macOS.dmg",
    "",
    "Netlify release bundle:",
    "  $bundleNetlifyDir",
    "",
    "Suggested next steps:",
    "  1. Create GitHub release tag $tag in $RepoSlug.",
    "  2. Upload both files from github-release-assets.",
    "  3. Deploy or sync the contents of netlify-release-site if you use the updater metadata bundle.",
    "  4. Test the GitHub release download URLs.",
    "  5. Then verify https://openstudio.org.in/download/windows/latest and /download/macos/latest."
)
Set-Content -Path (Join-Path $resolvedBundleRoot "NEXT-STEPS.txt") -Value ($nextSteps -join [Environment]::NewLine)

Write-Host ""
Write-Host "Release bundle ready."
Write-Host "GitHub assets:  $bundleAssetsDir"
Write-Host "Metadata:       $bundleMetadataDir"
Write-Host "Netlify bundle: $bundleNetlifyDir"
Write-Host "Next steps:     $(Join-Path $resolvedBundleRoot 'NEXT-STEPS.txt')"
