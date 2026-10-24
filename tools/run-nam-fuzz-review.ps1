param(
    [string]$AppPath,
    [string]$OutputRoot = "output/nam-fuzz-review",
    [string]$GuitarInput,
    [string]$BassInput,
    [string]$AmpModel,
    [string]$CabIR,
    [int]$TimeoutSeconds = 360,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$reviewRepoRoot = Split-Path -Parent $PSScriptRoot
$reviewOutput = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    [System.IO.Path]::GetFullPath($OutputRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $reviewRepoRoot $OutputRoot))
}

if ([bool]$AmpModel -ne [bool]$CabIR) {
    throw "Full-chain review requires both -AmpModel and -CabIR."
}
foreach ($reviewInput in @($GuitarInput, $BassInput, $AmpModel, $CabIR)) {
    if ($reviewInput -and -not (Test-Path -LiteralPath $reviewInput -PathType Leaf)) {
        throw "Review input not found: $reviewInput"
    }
}
if ($AppPath) { $AppPath = (Resolve-Path -LiteralPath $AppPath).Path }

if (-not $SkipBuild) {
    & cmake --build (Join-Path $reviewRepoRoot "build") --config Debug
    if ($LASTEXITCODE -ne 0) { throw "Debug build failed." }
}

$reviewEnvironment = @{
    OPENSTUDIO_NAM_FUZZ_ONLY = "1"
    OPENSTUDIO_NAM_FUZZ_AUDIT_DIR = $reviewOutput
    OPENSTUDIO_NAM_FUZZ_AUDIT_INPUT = $(if ($GuitarInput) { (Resolve-Path -LiteralPath $GuitarInput).Path } else { $null })
    OPENSTUDIO_NAM_FUZZ_AUDIT_BASS_INPUT = $(if ($BassInput) { (Resolve-Path -LiteralPath $BassInput).Path } else { $null })
    OPENSTUDIO_NAM_FUZZ_AUDIT_AMP = $(if ($AmpModel) { (Resolve-Path -LiteralPath $AmpModel).Path } else { $null })
    OPENSTUDIO_NAM_FUZZ_AUDIT_CAB = $(if ($CabIR) { (Resolve-Path -LiteralPath $CabIR).Path } else { $null })
}
$reviewPreviousEnvironment = @{}
$reviewLocationPushed = $false
try {
    foreach ($reviewName in $reviewEnvironment.Keys) {
        $reviewPreviousEnvironment[$reviewName] = [System.Environment]::GetEnvironmentVariable($reviewName, "Process")
        [System.Environment]::SetEnvironmentVariable($reviewName, $reviewEnvironment[$reviewName], "Process")
    }
    Push-Location -LiteralPath $reviewRepoRoot
    $reviewLocationPushed = $true
    $reviewArguments = @{
        OutputRoot = $reviewOutput
        Label = "fuzz-interaction"
        TimeoutSeconds = $TimeoutSeconds
        SkipBuild = $true
    }
    if ($AppPath) { $reviewArguments.AppPath = $AppPath }
    & (Join-Path $PSScriptRoot "run-nam-rack-headless-regression.ps1") @reviewArguments
    if ($LASTEXITCODE -ne 0) { throw "Octaver Fuzz review failed with exit code $LASTEXITCODE." }
    Write-Host "Listening exports and diagnostic manifests: $reviewOutput"
    Write-Host "Tone quality remains not_asserted until audition; measurements are diagnostic_only."
} finally {
    if ($reviewLocationPushed) { Pop-Location }
    foreach ($reviewName in $reviewPreviousEnvironment.Keys) {
        [System.Environment]::SetEnvironmentVariable($reviewName, $reviewPreviousEnvironment[$reviewName], "Process")
    }
}
