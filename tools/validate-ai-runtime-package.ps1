param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedSha256 = "",

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeFamily = "",

    [Parameter(Mandatory = $false)]
    [string[]]$ExpectedPackagedBackends = @()
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$probeScriptPath = Join-Path $repoRoot "tools/ai_runtime_probe.py"
if (-not (Test-Path $probeScriptPath)) {
    throw "AI runtime probe script not found: $probeScriptPath"
}

function Resolve-PythonExecutable {
    param([string]$Root)

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

function Resolve-ExtractedRuntimeRoot {
    param([string]$ExtractRoot)

    if (Resolve-PythonExecutable -Root $ExtractRoot) {
        return $ExtractRoot
    }

    $childDir = Get-ChildItem -Path $ExtractRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($childDir -and (Resolve-PythonExecutable -Root $childDir.FullName)) {
        return $childDir.FullName
    }

    return $null
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$resolvedArchive = if ([System.IO.Path]::IsPathRooted($ArchivePath)) {
    $ArchivePath
} else {
    Join-Path $PWD $ArchivePath
}

if (-not (Test-Path $resolvedArchive)) {
    throw "AI runtime archive not found: $resolvedArchive"
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -Path $resolvedArchive).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "AI runtime archive checksum mismatch. Expected '$ExpectedSha256' but found '$actualSha256'."
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("OpenStudio-AIRuntime-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
    if ($Platform -eq "macos") {
        & /usr/bin/ditto -x -k $resolvedArchive $tempRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Native macOS runtime archive extraction failed with exit code $LASTEXITCODE."
        }
    }
    else {
        Expand-Archive -Path $resolvedArchive -DestinationPath $tempRoot -Force
    }

    $runtimeRoot = Resolve-ExtractedRuntimeRoot -ExtractRoot $tempRoot
    if (-not $runtimeRoot) {
        throw "AI runtime archive did not contain a Python executable."
    }

    $venvMarker = Join-Path $runtimeRoot "pyvenv.cfg"
    Assert-True (-not (Test-Path $venvMarker)) "AI runtime archive contains pyvenv.cfg and is not relocatable."

    $pythonExe = Resolve-PythonExecutable -Root $runtimeRoot
    Assert-True (-not [string]::IsNullOrWhiteSpace($pythonExe)) "AI runtime archive did not contain a Python executable."

    $metadataPath = Join-Path $runtimeRoot ".openstudio-ai-runtime.json"
    Assert-True (Test-Path $metadataPath) "AI runtime archive is missing .openstudio-ai-runtime.json."

    $metadata = Get-Content -Path $metadataPath -Raw | ConvertFrom-Json
    Assert-True ($metadata.schemaVersion -ge 2) "AI runtime metadata schemaVersion is invalid."

    if (-not [string]::IsNullOrWhiteSpace($ExpectedRuntimeVersion)) {
        Assert-True ($metadata.runtimeVersion -eq $ExpectedRuntimeVersion) "AI runtime metadata runtimeVersion '$($metadata.runtimeVersion)' did not match expected '$ExpectedRuntimeVersion'."
        Write-Host "Validated runtime version hint: $ExpectedRuntimeVersion"
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedRuntimeFamily)) {
        Assert-True ($metadata.runtimeFamily -eq $ExpectedRuntimeFamily) "AI runtime metadata runtimeFamily '$($metadata.runtimeFamily)' did not match expected '$ExpectedRuntimeFamily'."
        Write-Host "Validated runtime family hint: $ExpectedRuntimeFamily"
    }

    $diagnosticsJson = & $pythonExe -c "import json, pathlib, sys; import audio_separator.separator; print(json.dumps({'ok': True, 'executable': sys.executable, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix, 'version': sys.version, 'cwd': str(pathlib.Path.cwd())}))" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "AI runtime import verification failed for '$pythonExe'. Output: $diagnosticsJson"
    }

    $diagnostics = ($diagnosticsJson | Select-Object -Last 1) | ConvertFrom-Json
    Assert-True ($diagnostics.ok -eq $true) "AI runtime diagnostics did not report success."
    Assert-True ($diagnostics.prefix -eq $diagnostics.base_prefix) "AI runtime prefix '$($diagnostics.prefix)' does not match base_prefix '$($diagnostics.base_prefix)'. This runtime still looks like a venv."

    $runtimeRootResolved = [System.IO.Path]::GetFullPath($runtimeRoot)
    $pythonResolved = [System.IO.Path]::GetFullPath([string]$diagnostics.executable)
    Assert-True ($pythonResolved.StartsWith($runtimeRootResolved, [System.StringComparison]::OrdinalIgnoreCase)) "AI runtime executable '$pythonResolved' was not launched from inside '$runtimeRootResolved'."

    $probeJson = & $pythonExe $probeScriptPath --acceleration-mode auto 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "AI runtime capability probe failed for '$pythonExe'. Output: $probeJson"
    }

    $probe = ($probeJson | Select-Object -Last 1) | ConvertFrom-Json
    Assert-True ($probe.runtimeReady -eq $true) "AI runtime capability probe did not report a ready runtime."
    Assert-True ($probe.selectedBackend -in @("cuda", "directml", "coreml", "mps", "cpu")) "AI runtime capability probe returned an unexpected selectedBackend '$($probe.selectedBackend)'."
    Assert-True ($probe.supportedBackends.Count -ge 1) "AI runtime capability probe did not report supportedBackends."

    if ($Platform -eq "windows") {
        Assert-True (($probe.packagedBackends -contains "cuda") -or ($probe.packagedBackends -contains "directml")) "Windows AI runtime probe did not report any packaged accelerated backend."
    }

    if ($Platform -eq "macos") {
        Assert-True (($probe.packagedBackends -contains "coreml") -or ($probe.packagedBackends -contains "mps") -or ($probe.packagedBackends -contains "cpu")) "macOS AI runtime probe did not report packaged backends."
    }

    foreach ($expectedBackend in $ExpectedPackagedBackends) {
        Assert-True (($probe.packagedBackends -contains $expectedBackend)) "AI runtime probe did not report expected packaged backend '$expectedBackend'."
    }

    Write-Host "AI runtime package validation passed for $Platform at $resolvedArchive"
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
