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
    [string]$WindowsAiRuntimeRoot = "tools/python",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeRoot = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$AiRuntimeVersion = "",

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
$windowsAiRuntimeAssetUrl = "https://github.com/$RepoSlug/releases/download/$tag/OpenStudio-AI-Runtime-windows-x64.zip"
$macAiRuntimeAssetUrl = "https://github.com/$RepoSlug/releases/download/$tag/OpenStudio-AI-Runtime-macos-universal.zip"

$resolvedWindowsInstallerPath = ""
$resolvedWindowsAiRuntimeAssetPath = ""
$resolvedMacAiRuntimeAssetPath = ""

if ([string]::IsNullOrWhiteSpace($AiRuntimeVersion)) {
    $AiRuntimeVersion = $normalizedVersion
}

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

if (-not [string]::IsNullOrWhiteSpace($WindowsAiRuntimeAssetPath)) {
    $resolvedWindowsAiRuntimeAssetPath = Resolve-OptionalAsset -ProvidedPath $WindowsAiRuntimeAssetPath -Candidates @() -Label "Windows AI runtime archive"
} elseif (-not [string]::IsNullOrWhiteSpace($WindowsAiRuntimeRoot)) {
    $windowsAiRuntimeRootPath = Join-RepoPath $WindowsAiRuntimeRoot
    if (Test-Path $windowsAiRuntimeRootPath) {
        Write-Step "Packaging Windows AI runtime archive"
        $resolvedWindowsAiRuntimeAssetPath = Join-RepoPath "dist/ai-runtime/OpenStudio-AI-Runtime-windows-x64.zip"
        & (Join-RepoPath "tools/package-ai-runtime.ps1") `
            -Platform windows `
            -RuntimeRoot $windowsAiRuntimeRootPath `
            -OutputPath $resolvedWindowsAiRuntimeAssetPath `
            -ExpectedRuntimeVersion $AiRuntimeVersion
    }
}

if (-not [string]::IsNullOrWhiteSpace($MacAiRuntimeAssetPath)) {
    $resolvedMacAiRuntimeAssetPath = Resolve-OptionalAsset -ProvidedPath $MacAiRuntimeAssetPath -Candidates @() -Label "macOS AI runtime archive"
} elseif (-not [string]::IsNullOrWhiteSpace($MacAiRuntimeRoot)) {
    $macAiRuntimeRootPath = Join-RepoPath $MacAiRuntimeRoot
    if (Test-Path $macAiRuntimeRootPath) {
        Write-Step "Packaging macOS AI runtime archive"
        $resolvedMacAiRuntimeAssetPath = Join-RepoPath "dist/ai-runtime/OpenStudio-AI-Runtime-macos-universal.zip"
        & (Join-RepoPath "tools/package-ai-runtime.ps1") `
            -Platform macos `
            -RuntimeRoot $macAiRuntimeRootPath `
            -OutputPath $resolvedMacAiRuntimeAssetPath `
            -ExpectedRuntimeVersion $AiRuntimeVersion
    }
}

Write-Step "Generating release metadata with Windows and macOS assets"
$generateMetadataScript = Join-RepoPath "tools/generate-release-metadata.ps1"
$generateMetadataArgs = @(
    "-Version", $normalizedVersion,
    "-Channel", $Channel,
    "-ReleasePageUrl", $ReleasePageUrl,
    "-OutputDir", $MetadataOutputDir,
    "-NotesFile", $NotesFile,
    "-WindowsAssetPath", $resolvedWindowsInstallerPath,
    "-WindowsAssetUrl", $windowsAssetUrl,
    "-MacAssetPath", $resolvedMacAssetPath,
    "-MacAssetUrl", $macAssetUrl,
    "-WindowsInstallerArguments", $WindowsInstallerArguments,
    "-FullReleaseNotesUrl", $FullReleaseNotesUrl
)

if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
    $generateMetadataArgs += @("-MinimumSupportedVersion", $MinimumSupportedVersion)
}

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeAssetPath)) {
    $generateMetadataArgs += @(
        "-WindowsAiRuntimeAssetPath", $resolvedWindowsAiRuntimeAssetPath,
        "-WindowsAiRuntimeAssetUrl", $windowsAiRuntimeAssetUrl,
        "-AiRuntimeVersion", $AiRuntimeVersion
    )
}

if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeAssetPath)) {
    $generateMetadataArgs += @(
        "-MacAiRuntimeAssetPath", $resolvedMacAiRuntimeAssetPath,
        "-MacAiRuntimeAssetUrl", $macAiRuntimeAssetUrl,
        "-AiRuntimeVersion", $AiRuntimeVersion
    )
}

& $generateMetadataScript @generateMetadataArgs

Write-Step "Validating release metadata"
$validateMetadataArgs = @(
    "-MetadataDir", $MetadataOutputDir,
    "-Channel", $Channel,
    "-WindowsAssetPath", $resolvedWindowsInstallerPath,
    "-MacAssetPath", $resolvedMacAssetPath
)

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeAssetPath)) {
    $validateMetadataArgs += @("-WindowsAiRuntimeAssetPath", $resolvedWindowsAiRuntimeAssetPath)
}
if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeAssetPath)) {
    $validateMetadataArgs += @("-MacAiRuntimeAssetPath", $resolvedMacAiRuntimeAssetPath)
}

& (Join-RepoPath "tools/validate-release-metadata.ps1") @validateMetadataArgs

Write-Step "Preparing Netlify release bundle"
$prepareNetlifyArgs = @(
    "-MetadataDir", $MetadataOutputDir,
    "-OutputDir", $NetlifyOutputDir,
    "-RepoSlug", $RepoSlug
)

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeAssetPath)) {
    $prepareNetlifyArgs += @("-WindowsAiRuntimeDownloadUrl", $windowsAiRuntimeAssetUrl)
}
if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeAssetPath)) {
    $prepareNetlifyArgs += @("-MacAiRuntimeDownloadUrl", $macAiRuntimeAssetUrl)
}

& (Join-RepoPath "tools/prepare-netlify-release-site.ps1") @prepareNetlifyArgs

$resolvedMetadataDir = Resolve-RepoPath $MetadataOutputDir
$resolvedNetlifyDir = Resolve-RepoPath $NetlifyOutputDir
$resolvedBundleRoot = Join-RepoPath $BundleOutputDir
$bundleAssetsDir = Join-Path $resolvedBundleRoot "github-release-assets"
$bundleMetadataDir = Join-Path $resolvedBundleRoot "release-metadata"
$bundlePublishAssetsDir = Join-Path $resolvedBundleRoot "release-publish-assets"
$bundleNetlifyDir = Join-Path $resolvedBundleRoot "netlify-release-site"

Write-Step "Staging upload-ready release bundle"
Remove-Item -LiteralPath $resolvedBundleRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $bundleAssetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundleMetadataDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundlePublishAssetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundleNetlifyDir | Out-Null

Copy-Item -LiteralPath $resolvedWindowsInstallerPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-Setup-x64.exe") -Force
Copy-Item -LiteralPath $resolvedMacAssetPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-macOS.dmg") -Force
if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeAssetPath)) {
    Copy-Item -LiteralPath $resolvedWindowsAiRuntimeAssetPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-AI-Runtime-windows-x64.zip") -Force
}
if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeAssetPath)) {
    Copy-Item -LiteralPath $resolvedMacAiRuntimeAssetPath -Destination (Join-Path $bundleAssetsDir "OpenStudio-AI-Runtime-macos-universal.zip") -Force
}
Copy-Item -Path (Join-Path $resolvedMetadataDir "*") -Destination $bundleMetadataDir -Recurse -Force
& (Join-RepoPath "tools/prepare-release-publish-assets.ps1") `
    -MetadataDir $MetadataOutputDir `
    -OutputDir $bundlePublishAssetsDir
Copy-Item -Path (Join-Path $resolvedNetlifyDir "*") -Destination $bundleNetlifyDir -Recurse -Force

$nextSteps = @(
    "OpenStudio public release bundle",
    "Version: $normalizedVersion",
    "",
    "This bundle is a manual fallback path.",
    "Preferred path for normal releases: push the version tag and let GitHub Actions publish the release assets automatically.",
    "",
    "GitHub release assets:",
    "  $bundleAssetsDir\OpenStudio-Setup-x64.exe",
    "  $bundleAssetsDir\OpenStudio-macOS.dmg"
)

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeAssetPath)) {
    $nextSteps += "  $bundleAssetsDir\OpenStudio-AI-Runtime-windows-x64.zip"
}
if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeAssetPath)) {
    $nextSteps += "  $bundleAssetsDir\OpenStudio-AI-Runtime-macos-universal.zip"
}

$nextSteps += @(
    "",
    "Website publish assets:",
    "  $bundlePublishAssetsDir",
    "",
    "Netlify preview bundle (local/manual only):",
    "  $bundleNetlifyDir",
    "",
    "Suggested next steps:",
    "  1. Preferred: push tag $tag to $RepoSlug and let the Release workflow publish the assets.",
    "  2. Fallback only: upload the files from github-release-assets manually.",
    "  3. Let the website repo fetch the uniquely named files from release-publish-assets or the GitHub Release.",
    "  4. Use netlify-release-site only for local/manual preview of redirect behavior.",
    "  5. Test the GitHub release download URLs.",
    "  6. Then verify the website-owned metadata and redirect URLs on openstudio.org.in."
)
Set-Content -Path (Join-Path $resolvedBundleRoot "NEXT-STEPS.txt") -Value ($nextSteps -join [Environment]::NewLine)

Write-Host ""
Write-Host "Release bundle ready."
Write-Host "GitHub assets:  $bundleAssetsDir"
Write-Host "Metadata:       $bundleMetadataDir"
Write-Host "Publish assets: $bundlePublishAssetsDir"
Write-Host "Netlify bundle: $bundleNetlifyDir"
Write-Host "Next steps:     $(Join-Path $resolvedBundleRoot 'NEXT-STEPS.txt')"
