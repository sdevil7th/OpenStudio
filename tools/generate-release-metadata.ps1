param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$ReleasePageUrl,

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$PublishedAt = "",

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [int]$SchemaVersion = 1,

    [Parameter(Mandatory = $false)]
    [string]$MinimumSupportedVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$NotesFile = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAiRuntimeAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacArm64AiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacArm64AiRuntimeAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacX64AiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacX64AiRuntimeAssetUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$AiRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$MacEdSignature = "",

    [Parameter(Mandatory = $false)]
    [string]$MacMinimumSystemVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsInstallerArguments = "",

    [Parameter(Mandatory = $false)]
    [string]$FullReleaseNotesUrl = ""
)

$ErrorActionPreference = "Stop"

function Resolve-OutputPath {
    param(
        [string]$RepoRoot,
        [string]$PathValue
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $RepoRoot
    }

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $PathValue))
}

function Get-AssetMetadata {
    param(
        [string]$AssetPath,
        [string]$AssetUrl,
        [hashtable]$AdditionalProperties = @{}
    )

    if ([string]::IsNullOrWhiteSpace($AssetPath) -or -not (Test-Path $AssetPath)) {
        return $null
    }

    $resolvedPath = (Resolve-Path $AssetPath).Path
    $hash = (Get-FileHash -Algorithm SHA256 -Path $resolvedPath).Hash.ToLowerInvariant()
    $item = Get-Item $resolvedPath

    $metadata = [ordered]@{
        url = $AssetUrl
        sha256 = $hash
        size = [int64]$item.Length
        fileName = $item.Name
    }

    foreach ($key in $AdditionalProperties.Keys) {
        if (-not [string]::IsNullOrWhiteSpace([string]$AdditionalProperties[$key])) {
            $metadata[$key] = $AdditionalProperties[$key]
        }
    }

    return $metadata
}

function Get-AppcastMimeType {
    param([string]$FileName)

    if ($FileName -like "*.dmg") { return "application/x-apple-diskimage" }
    if ($FileName -like "*.exe") { return "application/vnd.microsoft.portable-executable" }
    return "application/octet-stream"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutputDir = Resolve-OutputPath -RepoRoot $repoRoot -PathValue $OutputDir
$appcastDir = Join-Path $resolvedOutputDir "appcast"
$releaseDir = Join-Path $resolvedOutputDir "releases"
$channelReleaseDir = Join-Path $releaseDir $Channel
$aiRuntimeDir = Join-Path $releaseDir "ai-runtime"
$channelAiRuntimeDir = Join-Path $aiRuntimeDir $Channel

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $appcastDir | Out-Null
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $channelReleaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $aiRuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $channelAiRuntimeDir | Out-Null

if ([string]::IsNullOrWhiteSpace($PublishedAt)) {
    $PublishedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
}

$notes = ""
if (-not [string]::IsNullOrWhiteSpace($NotesFile) -and (Test-Path $NotesFile)) {
    $notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile))
}

$windowsAdditional = @{}
if (-not [string]::IsNullOrWhiteSpace($WindowsInstallerArguments)) {
    $windowsAdditional.installerArguments = $WindowsInstallerArguments
}

$macAdditional = @{}
if (-not [string]::IsNullOrWhiteSpace($MacEdSignature)) {
    $macAdditional.edSignature = $MacEdSignature
}
if (-not [string]::IsNullOrWhiteSpace($MacMinimumSystemVersion)) {
    $macAdditional.minimumSystemVersion = $MacMinimumSystemVersion
}

$windows = Get-AssetMetadata -AssetPath $WindowsAssetPath -AssetUrl $WindowsAssetUrl -AdditionalProperties $windowsAdditional
$macos = Get-AssetMetadata -AssetPath $MacAssetPath -AssetUrl $MacAssetUrl -AdditionalProperties $macAdditional
$windowsAiRuntime = Get-AssetMetadata -AssetPath $WindowsAiRuntimeAssetPath -AssetUrl $WindowsAiRuntimeAssetUrl
$macosAiRuntime = Get-AssetMetadata -AssetPath $MacAiRuntimeAssetPath -AssetUrl $MacAiRuntimeAssetUrl
$macosArm64AiRuntime = Get-AssetMetadata -AssetPath $MacArm64AiRuntimeAssetPath -AssetUrl $MacArm64AiRuntimeAssetUrl
$macosX64AiRuntime = Get-AssetMetadata -AssetPath $MacX64AiRuntimeAssetPath -AssetUrl $MacX64AiRuntimeAssetUrl

$manifest = [ordered]@{
    schemaVersion = $SchemaVersion
    channel = $Channel
    version = $Version
    notes = $notes
    publishedAt = $PublishedAt
    releasePageUrl = $ReleasePageUrl
    platforms = [ordered]@{}
}

if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) {
    $manifest.minimumSupportedVersion = $MinimumSupportedVersion
}

if (-not [string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) {
    $manifest.fullReleaseNotesUrl = $FullReleaseNotesUrl
}

if ($windows) { $manifest.platforms.windows = $windows }
if ($macos) { $manifest.platforms.macos = $macos }

$checksums = @()
if ($windows) { $checksums += "{0}  {1}" -f $windows.sha256, $windows.fileName }
if ($macos) { $checksums += "{0}  {1}" -f $macos.sha256, $macos.fileName }
if ($windowsAiRuntime) { $checksums += "{0}  {1}" -f $windowsAiRuntime.sha256, $windowsAiRuntime.fileName }
if ($macosAiRuntime) { $checksums += "{0}  {1}" -f $macosAiRuntime.sha256, $macosAiRuntime.fileName }
if ($macosArm64AiRuntime) { $checksums += "{0}  {1}" -f $macosArm64AiRuntime.sha256, $macosArm64AiRuntime.fileName }
if ($macosX64AiRuntime) { $checksums += "{0}  {1}" -f $macosX64AiRuntime.sha256, $macosX64AiRuntime.fileName }

Set-Content -Path (Join-Path $resolvedOutputDir "OpenStudio-checksums.txt") -Value ($checksums -join [Environment]::NewLine)
Set-Content -Path (Join-Path $releaseDir "latest.json") -Value ($manifest | ConvertTo-Json -Depth 6)
Set-Content -Path (Join-Path $channelReleaseDir "latest.json") -Value ($manifest | ConvertTo-Json -Depth 6)

if (($windowsAiRuntime -or $macosAiRuntime -or $macosArm64AiRuntime -or $macosX64AiRuntime) -and -not [string]::IsNullOrWhiteSpace($AiRuntimeVersion)) {
    $aiRuntimeManifest = [ordered]@{
        schemaVersion = $SchemaVersion
        channel = $Channel
        appVersion = $Version
        runtimeVersion = $AiRuntimeVersion
        publishedAt = $PublishedAt
        platforms = [ordered]@{}
    }

    if ($windowsAiRuntime) {
        $aiRuntimeManifest.platforms.windows = $windowsAiRuntime
    }

    if ($macosArm64AiRuntime -or $macosX64AiRuntime) {
        $aiRuntimeManifest.platforms.macos = [ordered]@{}
        if ($macosArm64AiRuntime) { $aiRuntimeManifest.platforms.macos.arm64 = $macosArm64AiRuntime }
        if ($macosX64AiRuntime) { $aiRuntimeManifest.platforms.macos.x64 = $macosX64AiRuntime }
    }
    elseif ($macosAiRuntime) {
        $aiRuntimeManifest.platforms.macos = $macosAiRuntime
    }

    Set-Content -Path (Join-Path $aiRuntimeDir "latest.json") -Value ($aiRuntimeManifest | ConvertTo-Json -Depth 6)
    Set-Content -Path (Join-Path $channelAiRuntimeDir "latest.json") -Value ($aiRuntimeManifest | ConvertTo-Json -Depth 6)
}

if ($windows) {
    $windowsPubDate = [DateTime]::Parse($PublishedAt).ToUniversalTime().ToString("r")
    $windowsAppcast = @"
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:openstudio="https://openstudio.org.in/xmlns/appcast">
  <channel>
    <title>OpenStudio Windows $($Channel.Substring(0,1).ToUpper() + $Channel.Substring(1))</title>
    <link>$ReleasePageUrl</link>
    <description>$($Channel.Substring(0,1).ToUpper() + $Channel.Substring(1)) OpenStudio releases for Windows.</description>
    <item>
      <title>OpenStudio $Version</title>
      <pubDate>$windowsPubDate</pubDate>
      <description><![CDATA[$notes]]></description>
      <enclosure url="$($windows.url)"
                 sparkle:version="$Version"
                 sparkle:shortVersionString="$Version"
                 openstudio:channel="$Channel"
                 openstudio:sha256="$($windows.sha256)"
                 openstudio:fileName="$($windows.fileName)"$(if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) { "`n                 openstudio:minimumSupportedVersion=""$MinimumSupportedVersion""" })
                 length="$($windows.size)"
                 type="$(Get-AppcastMimeType $windows.fileName)"$(if (-not [string]::IsNullOrWhiteSpace($windows.installerArguments)) { "`n                 sparkle:installerArguments=""$($windows.installerArguments)""" }) />
$(if (-not [string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) { "      <sparkle:releaseNotesLink>$FullReleaseNotesUrl</sparkle:releaseNotesLink>" })
    </item>
  </channel>
</rss>
"@
    Set-Content -Path (Join-Path $appcastDir "windows-$Channel.xml") -Value $windowsAppcast
    if ($Channel -eq "stable") {
        Set-Content -Path (Join-Path $appcastDir "windows-stable.xml") -Value $windowsAppcast
    }
}

if ($macos) {
    $macPubDate = [DateTime]::Parse($PublishedAt).ToUniversalTime().ToString("r")
    $macAppcast = @"
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:openstudio="https://openstudio.org.in/xmlns/appcast">
  <channel>
    <title>OpenStudio macOS $($Channel.Substring(0,1).ToUpper() + $Channel.Substring(1))</title>
    <link>$ReleasePageUrl</link>
    <description>$($Channel.Substring(0,1).ToUpper() + $Channel.Substring(1)) OpenStudio releases for macOS.</description>
    <item>
      <title>OpenStudio $Version</title>
      <pubDate>$macPubDate</pubDate>
      <description><![CDATA[$notes]]></description>
      <enclosure url="$($macos.url)"
                 sparkle:version="$Version"
                 sparkle:shortVersionString="$Version"
                 openstudio:channel="$Channel"
                 openstudio:sha256="$($macos.sha256)"
                 openstudio:fileName="$($macos.fileName)"$(if (-not [string]::IsNullOrWhiteSpace($MinimumSupportedVersion)) { "`n                 openstudio:minimumSupportedVersion=""$MinimumSupportedVersion""" })
                 length="$($macos.size)"
                 type="$(Get-AppcastMimeType $macos.fileName)"$(if (-not [string]::IsNullOrWhiteSpace($macos.edSignature)) { "`n                 sparkle:edSignature=""$($macos.edSignature)""" })$(if (-not [string]::IsNullOrWhiteSpace($macos.minimumSystemVersion)) { "`n                 sparkle:minimumSystemVersion=""$($macos.minimumSystemVersion)""" }) />
$(if (-not [string]::IsNullOrWhiteSpace($FullReleaseNotesUrl)) { "      <sparkle:releaseNotesLink>$FullReleaseNotesUrl</sparkle:releaseNotesLink>" })
    </item>
  </channel>
</rss>
"@
    Set-Content -Path (Join-Path $appcastDir "macos-$Channel.xml") -Value $macAppcast
    if ($Channel -eq "stable") {
        Set-Content -Path (Join-Path $appcastDir "macos-stable.xml") -Value $macAppcast
    }
}

Write-Host "Release metadata written to $resolvedOutputDir"
