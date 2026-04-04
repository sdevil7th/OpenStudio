param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$BundlePath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedVersion = "",

    [Parameter(Mandatory = $false)]
    [switch]$EnforceLeanBundle,

    [Parameter(Mandatory = $false)]
    [switch]$ExpectBundledStemRuntime
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
}

$shellCriticalRuntimeEntries = @(
    @{ Source = "frontend/dist/index.html"; Target = "webui/index.html"; Description = "packaged frontend entry point" },
    @{ Source = "frontend/dist/assets"; Target = "webui/assets"; Description = "packaged frontend assets" }
)

$bundledFeatureEntries = @(
    @{ Source = "effects"; Target = "effects"; Description = "stock effects bundle" },
    @{ Source = "scripts"; Target = "scripts"; Description = "stock scripts bundle" },
    @{ Source = "resources/models/basic_pitch_nmp.onnx"; Target = "models/basic_pitch_nmp.onnx"; Description = "polyphonic pitch model" },
    @{ Source = "tools/install_ai_tools.py"; Target = "scripts/install_ai_tools.py"; Description = "AI tools installer script" }
)

foreach ($entry in $shellCriticalRuntimeEntries) {
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source) {
        Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
    }
}

function Resolve-BundledRuntimePython {
    param(
        [string]$RuntimeRoot
    )

    $candidates = @(
        (Join-Path $RuntimeRoot "python.exe"),
        (Join-Path $RuntimeRoot "python"),
        (Join-Path $RuntimeRoot "Scripts\python.exe"),
        (Join-Path $RuntimeRoot "Scripts\python"),
        (Join-Path $RuntimeRoot "bin\python3"),
        (Join-Path $RuntimeRoot "bin\python")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

foreach ($entry in $bundledFeatureEntries) {
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source) {
        Assert-Exists -Path (Join-Path $runtimeRoot $entry.Target) -Description $entry.Description
    }
}

$optionalStemRuntimeEntries = @(
    @{ Source = "tools/python"; Target = "python"; Description = "bundled Python runtime" },
    @{ Source = "resources/models/BS-Roformer-SW.ckpt"; Target = "models/BS-Roformer-SW.ckpt"; Description = "bundled stem model checkpoint" },
    @{ Source = "resources/models/BS-Roformer-SW.yaml"; Target = "models/BS-Roformer-SW.yaml"; Description = "bundled stem model manifest" },
    @{ Source = "resources/models/download_checks.json"; Target = "models/download_checks.json"; Description = "bundled stem model download manifest" }
)

foreach ($entry in $optionalStemRuntimeEntries) {
    if (-not (Test-SourceExists -RepoRoot $repoRoot -RelativePath $entry.Source)) {
        continue
    }

    $targetPath = Join-Path $runtimeRoot $entry.Target
    if ($ExpectBundledStemRuntime) {
        Assert-Exists -Path $targetPath -Description $entry.Description
    } elseif ($EnforceLeanBundle) {
        Assert-NotExists -Path $targetPath -Description $entry.Description
    }
}

if ($ExpectBundledStemRuntime) {
    $bundledRuntimeRoot = Join-Path $runtimeRoot "python"
    $bundledRuntimePython = Resolve-BundledRuntimePython -RuntimeRoot $bundledRuntimeRoot
    if (-not $bundledRuntimePython) {
        throw "Bundled stem runtime Python executable was not found under '$bundledRuntimeRoot'."
    }

    & $bundledRuntimePython -c "import audio_separator.separator; print('ok')"
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled stem runtime import check failed for '$bundledRuntimePython'."
    }
}

if ($Platform -eq "windows") {
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath "tools/ffmpeg.exe") {
        Assert-Exists -Path (Join-Path $runtimeRoot "ffmpeg.exe") -Description "bundled ffmpeg executable"
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
    if (Test-SourceExists -RepoRoot $repoRoot -RelativePath "tools/ffmpeg") {
        Assert-Exists -Path (Join-Path $runtimeRoot "ffmpeg") -Description "bundled ffmpeg binary"
    }
}

Write-Host "Runtime bundle validation passed for $Platform at $resolvedBundlePath"
