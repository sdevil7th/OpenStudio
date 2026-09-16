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
