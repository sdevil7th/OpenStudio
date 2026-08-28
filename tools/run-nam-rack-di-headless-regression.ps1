param(
    [string]$AppPath,
    [string]$OutputRoot,
    [string]$ModelPath,
    [string]$PresetPath,
    [string]$InputPath,
    [string]$Label = "nam-rack-di-regression",
    [int]$TimeoutSeconds = 180,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path $repoRoot "resources\test_fixtures\guitar_di"
$fixtureArchive = Join-Path $fixtureRoot "EGuitarFSBS-direct-SFZ+FLAC-20220911.7z"
$fixtureExtractDir = Join-Path $fixtureRoot "EGuitarFSBS-direct SFZ+FLAC-20220911"
$fixtureUrl = "https://github.com/freepats/electric-guitar-FSBS-direct/releases/download/2022-09-11/EGuitarFSBS-direct-SFZ%2BFLAC-20220911.7z"
$fixtureSha256 = "7AB2A4551BB8847342D6FD10CC56E0642FCAF43F3BE8D665269C4DC9BFBBD599"

function Resolve-AppPath {
    if ($AppPath -and (Test-Path $AppPath)) {
        return (Resolve-Path $AppPath).Path
    }

    $candidates = @(
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Debug\OpenStudio.exe"),
        (Join-Path $repoRoot "build-check\OpenStudio_artefacts\Release\OpenStudio.exe"),
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Release\OpenStudio.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    throw "OpenStudio.exe not found. Build first or pass -AppPath."
}

function Resolve-FFmpegPath {
    $candidates = @(
        (Join-Path $repoRoot "tools\ffmpeg.exe"),
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Debug\ffmpeg.exe"),
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Release\ffmpeg.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    $fromPath = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    throw "ffmpeg.exe not found. Expected tools\ffmpeg.exe or ffmpeg on PATH."
}

function New-RunDirectory {
    $root = if ($OutputRoot) { $OutputRoot } else { Join-Path $repoRoot "tmp_nam_rack_runs" }
    $safeLabel = ($Label -replace '[^A-Za-z0-9._-]', '_')
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $dir = Join-Path $root "${stamp}_${safeLabel}"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function Quote-ProcessArgument([string]$value) {
    if ($null -eq $value) {
        return '""'
    }
    if ($value -notmatch '[\s"]') {
        return $value
    }
    return '"' + ($value -replace '"', '\"') + '"'
}

function Ensure-DIFixtureBank {
    New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null

    $sampleProbe = Get-ChildItem -Path $fixtureExtractDir -Recurse -File -Filter "E2_s1_01.flac" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sampleProbe) {
        if (Test-Path $fixtureArchive) {
            $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArchive).Hash
            if ($archiveHash -ne $fixtureSha256) {
                throw "Existing DI fixture checksum mismatch. Delete $fixtureArchive and run the harness again."
            }
        }
        return
    }

    if (-not (Test-Path $fixtureArchive)) {
        Write-Host "Downloading CC0 clean DI guitar fixture bank..."
        $temporaryArchive = "$fixtureArchive.download"
        Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
        try {
            Invoke-WebRequest -Uri $fixtureUrl -OutFile $temporaryArchive
            $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryArchive).Hash
            if ($downloadHash -ne $fixtureSha256) {
                throw "Downloaded DI fixture checksum mismatch. Expected $fixtureSha256, received $downloadHash."
            }
            Move-Item -LiteralPath $temporaryArchive -Destination $fixtureArchive -Force
        } finally {
            Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
        }
    }

    $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixtureArchive).Hash
    if ($archiveHash -ne $fixtureSha256) {
        throw "Existing DI fixture checksum mismatch. Delete $fixtureArchive and run the harness again."
    }

    Write-Host "Extracting clean DI guitar fixture bank..."
    $sevenZipCandidates = @(
        (Join-Path $env:ProgramFiles "7-Zip\7z.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe")
    )
    $sevenZip = $sevenZipCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if ($sevenZip) {
        & $sevenZip x $fixtureArchive "-o$fixtureRoot" -y | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "7-Zip failed to extract fixture archive."
        }
        return
    }

    & tar -xf $fixtureArchive -C $fixtureRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Could not extract fixture archive. Install 7-Zip or extract $fixtureArchive into $fixtureRoot."
    }
}

function Resolve-SamplePath([string]$name) {
    $sample = Get-ChildItem -Path $fixtureExtractDir -Recurse -File -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sample) {
        throw "Missing DI fixture sample: $name"
    }
    return $sample.FullName
}

function New-DIFixtureWav([string]$runDir) {
    $ffmpeg = Resolve-FFmpegPath
    $fixtureWav = Join-Path $runDir "di_fixture_riff_cc0.wav"
    $sampleNames = @(
        "E2_s1_01.flac",
        "A2_s2_01.flac",
        "D3_s3_01.flac",
        "G3_s4_01.flac",
        "B3_s5_01.flac",
        "E4_s6_01.flac",
        "C#4_s5_01.flac",
        "B4_s6_01.flac"
    )
    $samplePaths = $sampleNames | ForEach-Object { Resolve-SamplePath $_ }

    $args = @("-hide_banner", "-y")
    foreach ($samplePath in $samplePaths) {
        $args += @("-i", $samplePath)
    }

    $segments = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $samplePaths.Count; $i++) {
        $segments.Add("[$($i):a]atrim=0:0.72,afade=t=in:st=0:d=0.005,afade=t=out:st=0.62:d=0.10,asetpts=N/SR/TB[a$i]")
    }
    $concatInputs = (0..($samplePaths.Count - 1) | ForEach-Object { "[a$_]" }) -join ""
    $filter = ($segments -join ";") + ";${concatInputs}concat=n=$($samplePaths.Count):v=0:a=1,volume=-3dB,aresample=48000[out]"

    $args += @("-filter_complex", $filter, "-map", "[out]", "-c:a", "pcm_f32le", $fixtureWav)
    & $ffmpeg @args | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $fixtureWav)) {
        throw "Failed to create DI fixture WAV."
    }

    return $fixtureWav
}

if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot "build") --config Debug
    if ($LASTEXITCODE -ne 0) {
        throw "Debug build failed."
    }
}

$runDir = New-RunDirectory
$fixtureWav = if ($InputPath) {
    if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
        throw "DI input file not found: $InputPath"
    }
    (Resolve-Path -LiteralPath $InputPath).Path
} else {
    Ensure-DIFixtureBank
    New-DIFixtureWav $runDir
}
$resultPath = Join-Path $runDir "nam_rack_di_regression_result.json"
$resolvedAppPath = Resolve-AppPath
$defaultVictoryPresetPath = Join-Path $env:APPDATA "OpenStudio\Presets\OpenStudio_NAM_Rack\Victory Nolly 5150.ospreset"
$resolvedPresetPath = if ($PresetPath) {
    if (-not (Test-Path -LiteralPath $PresetPath -PathType Leaf)) {
        throw "NAM Rack preset file not found: $PresetPath"
    }
    (Resolve-Path -LiteralPath $PresetPath).Path
} elseif (Test-Path -LiteralPath $defaultVictoryPresetPath -PathType Leaf) {
    # The PRE-EQ -> Maxon objective contract below is defined against the
    # stored Victory Nolly 5150 voice. Prefer that deterministic fixture when
    # the caller has not supplied an explicit preset override.
    (Resolve-Path -LiteralPath $defaultVictoryPresetPath).Path
} else {
    $null
}

$argumentList = @(
    "--nam-rack-di-regression-headless",
    $fixtureWav,
    "--output-dir",
    $runDir,
    "--report",
    $resultPath
)

if ($ModelPath) {
    $argumentList += @("--model-path", (Resolve-Path $ModelPath).Path)
}

$processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processStartInfo.FileName = $resolvedAppPath
$processStartInfo.Arguments = ($argumentList | ForEach-Object { Quote-ProcessArgument $_ }) -join " "
$processStartInfo.UseShellExecute = $false
$processStartInfo.CreateNoWindow = $true
$processStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$processStartInfo.RedirectStandardOutput = $true
$processStartInfo.RedirectStandardError = $true
if ($resolvedPresetPath) {
    $processStartInfo.EnvironmentVariables["OPENSTUDIO_NAM_RACK_BEST_CLEAN_PRESET_PATH"] = $resolvedPresetPath
}

$process = [System.Diagnostics.Process]::Start($processStartInfo)
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "NAM Rack DI headless regression timed out after $TimeoutSeconds seconds."
}

$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
if ($stdout) {
    Write-Host $stdout
}
if ($stderr) {
    Write-Warning $stderr
}
if ($process.ExitCode -ne 0) {
    Write-Warning "NAM Rack DI headless regression exited with code $($process.ExitCode). Reading result if available."
}

if (-not (Test-Path $resultPath)) {
    throw "NAM Rack DI headless regression did not write result JSON: $resultPath"
}

$result = Get-Content -Raw -Path $resultPath | ConvertFrom-Json
Write-Host "NAM Rack DI regression result: $resultPath"
Write-Host "DI input: $fixtureWav"
if ($resolvedPresetPath) {
    Write-Host "NAM Rack preset fixture: $resolvedPresetPath"
}
Write-Host "Objective gate status: $($result.objectiveGateStatus)"
Write-Host "Subjective quality: $($result.subjectiveQuality)"
Write-Host "Summary: $($result.summary)"

if ($result.artifacts) {
    Write-Host "Clean DI: $($result.artifacts.cleanDI)"
    Write-Host "Routed input: $($result.artifacts.routedInput)"
    Write-Host "Processed output: $($result.artifacts.processedOutput)"
    Write-Host "Cab IR: $($result.artifacts.cabIR)"
}

if ($result.checks) {
    $result.checks | ForEach-Object {
        Write-Host ("[{0}] {1} - {2}" -f $_.status, $_.id, $_.detail)
    }
}

if ($result.objectiveGateStatus -eq "fail" -or $process.ExitCode -ne 0) {
    exit 2
}
exit 0
