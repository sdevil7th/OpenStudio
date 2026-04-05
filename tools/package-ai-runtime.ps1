param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = ""
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

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null
if (Test-Path $resolvedOutputPath) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
}

Compress-Archive -Path (Join-Path $resolvedRuntimeRoot "*") -DestinationPath $resolvedOutputPath -CompressionLevel Optimal

& (Join-Path $PSScriptRoot "validate-ai-runtime-package.ps1") `
    -Platform $Platform `
    -ArchivePath $resolvedOutputPath `
    -ExpectedRuntimeVersion $ExpectedRuntimeVersion

Write-Host "AI runtime package created at $resolvedOutputPath"
