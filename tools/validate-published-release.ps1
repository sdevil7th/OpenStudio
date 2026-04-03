param(
    [Parameter(Mandatory = $false)]
    [string]$MetadataDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [ValidateSet("stable", "beta")]
    [string]$Channel = "stable",

    [Parameter(Mandatory = $false)]
    [string]$ReleaseSiteUrl = "https://openstudio.org.in",

    [Parameter(Mandatory = $false)]
    [switch]$ValidateRedirects,

    [Parameter(Mandatory = $false)]
    [switch]$SkipCacheHeaderValidation
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

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

function Get-NormalizedBaseUrl {
    param([string]$Url)

    Assert-True (-not [string]::IsNullOrWhiteSpace($Url)) "ReleaseSiteUrl is required."
    return $Url.TrimEnd("/")
}

function Join-RemoteUrl {
    param(
        [string]$BaseUrl,
        [string]$RelativePath
    )

    return "{0}/{1}" -f $BaseUrl.TrimEnd("/"), $RelativePath.TrimStart("/")
}

function Invoke-RetryWebRequest {
    param(
        [string]$Url,
        [int]$Attempts = 6,
        [int]$DelaySeconds = 5
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $handler = [System.Net.Http.HttpClientHandler]::new()
            $handler.AllowAutoRedirect = $true
            $client = [System.Net.Http.HttpClient]::new($handler)
            $client.DefaultRequestHeaders.CacheControl = [System.Net.Http.Headers.CacheControlHeaderValue]::new()
            $client.DefaultRequestHeaders.CacheControl.NoCache = $true

            try {
                $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseContentRead).GetAwaiter().GetResult()
                Assert-True ($response.IsSuccessStatusCode) "Request failed for $Url (HTTP $([int]$response.StatusCode))"

                $headers = @{}
                foreach ($header in $response.Headers) {
                    $headers[$header.Key] = ($header.Value -join ", ")
                }
                foreach ($header in $response.Content.Headers) {
                    $headers[$header.Key] = ($header.Value -join ", ")
                }

                return [pscustomobject]@{
                    Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                    Headers = $headers
                }
            } finally {
                if ($null -ne $response) {
                    $response.Dispose()
                }
                $client.Dispose()
                $handler.Dispose()
            }
        } catch {
            $lastError = $_
            if ($attempt -lt $Attempts) {
                Start-Sleep -Seconds $DelaySeconds
            }
        }
    }

    throw $lastError
}

function Get-ResponseHeaderValue {
    param(
        $Headers,
        [string]$Name
    )

    if ($null -eq $Headers) {
        return ""
    }

    $value = $Headers[$Name]
    if ($null -eq $value) {
        $value = $Headers[$Name.ToLowerInvariant()]
    }

    if ($value -is [System.Array]) {
        return ($value -join ", ")
    }

    return [string]$value
}

function Normalize-JsonText {
    param([string]$Text)

    return (($Text | ConvertFrom-Json) | ConvertTo-Json -Depth 16)
}

function Parse-AppcastSummary {
    param([string]$XmlText)

    [xml]$xml = $XmlText
    $item = $xml.rss.channel.item
    $enclosure = $item.enclosure
    $sparkleNamespace = "http://www.andymatuschak.org/xml-namespaces/sparkle"
    $openStudioNamespace = "https://openstudio.org.in/xmlns/appcast"

    return [ordered]@{
        channelLink = [string]$xml.rss.channel.link
        itemTitle = [string]$item.title
        pubDate = [string]$item.pubDate
        description = [string]$item.description
        releaseNotesLink = [string]$item.releaseNotesLink
        enclosureUrl = [string]$enclosure.url
        enclosureLength = [string]$enclosure.length
        sparkleVersion = $enclosure.GetAttribute("version", $sparkleNamespace)
        sparkleShortVersion = $enclosure.GetAttribute("shortVersionString", $sparkleNamespace)
        sparkleInstallerArguments = $enclosure.GetAttribute("installerArguments", $sparkleNamespace)
        sparkleEdSignature = $enclosure.GetAttribute("edSignature", $sparkleNamespace)
        sparkleMinimumSystemVersion = $enclosure.GetAttribute("minimumSystemVersion", $sparkleNamespace)
        openstudioChannel = $enclosure.GetAttribute("channel", $openStudioNamespace)
        openstudioSha256 = $enclosure.GetAttribute("sha256", $openStudioNamespace)
        openstudioFileName = $enclosure.GetAttribute("fileName", $openStudioNamespace)
        openstudioMinimumSupportedVersion = $enclosure.GetAttribute("minimumSupportedVersion", $openStudioNamespace)
    }
}

function Compare-AppcastText {
    param(
        [string]$ExpectedText,
        [string]$ActualText,
        [string]$Label
    )

    $expected = Parse-AppcastSummary $ExpectedText
    $actual = Parse-AppcastSummary $ActualText

    $expectedJson = $expected | ConvertTo-Json -Depth 8
    $actualJson = $actual | ConvertTo-Json -Depth 8
    Assert-True ($expectedJson -eq $actualJson) "$Label does not match the locally generated appcast."
}

function Test-UrlReachable {
    param([string]$Url)

    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $true
    $client = [System.Net.Http.HttpClient]::new($handler)

    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $Url)
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()

        if ($response.StatusCode -eq [System.Net.HttpStatusCode]::MethodNotAllowed) {
            $response.Dispose()
            $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
            $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        }

        Assert-True ($response.IsSuccessStatusCode) "Remote URL is not reachable: $Url (HTTP $([int]$response.StatusCode))"
        $response.Dispose()
    } finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedMetadataDir = Join-Path $repoRoot $MetadataDir
$releaseSiteBaseUrl = Get-NormalizedBaseUrl $ReleaseSiteUrl

Assert-True (Test-Path $resolvedMetadataDir) "Metadata directory not found: $resolvedMetadataDir"

$remotePaths = @(
    "releases/latest.json",
    "releases/$Channel/latest.json",
    "appcast/windows-$Channel.xml",
    "appcast/macos-$Channel.xml",
    "OpenStudio-checksums.txt"
)

$expectedCacheControl = @{
    "releases/latest.json" = "no-store"
    "releases/$Channel/latest.json" = "no-store"
    "appcast/windows-$Channel.xml" = "no-store"
    "appcast/macos-$Channel.xml" = "no-store"
    "OpenStudio-checksums.txt" = "max-age=300"
}

$tempRelativeDir = Join-Path "dist" ("remote-release-validation-" + [guid]::NewGuid().ToString("N"))
$tempDir = Join-Path $repoRoot $tempRelativeDir
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    foreach ($relativePath in $remotePaths) {
        $remoteUrl = Join-RemoteUrl -BaseUrl $releaseSiteBaseUrl -RelativePath $relativePath
        $response = Invoke-RetryWebRequest -Url $remoteUrl
        $content = [string]$response.Content
        $targetPath = Join-Path $tempDir $relativePath
        $targetDirectory = Split-Path -Parent $targetPath
        New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
        Set-Content -Path $targetPath -Value $content -NoNewline

        $expectedHeaderFragment = $expectedCacheControl[$relativePath]
        if (-not $SkipCacheHeaderValidation -and -not [string]::IsNullOrWhiteSpace($expectedHeaderFragment)) {
            $cacheControl = Get-ResponseHeaderValue -Headers $response.Headers -Name "Cache-Control"
            Assert-True ($cacheControl.ToLowerInvariant().Contains($expectedHeaderFragment.ToLowerInvariant())) "$relativePath does not have the expected Cache-Control header."
        }
    }

    & (Join-Path $repoRoot "tools/validate-release-metadata.ps1") `
        -MetadataDir $tempRelativeDir `
        -Channel $Channel

    $localRootJson = Get-Content (Join-Path $resolvedMetadataDir "releases/latest.json") -Raw
    $remoteRootJson = Get-Content (Join-Path $tempDir "releases/latest.json") -Raw
    Assert-True ((Normalize-JsonText $localRootJson) -eq (Normalize-JsonText $remoteRootJson)) "Remote releases/latest.json does not match local metadata."

    $localChannelJson = Get-Content (Join-Path $resolvedMetadataDir ("releases/{0}/latest.json" -f $Channel)) -Raw
    $remoteChannelJson = Get-Content (Join-Path $tempDir ("releases/{0}/latest.json" -f $Channel)) -Raw
    Assert-True ((Normalize-JsonText $localChannelJson) -eq (Normalize-JsonText $remoteChannelJson)) "Remote channel latest.json does not match local metadata."

    $localChecksums = (Get-Content (Join-Path $resolvedMetadataDir "OpenStudio-checksums.txt") -Raw).Trim()
    $remoteChecksums = (Get-Content (Join-Path $tempDir "OpenStudio-checksums.txt") -Raw).Trim()
    Assert-True ($localChecksums -eq $remoteChecksums) "Remote OpenStudio-checksums.txt does not match local metadata."

    Compare-AppcastText `
        -ExpectedText (Get-Content (Join-Path $resolvedMetadataDir ("appcast/windows-{0}.xml" -f $Channel)) -Raw) `
        -ActualText (Get-Content (Join-Path $tempDir ("appcast/windows-{0}.xml" -f $Channel)) -Raw) `
        -Label "Remote Windows appcast"

    Compare-AppcastText `
        -ExpectedText (Get-Content (Join-Path $resolvedMetadataDir ("appcast/macos-{0}.xml" -f $Channel)) -Raw) `
        -ActualText (Get-Content (Join-Path $tempDir ("appcast/macos-{0}.xml" -f $Channel)) -Raw) `
        -Label "Remote macOS appcast"

    $remoteManifest = Get-Content (Join-Path $tempDir ("releases/{0}/latest.json" -f $Channel)) -Raw | ConvertFrom-Json
    if ($remoteManifest.platforms.windows.url) {
        Test-UrlReachable -Url $remoteManifest.platforms.windows.url
    }
    if ($remoteManifest.platforms.macos.url) {
        Test-UrlReachable -Url $remoteManifest.platforms.macos.url
    }

    if ($ValidateRedirects) {
        Test-UrlReachable -Url (Join-RemoteUrl -BaseUrl $releaseSiteBaseUrl -RelativePath "download/windows/latest")
        Test-UrlReachable -Url (Join-RemoteUrl -BaseUrl $releaseSiteBaseUrl -RelativePath "download/macos/latest")
    }

    Write-Host "Published release validation passed for channel '$Channel' at $releaseSiteBaseUrl."
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
