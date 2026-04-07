param(
    [Parameter(Mandatory = $false)]
    [string]$MetadataDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist/netlify-release-site",

    [Parameter(Mandatory = $false)]
    [string]$RepoSlug = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsAiRuntimeDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsBaseAiRuntimeDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsDirectmlAiRuntimeDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsCudaAiRuntimeDownloadUrl = "",

    [Parameter(Mandatory = $false)]
    [string]$MacAiRuntimeDownloadUrl = ""
)

$ErrorActionPreference = "Stop"

function Resolve-DownloadUrl {
    param(
        [string]$ProvidedUrl,
        [string]$RepoSlug,
        [string]$FileName
    )

    if (-not [string]::IsNullOrWhiteSpace($ProvidedUrl)) {
        return $ProvidedUrl
    }

    if (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
        return "https://github.com/$RepoSlug/releases/latest/download/$FileName"
    }

    throw "Either an explicit download URL or RepoSlug must be provided for $FileName."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedMetadataDir = Join-Path $repoRoot $MetadataDir
$resolvedOutputDir = Join-Path $repoRoot $OutputDir
$netlifyTemplateDir = Join-Path $repoRoot "packaging/netlify"

if (-not (Test-Path $resolvedMetadataDir)) {
    throw "Metadata directory not found: $resolvedMetadataDir"
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null
Copy-Item -Path (Join-Path $resolvedMetadataDir "*") -Destination $resolvedOutputDir -Recurse -Force
Copy-Item -Path (Join-Path $netlifyTemplateDir "_headers") -Destination (Join-Path $resolvedOutputDir "_headers") -Force

$resolvedWindowsDownloadUrl = Resolve-DownloadUrl -ProvidedUrl $WindowsDownloadUrl -RepoSlug $RepoSlug -FileName "OpenStudio-Setup-x64.exe"
$resolvedMacDownloadUrl = Resolve-DownloadUrl -ProvidedUrl $MacDownloadUrl -RepoSlug $RepoSlug -FileName "OpenStudio-macOS.dmg"
$resolvedWindowsAiRuntimeDownloadUrl = if (-not [string]::IsNullOrWhiteSpace($WindowsBaseAiRuntimeDownloadUrl)) {
    $WindowsBaseAiRuntimeDownloadUrl
} elseif (-not [string]::IsNullOrWhiteSpace($WindowsAiRuntimeDownloadUrl)) {
    $WindowsAiRuntimeDownloadUrl
} elseif (-not [string]::IsNullOrWhiteSpace($WindowsDirectmlAiRuntimeDownloadUrl)) {
    $WindowsDirectmlAiRuntimeDownloadUrl
} elseif (-not [string]::IsNullOrWhiteSpace($RepoSlug)) {
    "https://github.com/$RepoSlug/releases/latest/download/OpenStudio-AI-Runtime-windows-base-x64.zip"
} else {
    ""
}
$resolvedWindowsDirectmlAiRuntimeDownloadUrl = if (-not [string]::IsNullOrWhiteSpace($WindowsDirectmlAiRuntimeDownloadUrl)) {
    $WindowsDirectmlAiRuntimeDownloadUrl
} else {
    ""
}
$resolvedWindowsCudaAiRuntimeDownloadUrl = if (-not [string]::IsNullOrWhiteSpace($WindowsCudaAiRuntimeDownloadUrl)) {
    $WindowsCudaAiRuntimeDownloadUrl
} else {
    ""
}
$resolvedMacAiRuntimeDownloadUrl = if (-not [string]::IsNullOrWhiteSpace($MacAiRuntimeDownloadUrl)) {
    $MacAiRuntimeDownloadUrl
} else {
    ""
}

$redirects = @(
    "/download/windows/latest  $resolvedWindowsDownloadUrl  302",
    "/download/macos/latest    $resolvedMacDownloadUrl  302"
)

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeDownloadUrl)) {
    $redirects += "/download/ai-runtime/windows/latest  $resolvedWindowsAiRuntimeDownloadUrl  302"
}
if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsDirectmlAiRuntimeDownloadUrl)) {
    $redirects += "/download/ai-runtime/windows/directml/latest  $resolvedWindowsDirectmlAiRuntimeDownloadUrl  302"
}
if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsCudaAiRuntimeDownloadUrl)) {
    $redirects += "/download/ai-runtime/windows/cuda/latest  $resolvedWindowsCudaAiRuntimeDownloadUrl  302"
}

if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeDownloadUrl)) {
    $redirects += "/download/ai-runtime/macos/latest    $resolvedMacAiRuntimeDownloadUrl  302"
}

Set-Content -Path (Join-Path $resolvedOutputDir "_redirects") -Value ($redirects -join [Environment]::NewLine)

$netlifyToml = @"
[build]
  publish = "."

[[redirects]]
  from = "/download/windows/latest"
  to = "$resolvedWindowsDownloadUrl"
  status = 302
  force = true

[[redirects]]
  from = "/download/macos/latest"
  to = "$resolvedMacDownloadUrl"
  status = 302
  force = true
"@

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsAiRuntimeDownloadUrl)) {
    $netlifyToml += @"

[[redirects]]
  from = "/download/ai-runtime/windows/latest"
  to = "$resolvedWindowsAiRuntimeDownloadUrl"
  status = 302
  force = true
"@
}

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsDirectmlAiRuntimeDownloadUrl)) {
    $netlifyToml += @"

[[redirects]]
  from = "/download/ai-runtime/windows/directml/latest"
  to = "$resolvedWindowsDirectmlAiRuntimeDownloadUrl"
  status = 302
  force = true
"@
}

if (-not [string]::IsNullOrWhiteSpace($resolvedWindowsCudaAiRuntimeDownloadUrl)) {
    $netlifyToml += @"

[[redirects]]
  from = "/download/ai-runtime/windows/cuda/latest"
  to = "$resolvedWindowsCudaAiRuntimeDownloadUrl"
  status = 302
  force = true
"@
}

if (-not [string]::IsNullOrWhiteSpace($resolvedMacAiRuntimeDownloadUrl)) {
    $netlifyToml += @"

[[redirects]]
  from = "/download/ai-runtime/macos/latest"
  to = "$resolvedMacAiRuntimeDownloadUrl"
  status = 302
  force = true
"@
}

Set-Content -Path (Join-Path $resolvedOutputDir "netlify.toml") -Value $netlifyToml

Write-Host "Netlify release bundle prepared at $resolvedOutputDir"
