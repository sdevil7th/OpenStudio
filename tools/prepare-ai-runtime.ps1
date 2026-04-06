param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $false)]
    [ValidateSet("x64", "arm64")]
    [string]$Architecture = "",

    [Parameter(Mandatory = $false)]
    [string]$RequirementsFile = "tools/ai-runtime-requirements.txt",

    [Parameter(Mandatory = $false)]
    [string]$RuntimeFamily = "",

    [Parameter(Mandatory = $false)]
    [string]$WindowsTorchIndexUrl = "https://download.pytorch.org/whl/cu121",

    [Parameter(Mandatory = $false)]
    [string[]]$WindowsTorchPackages = @("torch", "torchvision", "torchaudio"),

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$StandaloneReleaseTag = "20260325",

    [Parameter(Mandatory = $false)]
    [string]$StandalonePythonVersion = "3.10.20",

    [Parameter(Mandatory = $false)]
    [ValidateSet("install_only", "install_only_stripped")]
    [string]$StandaloneFlavor = "install_only",

    [Parameter(Mandatory = $false)]
    [string]$StandaloneCacheDir = "",

    [Parameter(Mandatory = $false)]
    [string[]]$ExpectedPackagedBackends = @(),

    [Parameter(Mandatory = $false)]
    [string]$SizeReportPath = "",

    [Parameter(Mandatory = $false)]
    [switch]$ForceRecreate
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return $PathValue
    }

    return Join-Path $PWD $PathValue
}

function Invoke-LoggedStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [string[]]$Command
    )

    Write-Host "==> $Description"
    Write-Host ('$ ' + ($Command -join ' '))

    $executable = $Command[0]
    $arguments = @()
    if ($Command.Count -gt 1) {
        $arguments = $Command[1..($Command.Count - 1)]
    }

    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ("openstudio-ai-runtime-stdout-" + [System.Guid]::NewGuid().ToString("N") + ".log")
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("openstudio-ai-runtime-stderr-" + [System.Guid]::NewGuid().ToString("N") + ".log")
    $formattedArguments = ($arguments | ForEach-Object {
        if ($_ -match '[\s"]') {
            '"' + ($_ -replace '"', '\"') + '"'
        }
        else {
            $_
        }
    }) -join ' '

    try {
        $process = Start-Process -FilePath $executable `
            -ArgumentList $formattedArguments `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        if (Test-Path $stdoutPath) {
            Get-Content -Path $stdoutPath | ForEach-Object { Write-Host $_ }
        }
        if (Test-Path $stderrPath) {
            Get-Content -Path $stderrPath | ForEach-Object { Write-Host $_ }
        }

        if ($process.ExitCode -ne 0) {
            throw "$Description failed with exit code $($process.ExitCode)."
        }
    }
    finally {
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-RuntimePython {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $candidates = @(
        (Join-Path $Root "python.exe"),
        (Join-Path $Root "python"),
        (Join-Path $Root "python\python.exe"),
        (Join-Path $Root "python\python"),
        (Join-Path $Root "Scripts\python.exe"),
        (Join-Path $Root "Scripts\python"),
        (Join-Path $Root "python\bin\python3"),
        (Join-Path $Root "python\bin\python"),
        (Join-Path $Root "bin\python3"),
        (Join-Path $Root "bin\python")
    )

    foreach ($candidate in $candidates) {
        if ((Test-Path $candidate) -and (Get-Item $candidate).PSIsContainer -eq $false) {
            return $candidate
        }
    }

    return $null
}

function Get-TargetArchitecture {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("windows", "macos")]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $false)]
        [string]$RequestedArchitecture
    )

    if (-not [string]::IsNullOrWhiteSpace($RequestedArchitecture)) {
        return $RequestedArchitecture
    }

    if ($TargetPlatform -eq "windows") {
        return "x64"
    }

    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
        return "arm64"
    }

    return "x64"
}

function Get-StandaloneTargetTriple {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("windows", "macos")]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $true)]
        [ValidateSet("x64", "arm64")]
        [string]$TargetArchitecture
    )

    switch ("$TargetPlatform/$TargetArchitecture") {
        "windows/x64" { return "x86_64-pc-windows-msvc" }
        "windows/arm64" { return "aarch64-pc-windows-msvc" }
        "macos/x64" { return "x86_64-apple-darwin" }
        "macos/arm64" { return "aarch64-apple-darwin" }
        default { throw "Unsupported runtime target combination '$TargetPlatform/$TargetArchitecture'." }
    }
}

function Get-StandaloneAssetName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonVersion,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseTag,

        [Parameter(Mandatory = $true)]
        [string]$TargetTriple,

        [Parameter(Mandatory = $true)]
        [ValidateSet("install_only", "install_only_stripped")]
        [string]$Flavor
    )

    return "cpython-$PythonVersion+$ReleaseTag-$TargetTriple-$Flavor.tar.gz"
}

function Resolve-ExtractedRuntimeRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExtractRoot
    )

    if (Resolve-RuntimePython -Root $ExtractRoot) {
        return $ExtractRoot
    }

    $childDirs = @(Get-ChildItem -Path $ExtractRoot -Directory -ErrorAction SilentlyContinue)
    foreach ($childDir in $childDirs) {
        if (Resolve-RuntimePython -Root $childDir.FullName) {
            return $childDir.FullName
        }
    }

    return $null
}

function Assert-PortableRuntimeLayout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimePath
    )

    $venvMarker = Join-Path $RuntimePath "pyvenv.cfg"
    if (Test-Path $venvMarker) {
        throw "Prepared AI runtime at '$RuntimePath' still contains pyvenv.cfg and is not relocatable."
    }

    $runtimePython = Resolve-RuntimePython -Root $RuntimePath
    if (-not $runtimePython) {
        throw "Prepared AI runtime at '$RuntimePath' did not contain a Python executable."
    }
}

function Invoke-DownloadFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,

        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DestinationPath) | Out-Null
    Invoke-WebRequest -Uri $Url -OutFile $DestinationPath -Headers @{ "User-Agent" = "OpenStudio-AI-Runtime" }
}

function Expand-StandaloneArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArchivePath,

        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
    Invoke-LoggedStep -Description "Extracting standalone Python runtime" -Command @(
        "tar",
        "-xzf",
        $ArchivePath,
        "-C",
        $DestinationPath
    )
}

function Get-PipInstallArguments {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("windows", "macos")]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $true)]
        [string]$RequirementsPath
    )

    $onlyBinaryPackages = switch ($TargetPlatform) {
        "windows" { "diffq-fixed" }
        "macos"   { "diffq" }
        default   { "" }
    }

    $arguments = @(
        "-m",
        "pip",
        "install",
        "--prefer-binary"
    )

    if (-not [string]::IsNullOrWhiteSpace($onlyBinaryPackages)) {
        $arguments += @("--only-binary", $onlyBinaryPackages)
    }

    $arguments += @(
        "-r",
        $RequirementsPath
    )

    return $arguments
}

function Resolve-RequirementsFile {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("windows", "macos")]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $true)]
        [string]$ConfiguredPath
    )

    $resolved = Resolve-AbsolutePath -PathValue $ConfiguredPath
    if ([System.IO.Path]::GetFileName($resolved) -ne "ai-runtime-requirements.txt") {
        return $resolved
    }

    $preferredFile = switch ($TargetPlatform) {
        "windows" { Resolve-AbsolutePath -PathValue "tools/ai-runtime-requirements-windows.txt" }
        "macos"   { Resolve-AbsolutePath -PathValue "tools/ai-runtime-requirements-macos.txt" }
        default   { $resolved }
    }

    if (Test-Path $preferredFile) {
        return $preferredFile
    }

    return $resolved
}

function Get-DefaultRuntimeFamily {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("windows", "macos")]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $true)]
        [ValidateSet("x64", "arm64")]
        [string]$TargetArchitecture,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedRequirementsPath
    )

    $requirementsName = [System.IO.Path]::GetFileName($ResolvedRequirementsPath).ToLowerInvariant()

    switch ("$TargetPlatform/$TargetArchitecture") {
        "windows/x64" {
            if ($requirementsName -like "*windows-cuda*") { return "windows-cuda-x64" }
            if ($requirementsName -like "*windows-directml*" -or $requirementsName -like "*windows.txt") { return "windows-directml-x64" }
            return "windows-x64"
        }
        "macos/arm64" { return "macos-arm64" }
        "macos/x64"   { return "macos-x64" }
        default       { return "$TargetPlatform-$TargetArchitecture" }
    }
}

function Remove-OptionalPath {
    param([string]$PathValue)

    if (Test-Path $PathValue) {
        Remove-Item -LiteralPath $PathValue -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Remove-MatchingItems {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.PSIsContainer -and $_.Name -eq $pattern) -or
                (-not $_.PSIsContainer -and $_.Name -like $pattern)
            } |
            ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
    }
}

function Optimize-RuntimePayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimeRootPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $true)]
        [string]$ResolvedRuntimeFamily
    )

    $sitePackages = Join-Path $RuntimeRootPath "Lib/site-packages"
    if (-not (Test-Path $sitePackages)) {
        $sitePackages = Join-Path $RuntimeRootPath "python/Lib/site-packages"
    }
    if (-not (Test-Path $sitePackages)) {
        $sitePackages = Join-Path $RuntimeRootPath "lib/python3.10/site-packages"
    }

    if (-not (Test-Path $sitePackages)) {
        return
    }

    Write-Host "==> Trimming non-runtime payload from prepared AI runtime"
    Remove-MatchingItems -Root $sitePackages -Patterns @("__pycache__", "*.pyc", "*.pyo")
    Remove-MatchingItems -Root $sitePackages -Patterns @("tests", "test")

    $torchRoot = Join-Path $sitePackages "torch"
    if (Test-Path $torchRoot) {
        Remove-OptionalPath (Join-Path $torchRoot "include")
        Remove-OptionalPath (Join-Path $torchRoot "share")
    }

    foreach ($packageName in @("pip", "setuptools", "wheel")) {
        Get-ChildItem -LiteralPath $sitePackages -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$packageName*" } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }

    $scriptsDir = Join-Path $RuntimeRootPath "Scripts"
    if ($TargetPlatform -eq "windows" -and (Test-Path $scriptsDir)) {
        Get-ChildItem -LiteralPath $scriptsDir -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(pip|wheel|easy_install)' } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-RuntimeCapabilityProbe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimePython,

        [Parameter(Mandatory = $true)]
        [string]$ProbeScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPlatform,

        [Parameter(Mandatory = $false)]
        [string[]]$ExpectedBackends = @()
    )

    $probeJson = & $RuntimePython $ProbeScriptPath --acceleration-mode auto 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "AI runtime capability probe failed. Output: $probeJson"
    }

    $payload = ($probeJson | Select-Object -Last 1) | ConvertFrom-Json -AsHashtable
    if (-not $payload.runtimeReady) {
        throw "AI runtime capability probe did not report a ready runtime."
    }

    if ($TargetPlatform -eq "windows") {
        if (-not ($payload.packagedBackends -contains "cuda" -or $payload.packagedBackends -contains "directml")) {
            throw "Windows AI runtime did not package any accelerated backend support."
        }
    }

    foreach ($expectedBackend in $ExpectedBackends) {
        if (-not ($payload.packagedBackends -contains $expectedBackend)) {
            throw "AI runtime capability probe did not report the expected packaged backend '$expectedBackend'."
        }
    }

    return $payload
}

function Test-RuntimeImport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimeRootPath
    )

    $runtimePython = Resolve-RuntimePython -Root $RuntimeRootPath
    if (-not $runtimePython) {
        return $false
    }

    if (Test-Path (Join-Path $RuntimeRootPath "pyvenv.cfg")) {
        return $false
    }

    & $runtimePython -c "import audio_separator.separator; print('ok')" 2>&1 | Out-Host
    return $LASTEXITCODE -eq 0
}

$resolvedRuntimeRoot = Resolve-AbsolutePath -PathValue $RuntimeRoot
$resolvedRequirementsFile = Resolve-RequirementsFile -TargetPlatform $Platform -ConfiguredPath $RequirementsFile
$probeScriptPath = Resolve-AbsolutePath -PathValue "tools/ai_runtime_probe.py"

if (-not (Test-Path $resolvedRequirementsFile)) {
    throw "Requirements file not found: $resolvedRequirementsFile"
}
if (-not (Test-Path $probeScriptPath)) {
    throw "AI runtime probe script not found: $probeScriptPath"
}

$resolvedArchitecture = Get-TargetArchitecture -TargetPlatform $Platform -RequestedArchitecture $Architecture
$resolvedRuntimeFamily = if ([string]::IsNullOrWhiteSpace($RuntimeFamily)) {
    Get-DefaultRuntimeFamily -TargetPlatform $Platform -TargetArchitecture $resolvedArchitecture -ResolvedRequirementsPath $resolvedRequirementsFile
} else {
    $RuntimeFamily
}
$targetTriple = Get-StandaloneTargetTriple -TargetPlatform $Platform -TargetArchitecture $resolvedArchitecture
$assetName = Get-StandaloneAssetName -PythonVersion $StandalonePythonVersion -ReleaseTag $StandaloneReleaseTag -TargetTriple $targetTriple -Flavor $StandaloneFlavor
$assetUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$StandaloneReleaseTag/$assetName"

$resolvedStandaloneCacheDir = if ([string]::IsNullOrWhiteSpace($StandaloneCacheDir)) {
    ""
} else {
    Resolve-AbsolutePath -PathValue $StandaloneCacheDir
}

if ((Test-Path $resolvedRuntimeRoot) -and -not $ForceRecreate.IsPresent) {
    if (Test-RuntimeImport -RuntimeRootPath $resolvedRuntimeRoot) {
        Write-Host "Reusing existing AI runtime at $resolvedRuntimeRoot"
        exit 0
    }

    Write-Warning "Existing AI runtime at '$resolvedRuntimeRoot' is invalid. Recreating it."
    Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("OpenStudio-AIRuntime-Prep-" + [System.Guid]::NewGuid().ToString("N"))
$downloadDir = Join-Path $workRoot "downloads"
$extractDir = Join-Path $workRoot "extract"
$archivePath = Join-Path $downloadDir $assetName
$cachedArchivePath = if ([string]::IsNullOrWhiteSpace($resolvedStandaloneCacheDir)) { "" } else { Join-Path $resolvedStandaloneCacheDir $assetName }

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedRuntimeRoot) | Out-Null

try {
    Write-Host "==> Preparing OpenStudio AI runtime from relocatable standalone Python"
    Write-Host "platform=$Platform"
    Write-Host "architecture=$resolvedArchitecture"
    Write-Host "runtimeFamily=$resolvedRuntimeFamily"
    Write-Host "standaloneReleaseTag=$StandaloneReleaseTag"
    Write-Host "standalonePythonVersion=$StandalonePythonVersion"
    Write-Host "standaloneAsset=$assetName"
    Write-Host "standaloneUrl=$assetUrl"

    if (-not [string]::IsNullOrWhiteSpace($cachedArchivePath) -and (Test-Path $cachedArchivePath)) {
        Write-Host "==> Reusing cached standalone Python runtime"
        New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
        Copy-Item -LiteralPath $cachedArchivePath -Destination $archivePath -Force
    }
    else {
        Write-Host "==> Downloading standalone Python runtime"
        Write-Host ('$ ' + $assetUrl)
        Invoke-DownloadFile -Url $assetUrl -DestinationPath $archivePath
        if (-not [string]::IsNullOrWhiteSpace($cachedArchivePath)) {
            New-Item -ItemType Directory -Force -Path $resolvedStandaloneCacheDir | Out-Null
            Copy-Item -LiteralPath $archivePath -Destination $cachedArchivePath -Force
        }
    }

    Expand-StandaloneArchive -ArchivePath $archivePath -DestinationPath $extractDir

    $extractedRuntimeRoot = Resolve-ExtractedRuntimeRoot -ExtractRoot $extractDir
    if (-not $extractedRuntimeRoot) {
        throw "Could not locate a Python runtime inside extracted standalone archive '$assetName'."
    }

    if (Test-Path $resolvedRuntimeRoot) {
        Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    Move-Item -LiteralPath $extractedRuntimeRoot -Destination $resolvedRuntimeRoot

    Assert-PortableRuntimeLayout -RuntimePath $resolvedRuntimeRoot

    $runtimePython = Resolve-RuntimePython -Root $resolvedRuntimeRoot
    if (-not $runtimePython) {
        throw "Prepared AI runtime did not contain a Python executable."
    }

    Invoke-LoggedStep -Description "Bootstrapping pip into standalone AI runtime" -Command @(
        $runtimePython,
        "-m",
        "ensurepip",
        "--upgrade"
    )

    Invoke-LoggedStep -Description "Upgrading Python packaging tools inside standalone AI runtime" -Command @(
        $runtimePython,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "pip",
        "setuptools",
        "wheel"
    )

    $pipInstallArguments = @($runtimePython)
    $pipInstallArguments += Get-PipInstallArguments -TargetPlatform $Platform -RequirementsPath $resolvedRequirementsFile
    Invoke-LoggedStep -Description "Installing AI runtime requirements into standalone runtime" -Command $pipInstallArguments

    if ($resolvedRuntimeFamily -eq "windows-cuda-x64") {
        $windowsTorchInstallArguments = @(
            $runtimePython,
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--index-url",
            $WindowsTorchIndexUrl
        ) + $WindowsTorchPackages
        Invoke-LoggedStep -Description "Installing CUDA-capable PyTorch wheels for Windows AI runtime" -Command $windowsTorchInstallArguments
    }

    Optimize-RuntimePayload -RuntimeRootPath $resolvedRuntimeRoot -TargetPlatform $Platform -ResolvedRuntimeFamily $resolvedRuntimeFamily

    Invoke-LoggedStep -Description "Verifying standalone AI runtime import" -Command @(
        $runtimePython,
        "-c",
        "import audio_separator.separator; print('ok')"
    )

    $capabilityProbe = Invoke-RuntimeCapabilityProbe `
        -RuntimePython $runtimePython `
        -ProbeScriptPath $probeScriptPath `
        -TargetPlatform $Platform `
        -ExpectedBackends $ExpectedPackagedBackends

    $metadata = [ordered]@{
        schemaVersion = 2
        platform = $Platform
        architecture = $resolvedArchitecture
        runtimeFamily = $resolvedRuntimeFamily
        runtimeVersion = $ExpectedRuntimeVersion
        preparedAtUtc = [DateTime]::UtcNow.ToString("o")
        requirementsFile = [System.IO.Path]::GetFileName($resolvedRequirementsFile)
        requirementsFileSha256 = (Get-FileHash -Algorithm SHA256 -Path $resolvedRequirementsFile).Hash.ToLowerInvariant()
        runtimeSource = [ordered]@{
            provider = "python-build-standalone"
            releaseTag = $StandaloneReleaseTag
            pythonVersion = $StandalonePythonVersion
            flavor = $StandaloneFlavor
            targetTriple = $targetTriple
            assetName = $assetName
            assetUrl = $assetUrl
        }
        capabilityProfile = [ordered]@{
            packagedBackends = @($capabilityProbe.packagedBackends)
            supportedBackends = @($capabilityProbe.supportedBackends)
            selectedBackend = [string]$capabilityProbe.selectedBackend
        }
    }

    $metadataPath = Join-Path $resolvedRuntimeRoot ".openstudio-ai-runtime.json"
    $metadata | ConvertTo-Json -Depth 6 | Set-Content -Path $metadataPath -Encoding UTF8

    if (-not [string]::IsNullOrWhiteSpace($SizeReportPath)) {
        & (Join-Path $PSScriptRoot "write-runtime-size-report.ps1") `
            -RuntimeRoot $resolvedRuntimeRoot `
            -OutputPath $SizeReportPath
    }

    Write-Host "Prepared standalone AI runtime at $resolvedRuntimeRoot"
}
finally {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
