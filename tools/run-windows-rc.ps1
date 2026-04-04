param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [string]$BuildDir = "build-release-windows",

    [Parameter(Mandatory = $false)]
    [string]$WindowsOutputDir = "dist/windows",

    [Parameter(Mandatory = $false)]
    [string]$InstallDir = "C:\Program Files\OpenStudio",

    [Parameter(Mandatory = $false)]
    [switch]$SkipFrontendBuild,

    [Parameter(Mandatory = $false)]
    [switch]$SkipASIOSetup,

    [Parameter(Mandatory = $false)]
    [switch]$SetupONNXRuntime,

    [Parameter(Mandatory = $false)]
    [switch]$Install,

    [Parameter(Mandatory = $false)]
    [switch]$LaunchInstalledApp,

    [Parameter(Mandatory = $false)]
    [switch]$LaunchSafeMode
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Title"
    & $Action
}

function Test-IsElevated {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot "frontend"
$resolvedBuildDir = Join-Path $repoRoot $BuildDir
$resolvedWindowsOutputDir = Join-Path $repoRoot $WindowsOutputDir
$windowsBundleDir = Join-Path $resolvedBuildDir "OpenStudio_artefacts/Release"
$generatedWindowsResourceFile = Join-Path $resolvedBuildDir "OpenStudio_artefacts/JuceLibraryCode/OpenStudio_resources.rc"
$generatedWindowsResourceLibrary = Join-Path $resolvedBuildDir "OpenStudio_rc_lib.dir/Release/OpenStudio_rc_lib.lib"
$installerPath = Join-Path $resolvedWindowsOutputDir "OpenStudio-Setup-x64.exe"
$installedExePath = Join-Path $InstallDir "OpenStudio.exe"
$startupLogPath = Join-Path $env:APPDATA "OpenStudio\logs\OpenStudio_Startup.log"
$startupSelfTestReportPath = Join-Path $env:TEMP "OpenStudio_StartupSelfTest.txt"
$asioHeaderPath = Join-Path $repoRoot "thirdparty\asio\common\iasiodrv.h"
$windowsPrereqsDir = Join-Path $repoRoot "thirdparty\windows-prereqs"
$webView2Bootstrapper = Join-Path $windowsPrereqsDir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
$vcRedistInstaller = Join-Path $windowsPrereqsDir "vc_redist.x64.exe"

function Get-StartupLogContent {
    param(
        [string]$Path,
        [int]$TimeoutSeconds = 15
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $Path) {
            return Get-Content -LiteralPath $Path -Raw
        }

        Start-Sleep -Milliseconds 500
    }

    throw "The startup log '$Path' was not created within $TimeoutSeconds seconds."
}

function Test-LogContainsLine {
    param(
        [string]$Content,
        [string]$Pattern
    )

    return [regex]::IsMatch($Content, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
}

function Invoke-StartupSelfTest {
    param(
        [string]$ExePath,
        [string]$ReportPath
    )

    if (Test-Path $ReportPath) {
        Remove-Item -LiteralPath $ReportPath -Force -ErrorAction SilentlyContinue
    }

    & $ExePath --startup-self-test --report $ReportPath
    if ($LASTEXITCODE -ne 0) {
        $reportContent = if (Test-Path $ReportPath) { Get-Content -LiteralPath $ReportPath -Raw } else { "No self-test report was written." }
        throw "Startup self-test failed for '$ExePath'.`n$reportContent"
    }
}

function Invoke-InstalledLaunchValidation {
    param(
        [string]$ExePath,
        [string[]]$Arguments = @(),
        [string]$ModeName,
        [string]$LogPath
    )

    if (Test-Path $LogPath) {
        Remove-Item -LiteralPath $LogPath -Force -ErrorAction SilentlyContinue
    }

    $process = Start-Process -FilePath $ExePath -ArgumentList $Arguments -PassThru

    try {
        $content = Get-StartupLogContent -Path $LogPath
        $deadline = (Get-Date).AddSeconds(12)

        while ((Get-Date) -lt $deadline) {
            if (Test-Path $LogPath) {
                $content = Get-Content -LiteralPath $LogPath -Raw

                if (Test-LogContainsLine -Content $content -Pattern '^Frontend startup state:\s*boot-ready\b') {
                    break
                }

                if (Test-LogContainsLine -Content $content -Pattern '^Frontend startup state:\s*(boot-failed|timed-out)\b') {
                    break
                }
            }

            Start-Sleep -Milliseconds 500
        }

        if (-not (Test-LogContainsLine -Content $content -Pattern '^Frontend startup state:\s*boot-ready\b')) {
            throw "$ModeName startup did not reach boot-ready. Startup log tail:`n$((Get-Content -LiteralPath $LogPath | Select-Object -Last 80) -join [Environment]::NewLine)"
        }

        if ($ModeName -eq "safe mode") {
            if (-not (Test-LogContainsLine -Content $content -Pattern '^Frontend startup mode:\s*safe$')) {
                throw "Safe mode launch did not record 'Frontend startup mode: safe'."
            }

            if (-not (Test-LogContainsLine -Content $content -Pattern 'safe-startup-ui-mounted')) {
                throw "Safe mode launch reached boot-ready, but the startup log did not record the safe startup UI marker."
            }
        }
    }
    finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not $SkipFrontendBuild) {
    Invoke-Step "Building frontend production bundle" {
        Push-Location $frontendDir
        try {
            if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
                cmd /c npm ci
                if ($LASTEXITCODE -ne 0) {
                    throw "npm ci failed."
                }
            }

            cmd /c npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "npm run build failed."
            }
        } finally {
            Pop-Location
        }
    }
}

if (-not $SkipASIOSetup -and -not (Test-Path $asioHeaderPath)) {
    Invoke-Step "Installing pinned ASIO SDK into thirdparty/asio" {
        & (Join-Path $repoRoot "tools/setup-asio-sdk.ps1")
    }
}

if (-not (Test-Path $asioHeaderPath)) {
    throw "ASIO SDK header was not found at '$asioHeaderPath'. Run tools/setup-asio-sdk.ps1 or pass -SkipASIOSetup only if you intentionally do not need parity with the Windows release path."
}

if ((-not (Test-Path $webView2Bootstrapper)) -or (-not (Test-Path $vcRedistInstaller))) {
    Invoke-Step "Installing Windows prerequisite installers into thirdparty/windows-prereqs" {
        & (Join-Path $repoRoot "tools/setup-windows-prereqs.ps1")
    }
}

if ((-not (Test-Path $webView2Bootstrapper)) -or (-not (Test-Path $vcRedistInstaller))) {
    throw "Windows prerequisite installers are missing. Expected '$webView2Bootstrapper' and '$vcRedistInstaller'."
}

if ($SetupONNXRuntime) {
    Invoke-Step "Installing optional ONNX Runtime" {
        & (Join-Path $repoRoot "tools/setup-onnxruntime.ps1")
    }
}

Invoke-Step "Configuring Windows RC build" {
    cmake -S $repoRoot -B $resolvedBuildDir -A x64 `
        "-DOPENSTUDIO_APP_VERSION=$Version" `
        "-DJUCE_ASIOSDK_PATH=thirdparty/asio" `
        "-DOPENSTUDIO_REQUIRE_ASIO=ON" `
        "-DOPENSTUDIO_BUNDLE_STEM_RUNTIME=OFF" `
        -DFETCHCONTENT_UPDATES_DISCONNECTED=ON
    if ($LASTEXITCODE -ne 0) {
        throw "CMake configure failed."
    }
}

Invoke-Step "Invalidating stale Windows version resources" {
    $pathsToInvalidate = @(
        $generatedWindowsResourceFile,
        $generatedWindowsResourceLibrary,
        (Join-Path $windowsBundleDir "OpenStudio.exe")
    )

    foreach ($path in $pathsToInvalidate) {
        if (Test-Path $path) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
}

Invoke-Step "Building OpenStudio Release target" {
    cmake --build $resolvedBuildDir --config Release --target OpenStudio
    if ($LASTEXITCODE -ne 0) {
        throw "Release build failed."
    }
}

Invoke-Step "Validating Windows runtime bundle" {
    & (Join-Path $repoRoot "tools/validate-runtime-bundle.ps1") `
        -Platform windows `
        -BundlePath $windowsBundleDir `
        -ExpectedVersion $Version `
        -EnforceLeanBundle
}

Invoke-Step "Running startup shell self-test on release bundle" {
    Invoke-StartupSelfTest -ExePath (Join-Path $windowsBundleDir "OpenStudio.exe") -ReportPath $startupSelfTestReportPath
}

Invoke-Step "Packaging local Windows installer" {
    & (Join-Path $repoRoot "tools/package-windows-release.ps1") `
        -Version $Version `
        -SourceDir $windowsBundleDir `
        -OutputDir $WindowsOutputDir
}

if ($Install) {
    Invoke-Step "Installing local Windows RC silently" {
        if (-not (Test-IsElevated)) {
            throw "Installing to '$InstallDir' requires an elevated PowerShell session. Re-run this command from an Administrator terminal, or run '$installerPath' manually."
        }

        Start-Process -FilePath $installerPath `
            -ArgumentList "/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS" `
            -Wait
    }

    if (-not (Test-Path $installedExePath)) {
        throw "Installed app was not found at '$installedExePath' after running the installer."
    }

    if ($LaunchInstalledApp) {
        Invoke-Step "Launching installed app (normal mode)" {
            Invoke-InstalledLaunchValidation -ExePath $installedExePath -ModeName "normal" -LogPath $startupLogPath
        }
    }

    if ($LaunchSafeMode) {
        Invoke-Step "Launching installed app (safe mode)" {
            Invoke-InstalledLaunchValidation -ExePath $installedExePath -Arguments @("--ui-safe-mode") -ModeName "safe mode" -LogPath $startupLogPath
        }
    }
}

Write-Host ""
Write-Host "Windows RC build completed successfully."
Write-Host "Bundle:     $windowsBundleDir"
Write-Host "Installer:  $installerPath"
Write-Host "Startup log: $startupLogPath"

if (-not $Install) {
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Run the installer: $installerPath"
    Write-Host "  2. Launch the installed app: $installedExePath"
    Write-Host "  3. Safe mode if needed: `"$installedExePath`" --ui-safe-mode"
    Write-Host "  4. Inspect diagnostics: powershell -ExecutionPolicy Bypass -File `"$repoRoot\tools\inspect-installed-windows-app.ps1`" -InstallDir `"$InstallDir`""
}
