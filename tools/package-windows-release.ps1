param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [string]$SourceDir = "build/OpenStudio_artefacts/Release",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist/windows",

    [Parameter(Mandatory = $false)]
    [string]$CertificateFile = "",

    [Parameter(Mandatory = $false)]
    [string]$CertificatePassword = "",

    [Parameter(Mandatory = $false)]
    [string]$CertificateThumbprint = "",

    [Parameter(Mandatory = $false)]
    [string]$SignToolPath = "",

    [Parameter(Mandatory = $false)]
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Resolve-SignToolPath {
    param([string]$ExplicitPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path $ExplicitPath)) {
            throw "The configured SignTool path was not found: $ExplicitPath"
        }

        return (Resolve-Path $ExplicitPath).Path
    }

    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $sdkRoots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($sdkRoot in $sdkRoots) {
        $candidate = Get-ChildItem -Path $sdkRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1

        if ($candidate) {
            return $candidate.FullName
        }
    }

    throw "signtool.exe was not found. Install the Windows SDK or pass -SignToolPath."
}

function Resolve-InnoSetupCompilerPath {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidatePaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($candidatePaths.Count -gt 0) {
        return (Resolve-Path ($candidatePaths | Select-Object -First 1)).Path
    }

    throw "Inno Setup was not found. Install it first, or run 'winget install JRSoftware.InnoSetup'."
}

function Invoke-SignFile {
    param(
        [string]$FilePath,
        [string]$ResolvedSignToolPath,
        [string]$CertificateFile,
        [string]$CertificatePassword,
        [string]$CertificateThumbprint,
        [string]$TimestampUrl
    )

    if (-not (Test-Path $FilePath)) {
        throw "Cannot sign missing file: $FilePath"
    }

    $arguments = @(
        "sign",
        "/fd", "SHA256",
        "/td", "SHA256"
    )

    if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) {
        $arguments += @("/tr", $TimestampUrl)
    }

    if (-not [string]::IsNullOrWhiteSpace($CertificateFile)) {
        $arguments += @("/f", $CertificateFile)
        if (-not [string]::IsNullOrWhiteSpace($CertificatePassword)) {
            $arguments += @("/p", $CertificatePassword)
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        $arguments += @("/sha1", $CertificateThumbprint)
    } else {
        throw "Signing requires either -CertificateFile or -CertificateThumbprint."
    }

    $arguments += $FilePath

    & $ResolvedSignToolPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed for '$FilePath' with exit code $LASTEXITCODE."
    }
}

function Assert-AuthenticodeSignature {
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) {
        throw "Cannot verify signature for missing file: $FilePath"
    }

    $signature = Get-AuthenticodeSignature -FilePath $FilePath
    if ($signature.Status -ne "Valid") {
        throw "Authenticode signature validation failed for '$FilePath': $($signature.Status)"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedSourceDir = if ([System.IO.Path]::IsPathRooted($SourceDir)) {
    (Resolve-Path $SourceDir).Path
} else {
    (Resolve-Path (Join-Path $repoRoot $SourceDir)).Path
}
$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
} else {
    Join-Path $repoRoot $OutputDir
}
$issPath = Join-Path $repoRoot "packaging/windows/OpenStudio.iss"

if (-not (Test-Path (Join-Path $resolvedSourceDir "OpenStudio.exe"))) {
    throw "OpenStudio.exe was not found in '$resolvedSourceDir'. Build the Release target first."
}

New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$isccPath = Resolve-InnoSetupCompilerPath
$appExecutablePath = Join-Path $resolvedSourceDir "OpenStudio.exe"
$installerPath = Join-Path $resolvedOutputDir "OpenStudio-Setup-x64.exe"

$shouldSign = (-not [string]::IsNullOrWhiteSpace($CertificateFile)) -or (-not [string]::IsNullOrWhiteSpace($CertificateThumbprint))
if ($shouldSign) {
    $resolvedSignToolPath = Resolve-SignToolPath -ExplicitPath $SignToolPath
    Invoke-SignFile -FilePath $appExecutablePath `
        -ResolvedSignToolPath $resolvedSignToolPath `
        -CertificateFile $CertificateFile `
        -CertificatePassword $CertificatePassword `
        -CertificateThumbprint $CertificateThumbprint `
        -TimestampUrl $TimestampUrl

    Assert-AuthenticodeSignature -FilePath $appExecutablePath
}

& $isccPath `
    "/Qp" `
    "/DMyAppVersion=$Version" `
    "/DSourceDir=$resolvedSourceDir" `
    "/DOutputDir=$resolvedOutputDir" `
    $issPath

if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup packaging failed with exit code $LASTEXITCODE."
}

if ($shouldSign) {
    Invoke-SignFile -FilePath $installerPath `
        -ResolvedSignToolPath $resolvedSignToolPath `
        -CertificateFile $CertificateFile `
        -CertificatePassword $CertificatePassword `
        -CertificateThumbprint $CertificateThumbprint `
        -TimestampUrl $TimestampUrl

    Assert-AuthenticodeSignature -FilePath $installerPath
} else {
    Write-Host "Packaging unsigned Windows installer (zero-cost distribution path)."
}

Write-Host "Windows installer created in $resolvedOutputDir"
