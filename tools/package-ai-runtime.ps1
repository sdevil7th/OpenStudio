param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [int64]$MaxArtifactSizeBytes = 0
)

$ErrorActionPreference = "Stop"

$resolvedRuntimeRoot = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) {
    $RuntimeRoot
} else {
    Join-Path $PWD $RuntimeRoot
}

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
} else {
    Join-Path $PWD $OutputPath
}

if (-not (Test-Path $resolvedRuntimeRoot)) {
    throw "Runtime root not found: $resolvedRuntimeRoot"
}

$venvMarker = Join-Path $resolvedRuntimeRoot "pyvenv.cfg"
if (Test-Path $venvMarker) {
    throw "Runtime root '$resolvedRuntimeRoot' still contains pyvenv.cfg and cannot be published as a relocatable runtime."
}

$metadataPath = Join-Path $resolvedRuntimeRoot ".openstudio-ai-runtime.json"
if (-not (Test-Path $metadataPath)) {
    throw "Runtime root '$resolvedRuntimeRoot' is missing .openstudio-ai-runtime.json."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null
if (Test-Path $resolvedOutputPath) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
}

if ($Platform -eq "macos") {
    $parentDir = Split-Path -Parent $resolvedRuntimeRoot
    $runtimeName = Split-Path -Leaf $resolvedRuntimeRoot

    Push-Location $parentDir
    try {
        & /usr/bin/ditto -c -k --sequesterRsrc --keepParent $runtimeName $resolvedOutputPath
        if ($LASTEXITCODE -ne 0) {
            throw "Native macOS runtime archive packaging failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
else {
    $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    if ($null -ne $sevenZip) {
        Push-Location $resolvedRuntimeRoot
        try {
            & $sevenZip.Source a -tzip -mx=9 -mfb=258 -mpass=15 $resolvedOutputPath *
            if ($LASTEXITCODE -ne 0) {
                throw "7-Zip runtime archive packaging failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
    else {
        Compress-Archive -Path (Join-Path $resolvedRuntimeRoot "*") -DestinationPath $resolvedOutputPath -CompressionLevel Optimal
    }
}

$artifactSize = (Get-Item $resolvedOutputPath).Length
Write-Host "compressedArtifactSizeBytes=$artifactSize"
if ($MaxArtifactSizeBytes -gt 0 -and $artifactSize -gt $MaxArtifactSizeBytes) {
    throw "AI runtime archive '$resolvedOutputPath' is $artifactSize bytes, which exceeds the configured limit of $MaxArtifactSizeBytes bytes."
}

& (Join-Path $PSScriptRoot "validate-ai-runtime-package.ps1") `
    -Platform $Platform `
    -ArchivePath $resolvedOutputPath `
    -ExpectedRuntimeVersion $ExpectedRuntimeVersion

Write-Host "AI runtime package created at $resolvedOutputPath"
