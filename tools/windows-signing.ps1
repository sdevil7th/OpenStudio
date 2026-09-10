# Shared by local packaging and the GitHub SignPath workflow. Dot-source this file.

function Get-OpenStudioSigningFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [ValidateSet("payload", "installer")][string]$Kind = "payload"
    )

    $configPath = Join-Path $PSScriptRoot "../packaging/signpath/windows-$Kind.xml"
    [xml]$config = Get-Content -LiteralPath $configPath -Raw
    foreach ($entry in $config.'artifact-configuration'.'zip-file'.'pe-file') {
        $name = [string]$entry.path
        if ([IO.Path]::GetFileName($name) -ne $name -or $name -match '[*?]') {
            throw "Signing files must be explicit top-level filenames: $name"
        }
        Join-Path $Directory $name
    }
}

function Assert-OpenStudioSigningFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [ValidateSet("payload", "installer")][string]$Kind = "payload",
        [Parameter(Mandatory = $true)][string]$Version,
        [switch]$RequireSignature
    )

    foreach ($file in Get-OpenStudioSigningFiles -Directory $Directory -Kind $Kind) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Required Windows signing file missing: $file"
        }
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
        # Inno Setup reserves fixed-size version strings, padded with spaces.
        $productName = ([string]$info.ProductName).TrimEnd(' ')
        $productVersion = ([string]$info.ProductVersion).TrimEnd(' ')
        if ($productName -cne "OpenStudio" -or $productVersion -cne $Version) {
            throw "Signing metadata mismatch for '$file': expected OpenStudio $Version, got '$($info.ProductName)' '$($info.ProductVersion)'."
        }
        if ($RequireSignature) {
            $signature = Get-AuthenticodeSignature -LiteralPath $file
            if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
                throw "Authenticode verification failed for '$file': $($signature.Status)"
            }
            if ($null -eq $signature.TimeStamperCertificate) {
                throw "Authenticode timestamp missing for '$file'."
            }
        }
    }
}

function Copy-OpenStudioSigningFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$DestinationDirectory,
        [ValidateSet("payload", "installer")][string]$Kind = "payload",
        [Parameter(Mandatory = $true)][string]$Version,
        [switch]$RequireSignature,
        [switch]$RequireEmptyDestination
    )

    # Validate every file before replacing any of the package inputs.
    Assert-OpenStudioSigningFiles -Directory $SourceDirectory -Kind $Kind `
        -Version $Version -RequireSignature:$RequireSignature
    if ($RequireEmptyDestination -and (Test-Path -LiteralPath $DestinationDirectory)) {
        if (@(Get-ChildItem -LiteralPath $DestinationDirectory -Force).Count -ne 0) {
            throw "Signing staging directory must be empty: $DestinationDirectory"
        }
    }
    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    foreach ($file in Get-OpenStudioSigningFiles -Directory $SourceDirectory -Kind $Kind) {
        Copy-Item -LiteralPath $file -Destination $DestinationDirectory -Force
    }
    Assert-OpenStudioSigningFiles -Directory $DestinationDirectory -Kind $Kind `
        -Version $Version -RequireSignature:$RequireSignature
}
