param(
    [Parameter(Mandatory = $false)]
    [string]$MetadataDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsDirectmlAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsCudaAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacArm64AiRuntimeAssetPath = "",

    [Parameter(Mandatory = $false)]
    [string]$MacX64AiRuntimeAssetPath = ""
)

$ErrorActionPreference = "Stop"

function Resolve-MetadataPath {
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

function Fail {
    param([string]$Message)
    throw $Message
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        Fail $Message
    }
}

function Assert-FileExists {
    param([string]$Path)
    Assert-True (Test-Path $Path) "Required file not found: $Path"
}

function Load-Json {
    param([string]$Path)
    Assert-FileExists $Path
    return Get-Content $Path -Raw | ConvertFrom-Json
}

function Parse-Checksums {
    param([string]$Path)

    Assert-FileExists $Path
    $map = @{}
    foreach ($line in (Get-Content $Path)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch "^(?<hash>[a-fA-F0-9]{64})\s{2}(?<name>.+)$") {
            Fail ("Invalid checksum line in {0}: {1}" -f $Path, $line)
        }
        $map[$Matches["name"]] = $Matches["hash"].ToLowerInvariant()
    }
    return $map
}

function Get-AssetInfo {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    Assert-FileExists $Path
    $resolved = (Resolve-Path $Path).Path
    $item = Get-Item $resolved
    $hash = (Get-FileHash -Algorithm SHA256 -Path $resolved).Hash.ToLowerInvariant()

    return [pscustomobject]@{
        Path = $resolved
        FileName = $item.Name
        Size = [int64]$item.Length
        Sha256 = $hash
    }
}

function Validate-ManifestBasics {
    param(
        $Manifest,
        [string]$ExpectedChannel,
        [string]$PathLabel
    )

    Assert-True ($Manifest.schemaVersion -ge 1) "$PathLabel has an invalid schemaVersion."
    Assert-True (-not [string]::IsNullOrWhiteSpace($Manifest.version)) "$PathLabel is missing version."
    Assert-True ($Manifest.channel -eq $ExpectedChannel) "$PathLabel channel '$($Manifest.channel)' does not match expected '$ExpectedChannel'."
    Assert-True (-not [string]::IsNullOrWhiteSpace($Manifest.releasePageUrl)) "$PathLabel is missing releasePageUrl."
    Assert-True ($Manifest.releasePageUrl -match '^https?://') "$PathLabel releasePageUrl must be absolute."
    Assert-True (-not [string]::IsNullOrWhiteSpace($Manifest.publishedAt)) "$PathLabel is missing publishedAt."
    if (-not [string]::IsNullOrWhiteSpace($Manifest.fullReleaseNotesUrl)) {
        Assert-True ($Manifest.fullReleaseNotesUrl -match '^https?://') "$PathLabel fullReleaseNotesUrl must be absolute."
    }

    try {
        [void][DateTimeOffset]::Parse($Manifest.publishedAt)
    } catch {
        Fail "$PathLabel publishedAt is not a valid timestamp: $($Manifest.publishedAt)"
    }

    Assert-True ($null -ne $Manifest.platforms) "$PathLabel is missing platforms."
}

function Validate-PlatformEntry {
    param(
        [string]$PlatformName,
        $PlatformNode,
        [hashtable]$Checksums,
        $AssetInfo
    )

    if ($null -eq $PlatformNode) {
        return
    }

    Assert-True (-not [string]::IsNullOrWhiteSpace($PlatformNode.url)) "$PlatformName manifest entry is missing url."
    Assert-True ($PlatformNode.url -match '^https?://') "$PlatformName manifest url must be absolute."
    Assert-True (-not [string]::IsNullOrWhiteSpace($PlatformNode.sha256)) "$PlatformName manifest entry is missing sha256."
    Assert-True (-not [string]::IsNullOrWhiteSpace($PlatformNode.fileName)) "$PlatformName manifest entry is missing fileName."
    Assert-True ([int64]$PlatformNode.size -gt 0) "$PlatformName manifest entry must include a positive size."
    if (-not [string]::IsNullOrWhiteSpace($PlatformNode.minimumSystemVersion)) {
        Assert-True ($PlatformName -eq "macos") "$PlatformName minimumSystemVersion is only expected for macOS assets."
    }

    $manifestHash = $PlatformNode.sha256.ToLowerInvariant()
    Assert-True ($Checksums.ContainsKey($PlatformNode.fileName)) "$PlatformName file '$($PlatformNode.fileName)' is missing from OpenStudio-checksums.txt."
    Assert-True ($Checksums[$PlatformNode.fileName] -eq $manifestHash) "$PlatformName checksum mismatch between manifest and checksums file."

    if ($null -ne $AssetInfo) {
        Assert-True ($AssetInfo.FileName -eq $PlatformNode.fileName) "$PlatformName asset filename '$($AssetInfo.FileName)' does not match manifest '$($PlatformNode.fileName)'."
        Assert-True ($AssetInfo.Size -eq [int64]$PlatformNode.size) "$PlatformName asset size does not match manifest."
        Assert-True ($AssetInfo.Sha256 -eq $manifestHash) "$PlatformName asset hash does not match manifest."
    }
}

function Validate-Appcast {
    param(
        [string]$PlatformName,
        [string]$AppcastPath,
        $Manifest,
        $PlatformNode
    )

    if ($null -eq $PlatformNode) {
        return
    }

    Assert-FileExists $AppcastPath
    [xml]$xml = Get-Content $AppcastPath -Raw
    $item = $xml.rss.channel.item
    Assert-True ($null -ne $item) "$PlatformName appcast is missing an item."
    Assert-True ($item.title -eq "OpenStudio $($Manifest.version)") "$PlatformName appcast title does not match manifest version."
    Assert-True ($xml.rss.channel.link -eq $Manifest.releasePageUrl) "$PlatformName appcast link does not match manifest release page."

    $enclosure = $item.enclosure
    Assert-True ($null -ne $enclosure) "$PlatformName appcast is missing an enclosure."
    Assert-True ($enclosure.url -eq $PlatformNode.url) "$PlatformName appcast enclosure URL does not match manifest."
    Assert-True ([string]$enclosure.length -eq [string]([int64]$PlatformNode.size)) "$PlatformName appcast length does not match manifest size."
    $sparkleNamespace = "http://www.andymatuschak.org/xml-namespaces/sparkle"
    $openStudioNamespace = "https://openstudio.org.in/xmlns/appcast"
    $sparkleVersion = $enclosure.GetAttribute("version", $sparkleNamespace)
    $sparkleShortVersion = $enclosure.GetAttribute("shortVersionString", $sparkleNamespace)
    Assert-True ($sparkleVersion -eq $Manifest.version) "$PlatformName appcast sparkle:version does not match manifest version."
    Assert-True ($sparkleShortVersion -eq $Manifest.version) "$PlatformName appcast sparkle:shortVersionString does not match manifest version."
    $appcastChannel = $enclosure.GetAttribute("channel", $openStudioNamespace)
    $appcastSha256 = $enclosure.GetAttribute("sha256", $openStudioNamespace)
    $appcastFileName = $enclosure.GetAttribute("fileName", $openStudioNamespace)
    Assert-True ($appcastChannel -eq $Manifest.channel) "$PlatformName appcast openstudio:channel does not match manifest."
    Assert-True ($appcastSha256 -eq $PlatformNode.sha256) "$PlatformName appcast openstudio:sha256 does not match manifest."
    Assert-True ($appcastFileName -eq $PlatformNode.fileName) "$PlatformName appcast openstudio:fileName does not match manifest."

    $releaseNotesLink = $xml.rss.channel.item.releaseNotesLink
    if (-not [string]::IsNullOrWhiteSpace($Manifest.fullReleaseNotesUrl)) {
        Assert-True ($releaseNotesLink -eq $Manifest.fullReleaseNotesUrl) "$PlatformName appcast releaseNotesLink does not match manifest fullReleaseNotesUrl."
    }

    if ($PlatformName -eq "windows" -and -not [string]::IsNullOrWhiteSpace($PlatformNode.installerArguments)) {
        $installerArguments = $enclosure.GetAttribute("installerArguments", $sparkleNamespace)
        Assert-True ($installerArguments -eq $PlatformNode.installerArguments) "$PlatformName appcast sparkle:installerArguments does not match manifest."
    }

    if ($PlatformName -eq "macos") {
        if (-not [string]::IsNullOrWhiteSpace($PlatformNode.edSignature)) {
            $edSignature = $enclosure.GetAttribute("edSignature", $sparkleNamespace)
            Assert-True ($edSignature -eq $PlatformNode.edSignature) "$PlatformName appcast sparkle:edSignature does not match manifest."
        }

        if (-not [string]::IsNullOrWhiteSpace($PlatformNode.minimumSystemVersion)) {
            $minimumSystemVersion = $enclosure.GetAttribute("minimumSystemVersion", $sparkleNamespace)
            Assert-True ($minimumSystemVersion -eq $PlatformNode.minimumSystemVersion) "$PlatformName appcast sparkle:minimumSystemVersion does not match manifest."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($Manifest.minimumSupportedVersion)) {
        $minimumSupportedVersion = $enclosure.GetAttribute("minimumSupportedVersion", $openStudioNamespace)
        Assert-True ($minimumSupportedVersion -eq $Manifest.minimumSupportedVersion) "$PlatformName appcast openstudio:minimumSupportedVersion does not match manifest."
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedMetadataDir = Resolve-MetadataPath -RepoRoot $repoRoot -PathValue $MetadataDir
$checksumsPath = Join-Path $resolvedMetadataDir "OpenStudio-checksums.txt"
$rootManifestPath = Join-Path $resolvedMetadataDir "releases/latest.json"
$channelManifestPath = Join-Path $resolvedMetadataDir ("releases/{0}/latest.json" -f $Channel)
$rootAiRuntimeManifestPath = Join-Path $resolvedMetadataDir "releases/ai-runtime/latest.json"
$channelAiRuntimeManifestPath = Join-Path $resolvedMetadataDir ("releases/ai-runtime/{0}/latest.json" -f $Channel)
$windowsAppcastPath = Join-Path $resolvedMetadataDir ("appcast/windows-{0}.xml" -f $Channel)
$macosAppcastPath = Join-Path $resolvedMetadataDir ("appcast/macos-{0}.xml" -f $Channel)

$checksums = Parse-Checksums $checksumsPath
$rootManifest = Load-Json $rootManifestPath
$channelManifest = Load-Json $channelManifestPath

Validate-ManifestBasics -Manifest $rootManifest -ExpectedChannel $Channel -PathLabel "releases/latest.json"
Validate-ManifestBasics -Manifest $channelManifest -ExpectedChannel $Channel -PathLabel "releases/$Channel/latest.json"

$rootJson = ($rootManifest | ConvertTo-Json -Depth 8)
$channelJson = ($channelManifest | ConvertTo-Json -Depth 8)
Assert-True ($rootJson -eq $channelJson) "Root latest.json and channel latest.json do not match."

$windowsAsset = Get-AssetInfo $WindowsAssetPath
$macosAsset = Get-AssetInfo $MacAssetPath
$windowsAiRuntimeAsset = Get-AssetInfo $WindowsAiRuntimeAssetPath
$windowsDirectmlAiRuntimeAsset = Get-AssetInfo $WindowsDirectmlAiRuntimeAssetPath
$windowsCudaAiRuntimeAsset = Get-AssetInfo $WindowsCudaAiRuntimeAssetPath
$macosAiRuntimeAsset = Get-AssetInfo $MacAiRuntimeAssetPath
$macosArm64AiRuntimeAsset = Get-AssetInfo $MacArm64AiRuntimeAssetPath
$macosX64AiRuntimeAsset = Get-AssetInfo $MacX64AiRuntimeAssetPath

Validate-PlatformEntry -PlatformName "windows" -PlatformNode $rootManifest.platforms.windows -Checksums $checksums -AssetInfo $windowsAsset
Validate-PlatformEntry -PlatformName "macos" -PlatformNode $rootManifest.platforms.macos -Checksums $checksums -AssetInfo $macosAsset

Validate-Appcast -PlatformName "windows" -AppcastPath $windowsAppcastPath -Manifest $rootManifest -PlatformNode $rootManifest.platforms.windows
Validate-Appcast -PlatformName "macos" -AppcastPath $macosAppcastPath -Manifest $rootManifest -PlatformNode $rootManifest.platforms.macos

if ((Test-Path $rootAiRuntimeManifestPath) -or (Test-Path $channelAiRuntimeManifestPath)) {
    $rootAiRuntimeManifest = Load-Json $rootAiRuntimeManifestPath
    $channelAiRuntimeManifest = Load-Json $channelAiRuntimeManifestPath

    Assert-True ($rootAiRuntimeManifest.schemaVersion -ge 1) "AI runtime manifest has an invalid schemaVersion."
    Assert-True ($rootAiRuntimeManifest.channel -eq $Channel) "AI runtime manifest channel does not match expected '$Channel'."
    Assert-True (-not [string]::IsNullOrWhiteSpace($rootAiRuntimeManifest.appVersion)) "AI runtime manifest is missing appVersion."
    Assert-True (-not [string]::IsNullOrWhiteSpace($rootAiRuntimeManifest.runtimeVersion)) "AI runtime manifest is missing runtimeVersion."
    Assert-True (-not [string]::IsNullOrWhiteSpace($rootAiRuntimeManifest.publishedAt)) "AI runtime manifest is missing publishedAt."
    Assert-True ($null -ne $rootAiRuntimeManifest.platforms) "AI runtime manifest is missing platforms."

    $rootAiJson = ($rootAiRuntimeManifest | ConvertTo-Json -Depth 8)
    $channelAiJson = ($channelAiRuntimeManifest | ConvertTo-Json -Depth 8)
    Assert-True ($rootAiJson -eq $channelAiJson) "Root AI runtime latest.json and channel AI runtime latest.json do not match."

    $windowsAiNode = $rootAiRuntimeManifest.platforms.windows
    if ($null -ne $windowsAiNode -and $null -ne $windowsAiNode.backends) {
        Validate-PlatformEntry -PlatformName "windows AI runtime legacy" -PlatformNode $windowsAiNode -Checksums $checksums -AssetInfo $(if ($null -ne $windowsDirectmlAiRuntimeAsset) { $windowsDirectmlAiRuntimeAsset } else { $windowsAiRuntimeAsset })
        Validate-PlatformEntry -PlatformName "windows directml AI runtime" -PlatformNode $windowsAiNode.backends.directml -Checksums $checksums -AssetInfo $windowsDirectmlAiRuntimeAsset
        Validate-PlatformEntry -PlatformName "windows cuda AI runtime" -PlatformNode $windowsAiNode.backends.cuda -Checksums $checksums -AssetInfo $windowsCudaAiRuntimeAsset

        if ($null -ne $windowsAiNode.backends.directml) {
            Assert-True ($windowsAiNode.url -eq $windowsAiNode.backends.directml.url) "Legacy Windows AI runtime URL must match the DirectML runtime URL during migration."
            Assert-True ($windowsAiNode.sha256 -eq $windowsAiNode.backends.directml.sha256) "Legacy Windows AI runtime hash must match the DirectML runtime hash during migration."
            Assert-True ($windowsAiNode.fileName -eq $windowsAiNode.backends.directml.fileName) "Legacy Windows AI runtime filename must match the DirectML runtime filename during migration."
        }
    }
    else {
        Validate-PlatformEntry -PlatformName "windows AI runtime" -PlatformNode $windowsAiNode -Checksums $checksums -AssetInfo $windowsAiRuntimeAsset
    }

    $macAiNode = $rootAiRuntimeManifest.platforms.macos
    if ($null -ne $macAiNode -and (($null -ne $macAiNode.arm64) -or ($null -ne $macAiNode.x64))) {
        Validate-PlatformEntry -PlatformName "macos arm64 AI runtime" -PlatformNode $macAiNode.arm64 -Checksums $checksums -AssetInfo $macosArm64AiRuntimeAsset
        Validate-PlatformEntry -PlatformName "macos x64 AI runtime" -PlatformNode $macAiNode.x64 -Checksums $checksums -AssetInfo $macosX64AiRuntimeAsset
    }
    else {
        Validate-PlatformEntry -PlatformName "macos AI runtime" -PlatformNode $macAiNode -Checksums $checksums -AssetInfo $macosAiRuntimeAsset
    }
}

Write-Host "Release metadata validation passed for channel '$Channel'."
