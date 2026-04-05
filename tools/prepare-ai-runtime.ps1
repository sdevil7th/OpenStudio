param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$PythonExecutable,

    [Parameter(Mandatory = $false)]
    [string]$RequirementsFile = "tools/ai-runtime-requirements.txt",

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [switch]$ForceRecreate
)

$ErrorActionPreference = "Stop"

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

function Resolve-RuntimePython {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $candidates = @(
        (Join-Path $Root "python.exe"),
        (Join-Path $Root "python"),
        (Join-Path $Root "Scripts\python.exe"),
        (Join-Path $Root "Scripts\python"),
        (Join-Path $Root "bin\python3"),
        (Join-Path $Root "bin\python")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

function Invoke-LoggedStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [string[]]$Command,

        [Parameter(Mandatory = $false)]
        [string]$WorkingDirectory = ""
    )

    Write-Host "==> $Description"
    Write-Host ('$ ' + ($Command -join ' '))

    $executable = $Command[0]
    $arguments = @()
    if ($Command.Count -gt 1) {
        $arguments = $Command[1..($Command.Count - 1)]
    }

    & $executable @arguments 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
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

function Test-RuntimeImport {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimeRootPath
    )

    $runtimePython = Resolve-RuntimePython -Root $RuntimeRootPath
    if (-not $runtimePython) {
        return $false
    }

    & $runtimePython -c "import audio_separator.separator; print('ok')" 2>&1 | Out-Host
    return $LASTEXITCODE -eq 0
}

$resolvedRuntimeRoot = Resolve-AbsolutePath -PathValue $RuntimeRoot
$resolvedPythonExecutable = Resolve-AbsolutePath -PathValue $PythonExecutable
$resolvedRequirementsFile = Resolve-AbsolutePath -PathValue $RequirementsFile

if (-not (Test-Path $resolvedPythonExecutable)) {
    throw "Python executable not found: $resolvedPythonExecutable"
}

if (-not (Test-Path $resolvedRequirementsFile)) {
    throw "Requirements file not found: $resolvedRequirementsFile"
}

if ((Test-Path $resolvedRuntimeRoot) -and -not $ForceRecreate.IsPresent) {
    if (Test-RuntimeImport -RuntimeRootPath $resolvedRuntimeRoot) {
        Write-Host "Reusing existing AI runtime at $resolvedRuntimeRoot"
        exit 0
    }

    Write-Warning "Existing AI runtime at '$resolvedRuntimeRoot' is invalid. Recreating it."
    Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedRuntimeRoot) | Out-Null

Invoke-LoggedStep -Description "Creating AI runtime virtual environment" -Command @(
    $resolvedPythonExecutable,
    "-m",
    "venv",
    $resolvedRuntimeRoot
)

$runtimePython = Resolve-RuntimePython -Root $resolvedRuntimeRoot
if (-not $runtimePython) {
    throw "Created AI runtime did not contain a Python executable."
}

Invoke-LoggedStep -Description "Upgrading Python packaging tools inside AI runtime" -Command @(
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

Invoke-LoggedStep -Description "Installing AI runtime requirements" -Command $pipInstallArguments

Invoke-LoggedStep -Description "Verifying AI runtime import" -Command @(
    $runtimePython,
    "-c",
    "import audio_separator.separator; print('ok')"
)

$metadata = [ordered]@{
    schemaVersion = 1
    platform = $Platform
    runtimeVersion = $ExpectedRuntimeVersion
    sourcePython = $resolvedPythonExecutable
    preparedAtUtc = [DateTime]::UtcNow.ToString("o")
}

$metadataPath = Join-Path $resolvedRuntimeRoot ".openstudio-ai-runtime.json"
$metadata | ConvertTo-Json -Depth 4 | Set-Content -Path $metadataPath -Encoding UTF8

Write-Host "Prepared AI runtime at $resolvedRuntimeRoot"
