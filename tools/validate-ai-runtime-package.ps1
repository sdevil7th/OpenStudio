param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedSha256 = "",

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = ""
)

$ErrorActionPreference = "Stop"

function Resolve-PythonExecutable {
    param([string]$Root)

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
    Expand-Archive -Path $resolvedArchive -DestinationPath $tempRoot -Force

    $runtimeRoot = $tempRoot
    $pythonExe = Resolve-PythonExecutable -Root $runtimeRoot
    if (-not $pythonExe) {
        $childDir = Get-ChildItem -Path $tempRoot -Directory | Select-Object -First 1
        if ($childDir) {
            $runtimeRoot = $childDir.FullName
            $pythonExe = Resolve-PythonExecutable -Root $runtimeRoot
        }
    }

    if (-not $pythonExe) {
        throw "AI runtime archive did not contain a Python executable."
    }

    & $pythonExe -c "import audio_separator.separator; print('ok')"
    if ($LASTEXITCODE -ne 0) {
        throw "AI runtime import verification failed for '$pythonExe'."
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedRuntimeVersion)) {
        Write-Host "Validated runtime version hint: $ExpectedRuntimeVersion"
    }

    Write-Host "AI runtime package validation passed for $Platform at $resolvedArchive"
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
