param([string]$SourceDir = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'package-windows-store.ps1'
$testRoot = Join-Path $repoRoot ('output/store-negative-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$count = 0
function Expect-Rejection([string]$Name, [hashtable]$Arguments, [string]$Message) {
    try { & $script @Arguments | Out-Null }
    catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw "$Name failed for unexpected reason: $_" }
        Write-Output "PASS $Name"
        $script:count++
        return
    }
    throw "$Name was not rejected"
}
Expect-Rejection 'non-numeric version' @{ Version = '0.1.beta.0' } 'four numeric components'
Expect-Rejection 'Store reserved revision' @{ Version = '0.1.1.1' } 'zero revision'
Expect-Rejection 'overflow version' @{ Version = '65536.1.1.0' } 'at most 65535'
Expect-Rejection 'incomplete input' @{ Version = '0.1.1.0'; SourceDir = $testRoot } 'Missing package input'
# This pre-build test needs only the inputs examined before version rejection.
# Keep it independent of a developer's existing Release output or the CI build.
if (!$SourceDir) {
    $SourceDir = Join-Path $testRoot 'source'
    New-Item -ItemType Directory -Path (Join-Path $SourceDir 'webui') -Force | Out-Null
    foreach ($name in @('OpenStudio.exe', 'OpenStudioCrashReporter.exe', 'ffmpeg.exe', 'onnxruntime.dll',
                        'webui/index.html', 'LICENSE', 'THIRD_PARTY_LICENSES.md')) {
        Set-Content -LiteralPath (Join-Path $SourceDir $name) -Value 'Test fixture; not an executable.'
    }
    Set-Content -LiteralPath (Join-Path $SourceDir 'OpenStudio.version') -Value '0.1.01'
}
Expect-Rejection 'stale binary version' @{ Version = '65535.65535.65535.0'; SourceDir = $SourceDir } 'does not match compiled app version'
Write-Output "$count Store package rejection tests passed."

. (Join-Path $PSScriptRoot 'windows-store-runtime.ps1')
$required = @('webui', 'effects', 'licenses', 'models', 'scripts')
function New-RuntimeFixture([string]$Name, [string]$Missing = '') {
    $root = Join-Path $testRoot $Name
    $inputDir = Join-Path $root 'source'
    $stageDir = Join-Path $root 'stage'
    New-Item -ItemType Directory -Path $inputDir, $stageDir -Force | Out-Null
    foreach ($directory in $required) {
        if ($directory -eq $Missing) { continue }
        $nested = Join-Path $inputDir "$directory/nested"
        New-Item -ItemType Directory -Path $nested -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $nested 'payload.txt') -Value "$Name/$directory"
    }
    return @{ SourceDir = $inputDir; StageDir = $stageDir }
}

$clean = New-RuntimeFixture 'clean-checkout'
Copy-StoreRuntimeDirectories @clean
foreach ($directory in $required) {
    $relative = "$directory/nested/payload.txt"
    $expected = (Get-FileHash -LiteralPath (Join-Path $clean.SourceDir $relative)).Hash
    $actual = (Get-FileHash -LiteralPath (Join-Path $clean.StageDir $relative)).Hash
    if ($actual -ne $expected) { throw "Runtime payload changed: $relative" }
}
if (Test-Path -LiteralPath (Join-Path $clean.StageDir 'presets')) { throw 'Unexpected preset payload in clean fixture.' }
Write-Output 'PASS clean checkout without presets copies all required runtime payloads'

$withPresets = New-RuntimeFixture 'bundled-presets'
$presetDir = Join-Path $withPresets.SourceDir 'presets/nested'
New-Item -ItemType Directory -Path $presetDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $presetDir 'factory.ospreset') -Value 'optional factory preset'
Copy-StoreRuntimeDirectories @withPresets
$expected = (Get-FileHash -LiteralPath (Join-Path $presetDir 'factory.ospreset')).Hash
$actual = (Get-FileHash -LiteralPath (Join-Path $withPresets.StageDir 'presets/nested/factory.ospreset')).Hash
if ($actual -ne $expected) { throw 'Optional preset payload changed.' }
Write-Output 'PASS optional bundled presets are preserved'

foreach ($directory in $required) {
    $fixture = New-RuntimeFixture "missing-$directory" $directory
    $rejected = $false
    try { Copy-StoreRuntimeDirectories @fixture }
    catch {
        if ($_.Exception.Message -ne "Missing runtime directory: $directory") { throw }
        $rejected = $true
    }
    if (!$rejected) { throw "Missing required runtime directory was accepted: $directory" }
    if (@(Get-ChildItem -LiteralPath $fixture.StageDir).Count -ne 0) { throw 'Invalid runtime fixture was partially staged.' }
    Write-Output "PASS missing required $directory is rejected before copying"
}
Write-Output '7 Store runtime directory tests passed.'
