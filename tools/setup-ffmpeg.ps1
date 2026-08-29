# setup-ffmpeg.ps1
# Downloads FFmpeg essentials build and extracts ffmpeg.exe to tools/
# Run this once: powershell -ExecutionPolicy Bypass -File tools/setup-ffmpeg.ps1

$toolsDir = $PSScriptRoot
$ffmpegExe = Join-Path $toolsDir "ffmpeg.exe"
$expectedFfmpegSha256 = "5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d"

function Assert-PinnedFfmpeg {
    param([Parameter(Mandatory = $true)][string]$Path)

    $actualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedFfmpegSha256) {
        throw "Downloaded ffmpeg.exe does not match the audited OpenStudio build. Expected '$expectedFfmpegSha256' but found '$actualSha256'. Update the pinned binary, provenance, legal notices, and packaging checks together."
    }
}

if (Test-Path $ffmpegExe) {
    Assert-PinnedFfmpeg -Path $ffmpegExe
    Write-Host "The pinned ffmpeg.exe already exists in tools/ and passed checksum validation."
    exit 0
}

Write-Host "Downloading FFmpeg essentials build..."

$zipUrl = "https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip"
$expectedArchiveSha256 = "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673"
$zipPath = Join-Path $toolsDir "ffmpeg-download.zip"
$extractDir = Join-Path $toolsDir "ffmpeg-extract"

try {
    # Download
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    $actualArchiveSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualArchiveSha256 -ne $expectedArchiveSha256) {
        throw "FFmpeg archive checksum mismatch. Expected '$expectedArchiveSha256' but found '$actualArchiveSha256'."
    }
    Write-Host "Download complete. Extracting..."

    # Extract
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # Find ffmpeg.exe inside the extracted folder (it's in a subfolder like ffmpeg-7.1-essentials_build/bin/)
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName -Destination $ffmpegExe
        try {
            Assert-PinnedFfmpeg -Path $ffmpegExe
        } catch {
            Remove-Item -LiteralPath $ffmpegExe -Force
            throw
        }
        Write-Host "ffmpeg.exe installed to: $ffmpegExe"
    } else {
        Write-Error "Could not find ffmpeg.exe in the downloaded archive."
        exit 1
    }
} finally {
    # Cleanup
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
}

Write-Host "FFmpeg setup complete."
