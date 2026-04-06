param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [int]$TopCount = 20
)

$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath {
    param([string]$PathValue)

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PWD $PathValue))
}

function Get-DirectorySizeBytes {
    param([string]$PathValue)

    $total = [int64]0
    foreach ($item in Get-ChildItem -LiteralPath $PathValue -Recurse -Force -File -ErrorAction SilentlyContinue) {
        $total += [int64]$item.Length
    }
    return $total
}

$resolvedRuntimeRoot = Resolve-AbsolutePath -PathValue $RuntimeRoot
$resolvedOutputPath = Resolve-AbsolutePath -PathValue $OutputPath

if (-not (Test-Path $resolvedRuntimeRoot)) {
    throw "Runtime root not found: $resolvedRuntimeRoot"
}

$entries = foreach ($item in Get-ChildItem -LiteralPath $resolvedRuntimeRoot -Force -ErrorAction SilentlyContinue) {
    if ($item.PSIsContainer) {
        [pscustomobject]@{
            path = $item.FullName.Substring($resolvedRuntimeRoot.Length).TrimStart('\', '/')
            sizeBytes = Get-DirectorySizeBytes -PathValue $item.FullName
            type = "directory"
        }
    }
    else {
        [pscustomobject]@{
            path = $item.FullName.Substring($resolvedRuntimeRoot.Length).TrimStart('\', '/')
            sizeBytes = [int64]$item.Length
            type = "file"
        }
    }
}

$topEntries = $entries |
    Sort-Object -Property sizeBytes -Descending |
    Select-Object -First $TopCount

$report = [ordered]@{
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    runtimeRoot = $resolvedRuntimeRoot
    totalSizeBytes = [int64](Get-DirectorySizeBytes -PathValue $resolvedRuntimeRoot)
    topEntries = @($topEntries | ForEach-Object {
        [ordered]@{
            path = $_.path
            sizeBytes = [int64]$_.sizeBytes
            type = $_.type
        }
    })
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Path $resolvedOutputPath -Encoding UTF8

Write-Host "Runtime size report written to $resolvedOutputPath"
