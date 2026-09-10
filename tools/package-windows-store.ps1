param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$SourceDir = 'build/OpenStudio_artefacts/Release',
    [string]$OutputDir = 'dist/store',
    [string]$RuntimeCab = '',
    [string]$VCRedistDir = '',
    [string]$SdkBinDir = '',
    [string]$NotesFile = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
function Resolve-RepoPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $repoRoot $Path))
}
function Assert-MicrosoftSignature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Expected a trusted Microsoft signature: $Path ($($signature.Status))"
    }
}
function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed with exit code $LASTEXITCODE" }
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.0$') {
    throw 'Store Version must have four numeric components with a zero revision, e.g. 0.1.1.0.'
}
$packageVersion = [version]$Version
foreach ($part in @($packageVersion.Major, $packageVersion.Minor, $packageVersion.Build, $packageVersion.Revision)) {
    if ($part -gt 65535) { throw 'Package version components must be at most 65535.' }
}
$source = Resolve-RepoPath $SourceDir
$output = Resolve-RepoPath $OutputDir
foreach ($file in @('OpenStudio.exe', 'OpenStudioCrashReporter.exe', 'ffmpeg.exe', 'onnxruntime.dll',
                    'OpenStudio.version', 'webui/index.html', 'LICENSE', 'THIRD_PARTY_LICENSES.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) { throw "Missing package input: $file" }
}
$applicationVersion = (Get-Content -LiteralPath (Join-Path $source 'OpenStudio.version') -Raw).Trim()
$appVersion = [version]$applicationVersion
if ($appVersion.Major -ne $packageVersion.Major -or $appVersion.Minor -ne $packageVersion.Minor -or $appVersion.Build -ne $packageVersion.Build) {
    throw "Package version $Version does not match compiled app version $appVersion. Rebuild Release with the intended OPENSTUDIO_APP_VERSION."
}
# Preserve the exact application spelling (e.g. 0.1.01); the Store's four-part
# package version is a different identifier and must not select the notes file.
if ([string]::IsNullOrWhiteSpace($NotesFile)) {
    $NotesFile = Join-Path $PSScriptRoot ("../docs/releases/" + ($applicationVersion -replace '^v', '') + ".md")
}
& python (Join-Path $PSScriptRoot 'validate-release-notes.py') --version $applicationVersion --notes-file $NotesFile
if ($LASTEXITCODE -ne 0) { throw 'Release notes failed validation; packaging stopped.' }
foreach ($name in @('OpenStudio.exe', 'OpenStudioCrashReporter.exe')) {
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $source $name))
    if ($info.IsDebug -or $info.ProductName.TrimEnd() -cne 'OpenStudio' -or [version]$info.ProductVersion.TrimEnd() -ne $appVersion) {
        throw "Expected matching OpenStudio Release metadata: $name"
    }
}
if (!$SdkBinDir) {
    $sdkRoot = "${env:ProgramFiles(x86)}/Windows Kits/10/bin"
    $SdkBinDir = Get-ChildItem -LiteralPath $sdkRoot -Directory |
        Where-Object { $_.Name -match '^10\.0\.\d+\.0$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64' } |
        Where-Object { Test-Path (Join-Path $_ 'makeappx.exe') } | Select-Object -First 1
}
foreach ($tool in @('makeappx.exe', 'makepri.exe')) {
    if (!$SdkBinDir -or !(Test-Path (Join-Path $SdkBinDir $tool))) { throw "Windows SDK tool missing: $tool" }
}
if (!$VCRedistDir) {
    $vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
    $vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $VCRedistDir = Get-ChildItem -LiteralPath (Join-Path $vsPath 'VC/Redist/MSVC') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64/Microsoft.VC143.CRT' } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
foreach ($file in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')) {
    if (!$VCRedistDir -or !(Test-Path (Join-Path $VCRedistDir $file))) { throw "Missing Release VC++ runtime: $file" }
}
$runtime = Get-Content (Join-Path $repoRoot 'packaging/msix/webview2-runtime.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $output | Out-Null
# Each attempt has its own staging tree. Never recursively delete caller paths.
$work = Join-Path $output ('work-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'package'
$expanded = Join-Path $work 'runtime'
New-Item -ItemType Directory -Force -Path $stage, $expanded | Out-Null
if (!$RuntimeCab) {
    $RuntimeCab = Join-Path $work 'webview2.cab'
    Invoke-WebRequest -UseBasicParsing -Uri $runtime.url -OutFile $RuntimeCab
}
$RuntimeCab = Resolve-RepoPath $RuntimeCab
if ((Get-FileHash -LiteralPath $RuntimeCab -Algorithm SHA256).Hash -ine $runtime.sha256) { throw 'WebView2 archive SHA256 mismatch.' }
Assert-MicrosoftSignature $RuntimeCab
Invoke-Checked 'expand.exe' @($RuntimeCab, '-F:*', $expanded)
$runtimeExe = @(Get-ChildItem -LiteralPath $expanded -Filter msedgewebview2.exe -Recurse -File)
if ($runtimeExe.Count -ne 1) { throw 'Expected exactly one fixed WebView2 runtime.' }
Assert-MicrosoftSignature $runtimeExe[0].FullName
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($runtimeExe[0].FullName).ProductVersion -ne $runtime.version) { throw 'WebView2 runtime version mismatch.' }
Copy-Item -LiteralPath $runtimeExe[0].DirectoryName -Destination (Join-Path $stage 'WebView2Runtime') -Recurse
# A deliberate allowlist excludes PDBs, prerequisite installers, debug and AI
# download caches. Optional AI runtimes are installed into writable user storage.
foreach ($file in @('OpenStudio.exe', 'OpenStudioCrashReporter.exe', 'ffmpeg.exe', 'OpenStudio.version', 'LICENSE', 'THIRD_PARTY_LICENSES.md')) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination $stage
}
foreach ($file in Get-ChildItem -LiteralPath $source -Filter '*.dll' -File) {
    if ($file.Name -match '(?i)(ucrtbased|vcruntime\d+d|msvcp\d+d)\.dll$') { throw "Debug CRT in payload: $($file.Name)" }
    Copy-Item -LiteralPath $file.FullName -Destination $stage
}
foreach ($directory in @('webui', 'effects', 'licenses', 'models', 'presets', 'scripts')) {
    if (!(Test-Path -LiteralPath (Join-Path $source $directory) -PathType Container)) { throw "Missing runtime directory: $directory" }
    Copy-Item -LiteralPath (Join-Path $source $directory) -Destination $stage -Recurse
}
foreach ($dll in Get-ChildItem -LiteralPath $VCRedistDir -Filter '*.dll' -File) {
    Assert-MicrosoftSignature $dll.FullName
    Copy-Item -LiteralPath $dll.FullName -Destination $stage -Force
}
$manifest = (Get-Content (Join-Path $repoRoot 'packaging/msix/AppxManifest.xml.in') -Raw).Replace('@VERSION@', $Version)
[IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Path $assets | Out-Null
$icon = [Drawing.Image]::FromFile((Join-Path $repoRoot 'assets/icon-256x256.png'))
try {
    foreach ($entry in @(@('StoreLogo',50), @('Square44x44Logo',44), @('Square150x150Logo',150))) {
        $bitmap = [Drawing.Bitmap]::new([int]$entry[1], [int]$entry[1])
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($icon, 0, 0, [int]$entry[1], [int]$entry[1])
            $bitmap.Save((Join-Path $assets ($entry[0] + '.png')), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $icon.Dispose() }
$priConfig = Join-Path $work 'priconfig.xml'
Invoke-Checked (Join-Path $SdkBinDir 'makepri.exe') @('createconfig', '/cf', $priConfig, '/dq', 'en-US', '/o')
Invoke-Checked (Join-Path $SdkBinDir 'makepri.exe') @('new', '/pr', $stage, '/cf', $priConfig, '/of', (Join-Path $stage 'resources.pri'), '/o')
$package = Join-Path $output "OpenStudio-$Version-x64.msix"
if (Test-Path -LiteralPath $package) { throw "Output already exists; choose another OutputDir: $package" }
Invoke-Checked (Join-Path $SdkBinDir 'makeappx.exe') @('pack', '/d', $stage, '/p', $package, '/h', 'SHA256')
$unpacked = Join-Path $work 'verified'
Invoke-Checked (Join-Path $SdkBinDir 'makeappx.exe') @('unpack', '/p', $package, '/d', $unpacked)
foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File) {
    $relative = $file.FullName.Substring($stage.Length + 1)
    $copy = Join-Path $unpacked $relative
    if (!(Test-Path -LiteralPath $copy) -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) {
        throw "Package round-trip mismatch: $relative"
    }
}
$report = [ordered]@{
    package = $package; version = $Version; stage = $stage
    sha256 = (Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant()
    webView2Version = $runtime.version; vcRuntimeDirectory = $VCRedistDir
    packageValidation = 'pass'; payloadRoundTrip = 'pass'
    signature = 'unsigned-for-Microsoft-Store-submission'
    installedQualification = 'not_asserted'; storeCertification = 'not_asserted'
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'package-report.json') -Encoding UTF8
Write-Output "Store package created: $package"
Write-Output 'Package validation passed. Installed qualification and Store certification are separate gates.'
