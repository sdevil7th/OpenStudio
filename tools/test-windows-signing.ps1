$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-signing.ps1")

function Assert-Fails {
    param([scriptblock]$Action, [string]$MessagePattern)
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception.Message }
    if ($null -eq $failure -or $failure -notlike $MessagePattern) {
        throw "Expected failure '$MessagePattern', received '$failure'."
    }
}

function New-SigningFixture {
    param([string]$Path, [string]$Product, [string]$Version)
    # PowerShell 7 Add-Type does not emit the Win32 version resource read by
    # FileVersionInfo. Use the Windows .NET Framework compiler in both shells.
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $sourceFile = [IO.Path]::ChangeExtension($Path, '.cs')
    Set-Content -LiteralPath $sourceFile -Value @"
using System.Reflection;
[assembly: AssemblyProduct("$Product")]
[assembly: AssemblyInformationalVersion("$Version")]
public class SigningFixture {}
"@
    & $compiler /nologo /target:library "/out:$Path" $sourceFile
    if ($LASTEXITCODE -ne 0) { throw 'Signing fixture compilation failed.' }
}

$signingTestParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$signingTestRoot = Join-Path $signingTestParent ("openstudio-signing-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $signingTestRoot | Out-Null
try {
    $source = Join-Path $signingTestRoot "source"
    $stage = Join-Path $signingTestRoot "stage"
    $destination = Join-Path $signingTestRoot "destination"
    New-Item -ItemType Directory -Path $source, $destination | Out-Null
    # Use a reviewed release version so packaging exercises the notes gate before signature checks.
    $fixture = Join-Path $signingTestRoot "fixture.dll"
    New-SigningFixture -Path $fixture -Product 'OpenStudio' -Version '0.1.01'
    foreach ($file in Get-OpenStudioSigningFiles -Directory $source) {
        Copy-Item -LiteralPath $fixture -Destination $file
    }
    Set-Content -LiteralPath (Join-Path $source "thirdparty.dll") -Value "Do not sign or copy this."
    Copy-OpenStudioSigningFiles -SourceDirectory $source -DestinationDirectory $stage `
        -Version "0.1.01" -RequireEmptyDestination
    if (@(Get-ChildItem -LiteralPath $stage).Count -ne 2) {
        throw "Only the two first-party payload files should be staged."
    }
    Assert-Fails { Copy-OpenStudioSigningFiles -SourceDirectory $source -DestinationDirectory $stage `
        -Version "0.1.01" -RequireEmptyDestination } "*must be empty*"
    Assert-Fails { Assert-OpenStudioSigningFiles -Directory $stage -Version "2.0.0" } "*metadata mismatch*"

    # Exercise the real Windows trust API before mocking responses for branch coverage.
    Assert-Fails { Assert-OpenStudioSigningFiles -Directory $stage -Version "0.1.01" -RequireSignature } "*Authenticode verification failed*"
    Assert-Fails { & (Join-Path $PSScriptRoot "package-windows-release.ps1") -Version "0.1.01" `
        -SourceDir $stage -OutputDir $destination -RequireSignedPayload } "*Authenticode verification failed*"
    Assert-Fails { & (Join-Path $PSScriptRoot "package-windows-release.ps1") -Version "0.1.01" `
        -SourceDir $stage -OutputDir $destination -RequireSignedPayload -CertificateThumbprint "test" } "*either a pre-signed payload*"

    $script:invalidFile = "OpenStudioCrashReporter.exe"
    $script:omitTimestamp = $false
    function Get-AuthenticodeSignature {
        param([string]$LiteralPath)
        [pscustomobject]@{
            Status = if ([IO.Path]::GetFileName($LiteralPath) -eq $script:invalidFile) { "HashMismatch" } else { "Valid" }
            SignerCertificate = [pscustomobject]@{ Subject = "Test only" }
            TimeStamperCertificate = if ($script:omitTimestamp) { $null } else { [pscustomobject]@{ Subject = "Test only" } }
        }
    }
    foreach ($file in Get-OpenStudioSigningFiles -Directory $destination) {
        Set-Content -LiteralPath $file -Value "Original package input"
    }
    $before = @(Get-OpenStudioSigningFiles -Directory $destination | ForEach-Object { (Get-FileHash -LiteralPath $_).Hash })
    Assert-Fails { Copy-OpenStudioSigningFiles -SourceDirectory $stage -DestinationDirectory $destination `
        -Version "0.1.01" -RequireSignature } "*Authenticode verification failed*"
    $after = @(Get-OpenStudioSigningFiles -Directory $destination | ForEach-Object { (Get-FileHash -LiteralPath $_).Hash })
    if (Compare-Object $before $after) { throw "A rejected payload changed package inputs." }

    $script:invalidFile = ""
    $script:omitTimestamp = $true
    Assert-Fails { Assert-OpenStudioSigningFiles -Directory $stage -Version "0.1.01" -RequireSignature } "*timestamp missing*"
    $script:omitTimestamp = $false
    Copy-OpenStudioSigningFiles -SourceDirectory $stage -DestinationDirectory $destination `
        -Version "0.1.01" -RequireSignature
    foreach ($file in Get-OpenStudioSigningFiles -Directory $destination) {
        if ((Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath $fixture).Hash) {
            throw "Signed payload was not restored."
        }
    }

    # Inno Setup's real metadata strings contain trailing space padding.
    $installerFixture = Join-Path $signingTestRoot "installer-fixture.dll"
    New-SigningFixture -Path $installerFixture -Product 'OpenStudio    ' -Version '0.1.01    '
    $installerFile = Join-Path $source "OpenStudio-Setup-x64.exe"
    Copy-Item -LiteralPath $installerFixture -Destination $installerFile
    Copy-OpenStudioSigningFiles -SourceDirectory $source -DestinationDirectory (Join-Path $signingTestRoot "installer") `
        -Kind installer -Version "0.1.01" -RequireSignature -RequireEmptyDestination
    $missing = Join-Path $signingTestRoot "missing"
    New-Item -ItemType Directory -Path $missing | Out-Null
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $missing "OpenStudio.exe")
    Assert-Fails { Assert-OpenStudioSigningFiles -Directory $missing -Version "0.1.01" } "*file missing*"
    Write-Host "PASS: staging allowlist, stale staging, version mismatch, real unsigned rejection, invalid signature, timestamp, no partial restore, payload/installer restore, missing helper."
    Write-Host "Live SignPath and trusted-signature success are not asserted; successful signature responses above are mocked."
} finally {
    # Delete only this test's explicitly created temporary directory.
    $resolvedSigningTestRoot = [IO.Path]::GetFullPath($signingTestRoot)
    if ([IO.Path]::GetDirectoryName($resolvedSigningTestRoot).TrimEnd('\') -ne $signingTestParent.TrimEnd('\') -or
        [IO.Path]::GetFileName($resolvedSigningTestRoot) -notlike "openstudio-signing-test-*") {
        throw "Refusing cleanup outside the signing test directory."
    }
    Remove-Item -LiteralPath $resolvedSigningTestRoot -Recurse -Force
}
