param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "1.24.4",

    [Parameter(Mandatory = $false)]
    [ValidateSet("win-x64")]
    [string]$Platform = "win-x64",

    [Parameter(Mandatory = $false)]
    [string]$Destination = "thirdparty/onnxruntime",

    [Parameter(Mandatory = $false)]
    [string]$ExpectedSha256 = "d2319fddfb6ea4db99ccc4b60c85c517bcd855721f5daa6a06d40d7cb2ee2357",

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if ($Version -ne "1.24.4" -and -not $PSBoundParameters.ContainsKey("ExpectedSha256")) {
    throw "Pass -ExpectedSha256 when installing an ONNX Runtime version other than 1.24.4."
}
if ($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "ExpectedSha256 must be exactly 64 hexadecimal characters."
}
$normalizedExpectedSha256 = $ExpectedSha256.ToLowerInvariant()

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$destinationPath = Join-Path $repoRoot $Destination
$headerPath = Join-Path $destinationPath "include/onnxruntime_cxx_api.h"
$dllPath = Join-Path $destinationPath "lib/onnxruntime.dll"
$importLibraryPath = Join-Path $destinationPath "lib/onnxruntime.lib"
$licensePath = Join-Path $destinationPath "LICENSE"
$thirdPartyNoticesPath = Join-Path $destinationPath "ThirdPartyNotices.txt"
$provenancePath = Join-Path $destinationPath "OPENSTUDIO_PROVENANCE.json"
$assetName = "onnxruntime-$Platform-$Version.zip"
$downloadUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$Version/$assetName"

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-InstalledOnnxRuntime {
    $requiredInstalledPaths = @(
        $headerPath,
        $dllPath,
        $importLibraryPath,
        $licensePath,
        $thirdPartyNoticesPath,
        $provenancePath
    )

    foreach ($requiredPath in $requiredInstalledPaths) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            return $false
        }
    }

    try {
        $provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
        if ($provenance.schemaVersion -ne 1 -or
            $provenance.name -ne "ONNX Runtime" -or
            $provenance.version -ne $Version -or
            $provenance.platform -ne $Platform -or
            $provenance.archiveName -ne $assetName -or
            $provenance.archiveUrl -ne $downloadUrl -or
            $provenance.archiveSha256 -ne $normalizedExpectedSha256) {
            return $false
        }

        $expectedFileHashes = @{
            $headerPath = [string]$provenance.files.cxxApiHeaderSha256
            $dllPath = [string]$provenance.files.onnxruntimeDllSha256
            $importLibraryPath = [string]$provenance.files.onnxruntimeImportLibrarySha256
            $licensePath = [string]$provenance.files.licenseSha256
            $thirdPartyNoticesPath = [string]$provenance.files.thirdPartyNoticesSha256
        }

        foreach ($path in $expectedFileHashes.Keys) {
            $expectedHash = $expectedFileHashes[$path].Trim().ToLowerInvariant()
            if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or (Get-FileSha256 -Path $path) -ne $expectedHash) {
                return $false
            }
        }

        return $true
    } catch {
        return $false
    }
}

if (-not $Force -and (Test-InstalledOnnxRuntime)) {
    Write-Host "ONNX Runtime $Version for $Platform is already installed at $destinationPath"
    exit 0
}

if (-not $Force -and (Test-Path -LiteralPath $destinationPath)) {
    Write-Host "The existing ONNX Runtime installation is incomplete, corrupt, or does not match $Version/$Platform. Reinstalling the pinned package."
}

$downloadRoot = Join-Path $env:TEMP "openstudio-onnxruntime-$Version-$Platform"
$archivePath = Join-Path $downloadRoot $assetName
$extractRoot = Join-Path $downloadRoot "extract"

if (Test-Path $downloadRoot) {
    Remove-Item -LiteralPath $downloadRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $downloadRoot | Out-Null

Write-Host "Downloading $assetName from $downloadUrl"
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
if (-not $actualSha256.Equals($normalizedExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ONNX Runtime archive checksum mismatch. Expected $normalizedExpectedSha256, received $actualSha256."
}

Write-Host "Extracting ONNX Runtime package"
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force

$packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
if (-not $packageRoot) {
    throw "Could not find the extracted ONNX Runtime package root in $extractRoot"
}

$requiredPaths = @(
    (Join-Path $packageRoot.FullName "include/onnxruntime_cxx_api.h"),
    (Join-Path $packageRoot.FullName "lib/onnxruntime.dll"),
    (Join-Path $packageRoot.FullName "lib/onnxruntime.lib"),
    (Join-Path $packageRoot.FullName "LICENSE"),
    (Join-Path $packageRoot.FullName "ThirdPartyNotices.txt")
)

foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required ONNX Runtime file is missing from the downloaded package: $requiredPath"
    }
}

if (Test-Path $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force
}

New-Item -ItemType Directory -Path $destinationPath | Out-Null

Copy-Item -LiteralPath (Join-Path $packageRoot.FullName "include") -Destination (Join-Path $destinationPath "include") -Recurse
Copy-Item -LiteralPath (Join-Path $packageRoot.FullName "lib") -Destination (Join-Path $destinationPath "lib") -Recurse

$metadataFiles = @(
    "LICENSE",
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
    "README.md"
)

foreach ($metadataFile in $metadataFiles) {
    $sourcePath = Join-Path $packageRoot.FullName $metadataFile
    if (Test-Path $sourcePath) {
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $destinationPath $metadataFile) -Force
    }
}

$provenance = [ordered]@{
    schemaVersion = 1
    name = "ONNX Runtime"
    version = $Version
    platform = $Platform
    archiveName = $assetName
    archiveUrl = $downloadUrl
    archiveSha256 = $normalizedExpectedSha256
    files = [ordered]@{
        cxxApiHeaderSha256 = Get-FileSha256 -Path $headerPath
        onnxruntimeDllSha256 = Get-FileSha256 -Path $dllPath
        onnxruntimeImportLibrarySha256 = Get-FileSha256 -Path $importLibraryPath
        licenseSha256 = Get-FileSha256 -Path $licensePath
        thirdPartyNoticesSha256 = Get-FileSha256 -Path $thirdPartyNoticesPath
    }
}
$provenanceJson = $provenance | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    $provenancePath,
    $provenanceJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

if (-not (Test-InstalledOnnxRuntime)) {
    throw "Installed ONNX Runtime provenance verification failed at $destinationPath."
}

Write-Host "ONNX Runtime installed to $destinationPath"
Write-Host "This directory remains ignored by git and can be regenerated by rerunning this script."
