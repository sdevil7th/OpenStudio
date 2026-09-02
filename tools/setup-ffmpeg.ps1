param(
    [Parameter(Mandatory = $false)]
    [string]$Destination = "",

    [Parameter(Mandatory = $false)]
    [string]$RuntimeArchive = "",

    [Parameter(Mandatory = $false)]
    [string]$CorrespondingSourceDestination = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $repoRoot "thirdparty/ffmpeg/runtime-lock.json"
if (-not (Test-Path -LiteralPath $lockPath)) {
    throw "FFmpeg runtime lock was not found: $lockPath"
}

$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$destinationPath = if ([string]::IsNullOrWhiteSpace($Destination)) {
    Join-Path $PSScriptRoot "ffmpeg-runtime"
} elseif ([System.IO.Path]::IsPathRooted($Destination)) {
    $Destination
} else {
    Join-Path $repoRoot $Destination
}

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
}

function Assert-SafeWorkspaceDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolvedRepo = Get-NormalizedPath -Path $repoRoot
    $resolvedPath = Get-NormalizedPath -Path $Path
    $prefix = $resolvedRepo + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedPath -eq $resolvedRepo -or
        -not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace FFmpeg runtime outside the repository workspace: $resolvedPath"
    }
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$Expected).ToLowerInvariant()) {
        throw "$Description checksum mismatch. Expected '$Expected' but found '$actual'."
    }
}

function Assert-RuntimeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $manifestPath = Join-Path $Path "runtime-manifest.json"
    $sourceLockPath = Join-Path $Path "source-lock.json"
    Assert-Sha256 -Path $manifestPath -Expected $lock.runtimeManifestSha256 -Description "FFmpeg runtime manifest"
    Assert-Sha256 -Path $sourceLockPath -Expected $lock.sourceLockSha256 -Description "FFmpeg source lock"

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.runtimeVersion -ne $lock.runtimeVersion -or $manifest.target -ne $lock.target) {
        throw "FFmpeg runtime manifest identity does not match runtime-lock.json."
    }
    if ($manifest.gplComponentsEnabled -ne $false -or $manifest.nonFreeComponentsEnabled -ne $false) {
        throw "FFmpeg runtime unexpectedly enables GPL or non-free components."
    }
    if ($manifest.license -ne "LGPL-2.1-or-later") {
        throw "Unexpected FFmpeg runtime license declaration: '$($manifest.license)'."
    }

    foreach ($file in $manifest.files) {
        $relativePath = ([string]$file.path).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $candidate = Join-Path $Path $relativePath
        Assert-Sha256 -Path $candidate -Expected $file.sha256 -Description "FFmpeg runtime file '$($file.path)'"
        if ((Get-Item -LiteralPath $candidate).Length -ne [long]$file.size) {
            throw "FFmpeg runtime file size mismatch for '$($file.path)'."
        }
    }

    $ffmpegPath = Join-Path $Path "ffmpeg.exe"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $versionOutput = & $ffmpegPath -hide_banner -version 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0 -or $versionOutput -notmatch 'ffmpeg version 8\.0\.1') {
        throw "The pinned FFmpeg runtime could not start or reported the wrong version.`n$versionOutput"
    }
    $global:LASTEXITCODE = 0
}

function Save-VerifiedAsset {
    param(
        [Parameter(Mandatory = $true)]$Asset,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $assetUrl = [Uri]([string]$Asset.url)
    if (-not $assetUrl.IsAbsoluteUri -or $assetUrl.Scheme -ne "https") {
        throw "$Description URL must be absolute HTTPS: $assetUrl"
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $assetUrl -OutFile $DestinationPath -UseBasicParsing
    Assert-Sha256 -Path $DestinationPath -Expected $Asset.sha256 -Description $Description
}

Assert-SafeWorkspaceDirectory -Path $destinationPath
$runtimeIsCurrent = $false
if (Test-Path -LiteralPath $destinationPath) {
    try {
        Assert-RuntimeDirectory -Path $destinationPath
        $runtimeIsCurrent = $true
    } catch {
        Write-Warning "The existing FFmpeg runtime is incomplete or stale and will be replaced: $($_.Exception.Message)"
    }
}
if ($runtimeIsCurrent -and [string]::IsNullOrWhiteSpace($CorrespondingSourceDestination)) {
    Write-Host "The pinned FFmpeg runtime is already installed and verified at: $destinationPath"
    exit 0
}

$workingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("openstudio-ffmpeg-" + [guid]::NewGuid().ToString("N"))
$downloadPath = Join-Path $workingDirectory "runtime.zip"
$extractPath = Join-Path $workingDirectory "runtime"

try {
    New-Item -ItemType Directory -Force -Path $workingDirectory, $extractPath | Out-Null

    if (-not $runtimeIsCurrent) {
        if ([string]::IsNullOrWhiteSpace($RuntimeArchive)) {
            Save-VerifiedAsset -Asset $lock.assets.runtime -DestinationPath $downloadPath -Description "FFmpeg runtime archive"
        } else {
            $resolvedArchive = (Resolve-Path -LiteralPath $RuntimeArchive).Path
            Assert-Sha256 -Path $resolvedArchive -Expected $lock.assets.runtime.sha256 -Description "FFmpeg runtime archive"
            Copy-Item -LiteralPath $resolvedArchive -Destination $downloadPath
        }

        Expand-Archive -LiteralPath $downloadPath -DestinationPath $extractPath -Force
        Assert-RuntimeDirectory -Path $extractPath

        if (Test-Path -LiteralPath $destinationPath) {
            Remove-Item -LiteralPath $destinationPath -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
        Move-Item -LiteralPath $extractPath -Destination $destinationPath
        Assert-RuntimeDirectory -Path $destinationPath
        Write-Host "Pinned FFmpeg runtime installed and verified at: $destinationPath"
    }

    if (-not [string]::IsNullOrWhiteSpace($CorrespondingSourceDestination)) {
        $sourceDestination = if ([System.IO.Path]::IsPathRooted($CorrespondingSourceDestination)) {
            $CorrespondingSourceDestination
        } else {
            Join-Path $repoRoot $CorrespondingSourceDestination
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourceDestination) | Out-Null
        Save-VerifiedAsset -Asset $lock.assets.correspondingSource -DestinationPath $sourceDestination -Description "FFmpeg complete corresponding-source archive"
        Write-Host "Verified FFmpeg corresponding source staged at: $sourceDestination"
    }
} finally {
    if (Test-Path -LiteralPath $workingDirectory) {
        Remove-Item -LiteralPath $workingDirectory -Recurse -Force
    }
    $global:LASTEXITCODE = 0
}
