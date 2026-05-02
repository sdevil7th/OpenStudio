param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows", "macos", "linux")]
    [string]$Platform,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$ExpectedRuntimeVersion = "",

    [Parameter(Mandatory = $false)]
    [int64]$MaxArtifactSizeBytes = 0
)

$ErrorActionPreference = "Stop"

$resolvedRuntimeRoot = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) {
    $RuntimeRoot
} else {
    Join-Path $PWD $RuntimeRoot
}

$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
} else {
    Join-Path $PWD $OutputPath
}

if (-not (Test-Path $resolvedRuntimeRoot)) {
    throw "Runtime root not found: $resolvedRuntimeRoot"
}

$venvMarker = Join-Path $resolvedRuntimeRoot "pyvenv.cfg"
if (Test-Path $venvMarker) {
    throw "Runtime root '$resolvedRuntimeRoot' still contains pyvenv.cfg and cannot be published as a relocatable runtime."
}

$metadataPath = Join-Path $resolvedRuntimeRoot ".openstudio-ai-runtime.json"
if (-not (Test-Path $metadataPath)) {
    throw "Runtime root '$resolvedRuntimeRoot' is missing .openstudio-ai-runtime.json."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null
if (Test-Path $resolvedOutputPath) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
}

function Invoke-WithHeartbeat {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,

        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock,

        [Parameter(Mandatory = $true)]
        [object[]]$ArgumentList,

        [Parameter(Mandatory = $false)]
        [string]$OutputPath = "",

        [Parameter(Mandatory = $false)]
        [int]$HeartbeatSeconds = 30
    )

    $started = Get-Date
    $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList

    try {
        while ($job.State -eq "Running") {
            Start-Sleep -Seconds $HeartbeatSeconds
            $elapsedSeconds = [int]((Get-Date) - $started).TotalSeconds
            $outputBytes = if (-not [string]::IsNullOrWhiteSpace($OutputPath) -and (Test-Path $OutputPath)) {
                [int64](Get-Item $OutputPath).Length
            } else {
                0
            }

            Write-Host "$Description heartbeat: elapsedSeconds=$elapsedSeconds outputBytes=$outputBytes"
            Receive-Job -Job $job | ForEach-Object { Write-Host $_ }
        }

        Receive-Job -Job $job -Wait | ForEach-Object { Write-Host $_ }
        if ($job.State -ne "Completed") {
            $reason = $job.ChildJobs[0].JobStateInfo.Reason
            if ($null -ne $reason -and -not [string]::IsNullOrWhiteSpace($reason.Message)) {
                throw "$Description failed: $($reason.Message)"
            }

            throw "$Description failed with job state '$($job.State)'."
        }
    }
    finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

function New-StagedRuntimeArchiveRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    $stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("OpenStudio-AIRuntime-Package-" + [System.Guid]::NewGuid().ToString("N"))
    $stagePayload = Join-Path $stageRoot ([System.IO.Path]::GetFileName($RuntimeRoot))
    New-Item -ItemType Directory -Force -Path $stagePayload | Out-Null
    Get-ChildItem -LiteralPath $RuntimeRoot -Force |
        Copy-Item -Destination $stagePayload -Recurse -Force

    return [pscustomobject]@{
        Root = $stageRoot
        PayloadName = [System.IO.Path]::GetFileName($RuntimeRoot)
        PayloadPath = $stagePayload
        OutputPath = $OutputPath
    }
}

if ($Platform -eq "macos") {
    $parentDir = Split-Path -Parent $resolvedRuntimeRoot
    $runtimeName = Split-Path -Leaf $resolvedRuntimeRoot

    Write-Host "Packaging AI runtime archive with ditto: $resolvedOutputPath"
    Invoke-WithHeartbeat `
        -Description "macOS runtime packaging" `
        -OutputPath $resolvedOutputPath `
        -ScriptBlock {
            param($parentDir, $runtimeName, $outputPath)

            Set-Location -LiteralPath $parentDir
            & /usr/bin/ditto -c -k --sequesterRsrc --keepParent $runtimeName $outputPath
            if ($LASTEXITCODE -ne 0) {
                throw "Native macOS runtime archive packaging failed with exit code $LASTEXITCODE."
            }
        } `
        -ArgumentList @($parentDir, $runtimeName, $resolvedOutputPath)
}
else {
    $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
    $stagedRuntime = New-StagedRuntimeArchiveRoot -RuntimeRoot $resolvedRuntimeRoot -OutputPath $resolvedOutputPath
    if ($null -ne $sevenZip) {
        Write-Host "Packaging AI runtime archive with 7-Zip: $resolvedOutputPath"
        try {
            Invoke-WithHeartbeat `
                -Description "7-Zip runtime packaging" `
                -OutputPath $resolvedOutputPath `
                -ScriptBlock {
                    param($sevenZipPath, $stageRoot, $payloadName, $outputPath)

                    Set-Location -LiteralPath $stageRoot
                    & $sevenZipPath a -tzip -mx=5 -mmt=on $outputPath $payloadName
                    if ($LASTEXITCODE -ne 0) {
                        throw "7-Zip runtime archive packaging failed with exit code $LASTEXITCODE."
                    }
                } `
                -ArgumentList @($sevenZip.Source, $stagedRuntime.Root, $stagedRuntime.PayloadName, $resolvedOutputPath)
        }
        finally {
            Remove-Item -LiteralPath $stagedRuntime.Root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        Write-Host "Packaging AI runtime archive with Compress-Archive: $resolvedOutputPath"
        try {
            Invoke-WithHeartbeat `
                -Description "Compress-Archive runtime packaging" `
                -OutputPath $resolvedOutputPath `
                -ScriptBlock {
                    param($payloadPath, $outputPath)

                    Compress-Archive -Path $payloadPath -DestinationPath $outputPath -CompressionLevel Optimal
                } `
                -ArgumentList @($stagedRuntime.PayloadPath, $resolvedOutputPath)
        }
        finally {
            Remove-Item -LiteralPath $stagedRuntime.Root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$artifactSize = (Get-Item $resolvedOutputPath).Length
Write-Host "compressedArtifactSizeBytes=$artifactSize"
if ($MaxArtifactSizeBytes -gt 0 -and $artifactSize -gt $MaxArtifactSizeBytes) {
    throw "AI runtime archive '$resolvedOutputPath' is $artifactSize bytes, which exceeds the configured limit of $MaxArtifactSizeBytes bytes."
}

Write-Host "Validating AI runtime archive: $resolvedOutputPath"
& (Join-Path $PSScriptRoot "validate-ai-runtime-package.ps1") `
    -Platform $Platform `
    -ArchivePath $resolvedOutputPath `
    -ExpectedRuntimeVersion $ExpectedRuntimeVersion

Write-Host "AI runtime package created at $resolvedOutputPath"
