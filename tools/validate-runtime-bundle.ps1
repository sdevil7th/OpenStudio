param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos", "linux")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$BundlePath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedVersion = "",

    [Parameter(Mandatory = $false)]
    [switch]$EnforceLeanBundle
)

$ErrorActionPreference = "Stop"

function Assert-Exists {
    param(
        [string]$Path,
        [string]$Description
    )

    if (-not (Test-Path $Path)) {
        throw "$Description was not found at '$Path'."
    }
}

function Assert-NotExists {
    param(
        [string]$Path,
        [string]$Description
    )

    if (Test-Path $Path) {
        throw "$Description should not be present at '$Path'."
    }
}

function Test-SourceExists {
    param(
        [string]$RepoRoot,
        [string]$RelativePath
    )

    return Test-Path (Join-Path $RepoRoot $RelativePath)
}

function Get-PlistStringValue {
    param(
        [string]$PlistPath,
        [string]$Key
    )

    [xml]$plist = Get-Content $PlistPath
    $dict = $plist.plist.dict
    if (-not $dict) {
        return $null
    }

    for ($i = 0; $i -lt $dict.ChildNodes.Count; $i++) {
        $node = $dict.ChildNodes[$i]
        if ($node.Name -eq "key" -and $node.InnerText -eq $Key) {
            for ($j = $i + 1; $j -lt $dict.ChildNodes.Count; $j++) {
                $valueNode = $dict.ChildNodes[$j]
                if ($valueNode.NodeType -eq [System.Xml.XmlNodeType]::Whitespace) {
                    continue
                }

                return $valueNode.InnerText
            }
        }
    }

    return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedBundlePath = if ([System.IO.Path]::IsPathRooted($BundlePath)) {
    $BundlePath
} else {
    Join-Path $PWD $BundlePath
}

if (-not (Test-Path $resolvedBundlePath)) {
    throw "Bundle path not found: $resolvedBundlePath"
}

$runtimeRoot = $resolvedBundlePath
$binaryPath = $null

switch ($Platform) {
    "windows" {
        $binaryPath = Join-Path $resolvedBundlePath "OpenStudio.exe"
        Assert-Exists -Path $binaryPath -Description "OpenStudio executable"

        if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
            $fileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($binaryPath).ProductVersion
            if ([string]::IsNullOrWhiteSpace($fileVersion)) {
                throw "Could not read ProductVersion from '$binaryPath'."
            }

            if ($fileVersion -ne $ExpectedVersion) {
                throw "Windows bundle version mismatch. Expected '$ExpectedVersion' but found '$fileVersion'."
            }
        }
    }
    "macos" {
        if (-not $resolvedBundlePath.EndsWith(".app")) {
            throw "For macOS validation, pass the path to OpenStudio.app."
        }

        $binaryPath = Join-Path $resolvedBundlePath "Contents/MacOS/OpenStudio"
        $runtimeRoot = Join-Path $resolvedBundlePath "Contents/Resources"
        $plistPath = Join-Path $resolvedBundlePath "Contents/Info.plist"
        Assert-Exists -Path $binaryPath -Description "OpenStudio app binary"
        Assert-Exists -Path $runtimeRoot -Description "OpenStudio app resources directory"
        Assert-Exists -Path $plistPath -Description "OpenStudio app Info.plist"

        $microphoneUsageText = Get-PlistStringValue -PlistPath $plistPath -Key "NSMicrophoneUsageDescription"
        if ([string]::IsNullOrWhiteSpace($microphoneUsageText)) {
            throw "macOS bundle Info.plist is missing NSMicrophoneUsageDescription, so microphone permission prompts will not work."
        }

        if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
            $bundleVersion = Get-PlistStringValue -PlistPath $plistPath -Key "CFBundleShortVersionString"
            if ([string]::IsNullOrWhiteSpace($bundleVersion)) {
                throw "Could not read CFBundleShortVersionString from '$plistPath'."
            }

            if ($bundleVersion -ne $ExpectedVersion) {
                throw "macOS bundle version mismatch. Expected '$ExpectedVersion' but found '$bundleVersion'."
            }
        }
    }
    "linux" {
        # Linux: flat output directory (AppImage contents or raw build output)
        $binaryPath = Join-Path $resolvedBundlePath "OpenStudio"
        $versionManifestPath = Join-Path $resolvedBundlePath "OpenStudio.version"
        Assert-Exists -Path $binaryPath -Description "OpenStudio binary"
        Assert-Exists -Path $versionManifestPath -Description "OpenStudio version manifest"

        $bundleVersion = (Get-Content -LiteralPath $versionManifestPath -Raw).Trim()
        if ([string]::IsNullOrWhiteSpace($bundleVersion)) {
            throw "Linux bundle version manifest '$versionManifestPath' is empty."
        }

        if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
            if ($bundleVersion -ne $ExpectedVersion) {
                throw "Linux bundle version mismatch. Expected '$ExpectedVersion' but found '$bundleVersion'."
            }
        }
    }
}

$shellCriticalRuntimeEntries = @(
    @{ Source = "frontend/dist/index.html"; Target = "webui/index.html"; Description = "packaged frontend entry point" },
    @{ Source = "frontend/dist/assets"; Target = "webui/assets"; Description = "packaged frontend assets" }
)

$bundledFeatureEntries = @(
    @{ Source = "effects"; Target = "effects"; Description = "stock effects bundle" },
    @{ Source = "scripts"; Target = "scripts"; Description = "stock scripts bundle" },
    @{ Source = "tools/install_ai_tools.py"; Target = "scripts/install_ai_tools.py"; Description = "AI tools installer script" },
    @{ Source = "tools/ai_runtime_probe.py"; Target = "scripts/ai_runtime_probe.py"; Description = "AI runtime capability probe script" },
    @{ Source = "tools/generate_music.py"; Target = "scripts/generate_music.py"; Description = "music generation helper script" }
)

$licenseEntries = @(
    @{ Target = "LICENSE"; Description = "OpenStudio license" },
    @{ Target = "THIRD_PARTY_LICENSES.md"; Description = "third-party license notices" },
    @{ Target = "licenses/Frontend-THIRD_PARTY_NOTICES.txt"; Description = "frontend dependency notices" },
    @{ Target = "licenses/YSFX-LICENSE.txt"; Description = "YSFX Apache-2.0 license" },
    @{ Target = "licenses/WDL-LICENSE.txt"; Description = "WDL license" },
    @{ Target = "licenses/dr_libs-LICENSE.txt"; Description = "dr_libs license" },
    @{ Target = "licenses/stb-LICENSE.txt"; Description = "stb license" },
    @{ Target = "licenses/CLAP-LICENSE.txt"; Description = "CLAP SDK license" },
    @{ Target = "licenses/Signalsmith-Stretch-LICENSE.txt"; Description = "Signalsmith Stretch license" },
    @{ Target = "licenses/Signalsmith-Linear-LICENSE.txt"; Description = "Signalsmith Linear license" },
    @{ Target = "licenses/ARA-NOTICE.txt"; Description = "ARA SDK notice" },
    @{ Target = "licenses/ARA-API-LICENSE.txt"; Description = "ARA API license" },
    @{ Target = "licenses/ARA-Library-LICENSE.txt"; Description = "ARA Library license" },
    @{ Target = "licenses/BasicPitch-LICENSE.txt"; Description = "Basic Pitch license" },
    @{ Target = "licenses/BasicPitch-NOTICE.txt"; Description = "Basic Pitch notice" },
    @{ Target = "licenses/NeuralAmpModelerCore-LICENSE.txt"; Description = "NeuralAmpModelerCore license" },
    @{ Target = "licenses/Eigen-COPYING.MPL2.txt"; Description = "Eigen MPL-2.0 license" },
    @{ Target = "licenses/Eigen-COPYING.BSD.txt"; Description = "Eigen BSD notice" },
    @{ Target = "licenses/Eigen-COPYING.APACHE.txt"; Description = "Eigen Apache-2.0 notice" },
    @{ Target = "licenses/Eigen-COPYING.MINPACK.txt"; Description = "Eigen MINPACK notice" },
    @{ Target = "licenses/Eigen-COPYING.README.txt"; Description = "Eigen licensing readme" }
)

foreach ($entry in $licenseEntries) {
    Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
}

function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($text)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

$nativeNoticeHashes = @{
    "licenses/YSFX-LICENSE.txt" = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
    "licenses/WDL-LICENSE.txt" = "aeb30b800c5b402a52e4a8960601bc56a74bed26ff6356f459f88d902998f4f4"
    "licenses/dr_libs-LICENSE.txt" = "dd1c647e6f767f8ff4b2dfae0fed314726600a01e0cf1ef556afddd5fa96ff15"
    "licenses/stb-LICENSE.txt" = "bebfe904b14301657e4e5d655c811d51fd31b97c455b9cc2d8600d6bac6cff63"
    "licenses/CLAP-LICENSE.txt" = "ced49f9ef950277afdb56199369ea6e8165ebfdbfbb37ebfe1827e0de892088d"
    "licenses/Signalsmith-Stretch-LICENSE.txt" = "7154ecf162d91232235c9ba4619d95b30c7f1f904a39e0f22eaf914e208cb69b"
    "licenses/Signalsmith-Linear-LICENSE.txt" = "072b5e9eb5b22880bdf6256324654cf3ce53dba828edb911921121e1be09d9c3"
    "licenses/ARA-NOTICE.txt" = "c2cb0f6d2e7142c4eaa437c658e2fef1aa6d304b9eb75e5de8a9be09f317cdd3"
    "licenses/ARA-API-LICENSE.txt" = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    "licenses/ARA-Library-LICENSE.txt" = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
}
foreach ($relativePath in $nativeNoticeHashes.Keys) {
    $noticePath = Join-Path $runtimeRoot $relativePath
    $actualHash = Get-NormalizedTextSha256 -Path $noticePath
    if ($actualHash -ne $nativeNoticeHashes[$relativePath]) {
        throw "Bundled native notice checksum mismatch for '$relativePath'."
    }
}

$basicPitchLegalHashes = @{
    "licenses/BasicPitch-LICENSE.txt" = "929c910bae2152fa87199a5d0660e09263419b7eee6d4b301d05ee2aaf211c37"
    "licenses/BasicPitch-NOTICE.txt" = "b810e55c0e3b520fabb45fc2ccc74880187bf84e309971968541cc812dcde905"
}
foreach ($relativePath in $basicPitchLegalHashes.Keys) {
    $legalPath = Join-Path $runtimeRoot $relativePath
    $actualHash = (Get-FileHash -LiteralPath $legalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $basicPitchLegalHashes[$relativePath]) {
        throw "Bundled Basic Pitch legal-file checksum mismatch for '$relativePath'."
    }
}

$basicPitchModelPath = Join-Path $runtimeRoot "models/basic_pitch_nmp.onnx"
$basicPitchProvenancePath = Join-Path $runtimeRoot "models/basic_pitch_nmp.provenance.json"
Assert-Exists -Path $basicPitchModelPath -Description "bundled Basic Pitch model"
Assert-Exists -Path $basicPitchProvenancePath -Description "Basic Pitch provenance manifest"
$expectedBasicPitchSha256 = "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec"
$actualBasicPitchSha256 = (Get-FileHash -LiteralPath $basicPitchModelPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBasicPitchSha256 -ne $expectedBasicPitchSha256) {
    throw "Basic Pitch model checksum mismatch. Expected '$expectedBasicPitchSha256' but found '$actualBasicPitchSha256'."
}

$onnxRuntimeSource = Join-Path $repoRoot "thirdparty/onnxruntime"
if (Test-Path (Join-Path $onnxRuntimeSource "include/onnxruntime_cxx_api.h")) {
    Assert-Exists -Path (Join-Path $runtimeRoot "licenses/ONNXRuntime-LICENSE") -Description "ONNX Runtime license"
    Assert-Exists -Path (Join-Path $runtimeRoot "licenses/ONNXRuntime-ThirdPartyNotices.txt") -Description "ONNX Runtime third-party notices"
}

foreach ($entry in $shellCriticalRuntimeEntries) {
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source) {
        Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
    }
}

foreach ($entry in $bundledFeatureEntries) {
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source) {
        Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
    }
}

$leanBundleExclusions = @(
    @{ Source = "tools/python"; Target = "python"; Description = "bundled Python runtime" },
    @{ Source = "resources/models/BS-Roformer-SW.ckpt"; Target = "models/BS-Roformer-SW.ckpt"; Description = "bundled stem model checkpoint" },
    @{ Source = "resources/models/BS-Roformer-SW.yaml"; Target = "models/BS-Roformer-SW.yaml"; Description = "bundled stem model manifest" },
    @{ Source = "resources/models/download_checks.json"; Target = "models/download_checks.json"; Description = "bundled stem model download manifest" }
)

if ($EnforceLeanBundle) {
    foreach ($entry in $leanBundleExclusions) {
        if (-not (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source)) {
            continue
        }

        Assert-NotExists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
    }
}

if ($Platform -eq "windows") {
    $ffmpegPath = Join-Path $runtimeRoot "ffmpeg.exe"
    $ffmpegLicensePath = Join-Path $runtimeRoot "licenses/FFmpeg-COPYING.GPLv3.txt"
    $ffmpegProvenancePath = Join-Path $runtimeRoot "licenses/FFmpeg-PROVENANCE.json"
    Assert-Exists -Path $ffmpegPath -Description "bundled ffmpeg executable"
    Assert-Exists -Path $ffmpegLicensePath -Description "FFmpeg GPLv3 license"
    Assert-Exists -Path $ffmpegProvenancePath -Description "FFmpeg provenance manifest"

    $ffmpegHashes = @{
        $ffmpegPath = "5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d"
        $ffmpegLicensePath = "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"
        $ffmpegProvenancePath = "30fc0edca9acc1d7a3253a81afe485a44f1de3c4b86542a18f644c1f71f312d4"
    }
    foreach ($path in $ffmpegHashes.Keys) {
        $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $ffmpegHashes[$path]) {
            throw "Bundled FFmpeg checksum mismatch for '$path'."
        }
    }

    $windowsPrerequisiteEntries = @(
        @{ Source = "thirdparty/windows-prereqs/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Target = "prereqs/windows/MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Description = "WebView2 standalone installer" },
        @{ Source = "thirdparty/windows-prereqs/vc_redist.x64.exe"; Target = "prereqs/windows/vc_redist.x64.exe"; Description = "VC++ redistributable installer" }
    )

    foreach ($entry in $windowsPrerequisiteEntries) {
        if (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source) {
            Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
        }
    }
} else {
    # macOS/Linux releases intentionally use an optional system FFmpeg. Never
    # leak an arbitrary developer-local tools/ffmpeg binary into a package.
    Assert-NotExists -Path (Join-Path $runtimeRoot "ffmpeg") -Description "untracked macOS/Linux ffmpeg binary"
}

Write-Host "Runtime bundle validation passed for $Platform at $resolvedBundlePath"
