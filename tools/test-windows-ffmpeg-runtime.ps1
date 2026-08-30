param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeArchive,

    [Parameter(Mandatory = $false)]
    [string]$WorkingDirectory = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $RuntimeArchive)) {
    throw "FFmpeg runtime archive was not found: $RuntimeArchive"
}

$resolvedArchive = (Resolve-Path -LiteralPath $RuntimeArchive).Path
$ownsWorkingDirectory = [string]::IsNullOrWhiteSpace($WorkingDirectory)
if ($ownsWorkingDirectory) {
    $WorkingDirectory = Join-Path ([IO.Path]::GetTempPath()) ("OpenStudio-FFmpeg-QA-" + [guid]::NewGuid().ToString("N"))
}
New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null
$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$runtimeDir = Join-Path $resolvedWorkingDirectory "runtime"
$fixtureDir = Join-Path $resolvedWorkingDirectory "fixtures with spaces-音频"
New-Item -ItemType Directory -Force -Path $runtimeDir, $fixtureDir | Out-Null

try {
    Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $runtimeDir -Force
    $ffmpeg = Join-Path $runtimeDir "ffmpeg.exe"
    if (-not (Test-Path -LiteralPath $ffmpeg)) {
        throw "Runtime archive does not contain ffmpeg.exe at its root."
    }

    $manifestPath = Join-Path $runtimeDir "runtime-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "Runtime archive does not contain runtime-manifest.json."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.gplComponentsEnabled -ne $false -or $manifest.nonFreeComponentsEnabled -ne $false) {
        throw "Runtime manifest must explicitly disable GPL and non-free components."
    }

    foreach ($file in $manifest.files) {
        $path = Join-Path $runtimeDir ([string]$file.path)
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Runtime manifest file is missing: $($file.path)"
        }
        $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne ([string]$file.sha256).ToLowerInvariant()) {
            throw "Runtime manifest checksum mismatch: $($file.path)"
        }
    }

    function Invoke-FFmpeg {
        param(
            [Parameter(Mandatory = $true)][string[]]$Arguments,
            [Parameter(Mandatory = $false)][switch]$ExpectFailure
        )
        # Windows PowerShell 5 promotes a native program's stderr records to
        # terminating errors when the caller uses Stop. Capture them under
        # Continue so expected FFmpeg diagnostics can be inspected uniformly
        # in PowerShell 5 and 7.
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = & $ffmpeg @Arguments 2>&1 | Out-String
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($ExpectFailure) {
            if ($exitCode -eq 0) { throw "FFmpeg unexpectedly succeeded: $($Arguments -join ' ')" }
            $global:LASTEXITCODE = 0
        } elseif ($exitCode -ne 0) {
            throw "FFmpeg failed with exit code $exitCode.`nCommand: $($Arguments -join ' ')`n$output"
        }
        return $output
    }

    $versionOutput = Invoke-FFmpeg -Arguments @("-hide_banner", "-version")
    if ($versionOutput -notmatch "ffmpeg version 8\.0\.1") { throw "Unexpected FFmpeg version.`n$versionOutput" }
    if ($versionOutput -notmatch "--disable-gpl") { throw "FFmpeg build does not report --disable-gpl." }
    if ($versionOutput -match "--enable-gpl|--enable-nonfree") { throw "FFmpeg build enabled a forbidden license mode." }

    $encoderOutput = Invoke-FFmpeg -Arguments @("-hide_banner", "-encoders")
    foreach ($encoder in @("libmp3lame", "libvorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_s16be", "pcm_s24be", "pcm_f32be", "mjpeg")) {
        if ($encoderOutput -notmatch "(?m)\b$([regex]::Escape($encoder))\b") { throw "Required encoder is missing: $encoder" }
    }

    $filterOutput = Invoke-FFmpeg -Arguments @("-hide_banner", "-filters")
    foreach ($filter in @("atempo", "asetrate", "aresample", "scale", "sine", "testsrc2")) {
        if ($filterOutput -notmatch "(?m)\b$([regex]::Escape($filter))\b") { throw "Required filter is missing: $filter" }
    }

    $decoderOutput = Invoke-FFmpeg -Arguments @("-hide_banner", "-decoders")
    foreach ($decoder in @("aac", "h264", "hevc", "vp9", "av1", "mp3", "flac", "vorbis", "opus")) {
        if ($decoderOutput -notmatch "(?m)\b$([regex]::Escape($decoder))\b") { throw "Required decoder is missing: $decoder" }
    }

    $sourceWav = Join-Path $fixtureDir "source 48k stereo.wav"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "2", "-c:a", "pcm_f32le", "-y", $sourceWav) | Out-Null

    $outputs = @(
        @{ Path = (Join-Path $fixtureDir "render.mp3"); Args = @("-i", $sourceWav, "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "320k") },
        @{ Path = (Join-Path $fixtureDir "render.ogg"); Args = @("-i", $sourceWav, "-ar", "48000", "-ac", "1", "-c:a", "libvorbis", "-q:a", "6") },
        @{ Path = (Join-Path $fixtureDir "render.flac"); Args = @("-i", $sourceWav, "-ar", "96000", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24") },
        @{ Path = (Join-Path $fixtureDir "render.aiff"); Args = @("-i", $sourceWav, "-c:a", "pcm_s24be") }
    )
    foreach ($item in $outputs) {
        Invoke-FFmpeg -Arguments (@("-hide_banner", "-loglevel", "error", "-y") + $item.Args + @($item.Path)) | Out-Null
        if (-not (Test-Path -LiteralPath $item.Path) -or (Get-Item -LiteralPath $item.Path).Length -lt 1024) {
            throw "FFmpeg produced an empty or implausibly small output: $($item.Path)"
        }
        $decoded = "$($item.Path).decoded.wav"
        Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $item.Path, "-c:a", "pcm_s16le", "-y", $decoded) | Out-Null
        if ((Get-Item -LiteralPath $decoded).Length -lt 10000) { throw "Decoded validation output is too small: $decoded" }
    }

    $stretched = Join-Path $fixtureDir "stretched.wav"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $sourceWav, "-af", "atempo=0.75", "-y", $stretched) | Out-Null
    $pitched = Join-Path $fixtureDir "pitched.wav"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $sourceWav, "-af", "asetrate=48000*1.259921,aresample=48000,atempo=0.793701", "-y", $pitched) | Out-Null

    $video = Join-Path $fixtureDir "video fixture.mp4"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", $video) | Out-Null
    $videoAudio = Join-Path $fixtureDir "video audio.wav"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $video, "-vn", "-c:a", "pcm_s24le", "-ar", "48000", "-y", $videoAudio) | Out-Null
    $videoFrame = Join-Path $fixtureDir "video frame.jpg"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", $video, "-vf", "scale=160:90", "-frames:v", "1", "-q:v", "2", "-y", $videoFrame) | Out-Null

    $videoOnly = Join-Path $fixtureDir "video without audio.mp4"
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1", "-an", "-c:v", "mpeg4", "-y", $videoOnly) | Out-Null
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $videoOnly, "-vn", "-c:a", "pcm_s16le", "-y", (Join-Path $fixtureDir "must-not-exist.wav")) -ExpectFailure | Out-Null

    $corrupt = Join-Path $fixtureDir "corrupt input.mp3"
    [IO.File]::WriteAllText($corrupt, "not an audio file")
    Invoke-FFmpeg -Arguments @("-hide_banner", "-loglevel", "error", "-i", $corrupt, "-y", (Join-Path $fixtureDir "corrupt output.wav")) -ExpectFailure | Out-Null

    Write-Host "OpenStudio FFmpeg Windows runtime regression passed."
    $global:LASTEXITCODE = 0
} finally {
    if ($ownsWorkingDirectory -and (Test-Path -LiteralPath $resolvedWorkingDirectory)) {
        Remove-Item -LiteralPath $resolvedWorkingDirectory -Recurse -Force
    }
}
