# setup-ffmpeg.ps1
# Downloads FFmpeg essentials build and extracts ffmpeg.exe to tools/
# Run this once: powershell -ExecutionPolicy Bypass -File tools/setup-ffmpeg.ps1

$toolsDir = $PSScriptRoot
$ffmpegExe = Join-Path $toolsDir "ffmpeg.exe"

if (Test-Path $ffmpegExe) {
    Write-Host "ffmpeg.exe already exists in tools/. Skipping download."
    exit 0
}

Write-Host "Downloading FFmpeg essentials build..."

$zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$zipPath = Join-Path $toolsDir "ffmpeg-download.zip"
$extractDir = Join-Path $toolsDir "ffmpeg-extract"

try {
    # Download
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "Download complete. Extracting..."

    # Extract
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # Find ffmpeg.exe inside the extracted folder (it's in a subfolder like ffmpeg-7.1-essentials_build/bin/)
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName -Destination $ffmpegExe
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
