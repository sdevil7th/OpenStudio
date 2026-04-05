param(
    [Parameter(Mandatory = $false)]
    [string]$MetadataDir = "dist/release-metadata",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist/release-publish-assets"
)

$ErrorActionPreference = "Stop"

function Resolve-RepoPath {
    param([string]$PathValue)

    $repoRoot = Split-Path -Parent $PSScriptRoot
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return $PathValue
    }

    return Join-Path $repoRoot $PathValue
}

function Copy-RequiredFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    if (-not (Test-Path $SourcePath)) {
        throw "Required publish asset source file was not found: $SourcePath"
    }

    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
}

function Copy-OptionalFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    if (Test-Path $SourcePath) {
        Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
        return $true
    }

    return $false
}

$resolvedMetadataDir = Resolve-RepoPath $MetadataDir
$resolvedOutputDir = Resolve-RepoPath $OutputDir

if (-not (Test-Path $resolvedMetadataDir)) {
    throw "Metadata directory not found: $resolvedMetadataDir"
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$copyPlan = @(
    @{ Source = "releases/latest.json"; Target = "OpenStudio-release-latest.json"; Required = $true },
    @{ Source = "releases/stable/latest.json"; Target = "OpenStudio-release-stable-latest.json"; Required = $true },
    @{ Source = "appcast/windows-stable.xml"; Target = "OpenStudio-appcast-windows-stable.xml"; Required = $true },
    @{ Source = "appcast/macos-stable.xml"; Target = "OpenStudio-appcast-macos-stable.xml"; Required = $true },
    @{ Source = "OpenStudio-checksums.txt"; Target = "OpenStudio-checksums.txt"; Required = $true },
    @{ Source = "releases/ai-runtime/latest.json"; Target = "OpenStudio-ai-runtime-latest.json"; Required = $false },
    @{ Source = "releases/ai-runtime/stable/latest.json"; Target = "OpenStudio-ai-runtime-stable-latest.json"; Required = $false }
)

$copiedTargets = @()
foreach ($entry in $copyPlan) {
    $sourcePath = Join-Path $resolvedMetadataDir $entry.Source
    $destinationPath = Join-Path $resolvedOutputDir $entry.Target

    if ($entry.Required) {
        Copy-RequiredFile -SourcePath $sourcePath -DestinationPath $destinationPath
        $copiedTargets += $entry.Target
        continue
    }

    if (Copy-OptionalFile -SourcePath $sourcePath -DestinationPath $destinationPath) {
        $copiedTargets += $entry.Target
    }
}

Write-Host "Prepared release publish assets at $resolvedOutputDir"
Write-Host ("Files: " + ($copiedTargets -join ", "))
