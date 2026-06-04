param(
    [switch]$Apply,
    [switch]$IncludeLegacyAceCache,
    [int]$MinLogAgeDays = 30,
    [string]$OpenStudioRoot = (Join-Path $env:LOCALAPPDATA "OpenStudio"),
    [string]$AceCacheRoot = (Join-Path $HOME ".cache\ace-step")
)

$ErrorActionPreference = "Stop"

function Resolve-OrNull {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-PathSizeBytes {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return 0L
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        return [int64]$item.Length
    }
    $stats = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($null -eq $stats.Sum) {
        return 0L
    }
    return [int64]$stats.Sum
}

function Format-Size {
    param([int64]$Bytes)
    if ($Bytes -ge 1GB) {
        return ("{0:N2} GB" -f ($Bytes / 1GB))
    }
    if ($Bytes -ge 1MB) {
        return ("{0:N1} MB" -f ($Bytes / 1MB))
    }
    return ("{0:N0} B" -f $Bytes)
}

function Test-PathUnderRoot {
    param(
        [string]$Path,
        [string]$Root
    )
    $resolvedPath = Resolve-OrNull $Path
    $resolvedRoot = Resolve-OrNull $Root
    if ($null -eq $resolvedPath -or $null -eq $resolvedRoot) {
        return $false
    }
    $prefix = $resolvedRoot.TrimEnd("\") + "\"
    return $resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function New-CleanupCandidate {
    param(
        [string]$Path,
        [string]$BaseRoot,
        [string]$Reason,
        [string]$Kind
    )
    if (-not (Test-PathUnderRoot -Path $Path -Root $BaseRoot)) {
        throw "Refusing cleanup candidate outside expected root: $Path"
    }
    [pscustomobject]@{
        Path = (Resolve-Path -LiteralPath $Path).Path
        BaseRoot = (Resolve-Path -LiteralPath $BaseRoot).Path
        Kind = $Kind
        Reason = $Reason
        Bytes = Get-PathSizeBytes $Path
    }
}

function Test-ProbeDefaultUsesDiffusers {
    $probePath = Join-Path $PSScriptRoot "ai_runtime_probe.py"
    if (-not (Test-Path -LiteralPath $probePath)) {
        return $false
    }

    $probeText = Get-Content -LiteralPath $probePath -Raw
    return $probeText.Contains('return (Path.home() / ".cache" / "ace-step" / "diffusers").resolve()')
}

$openStudioResolved = Resolve-OrNull $OpenStudioRoot
$aceCacheResolved = Resolve-OrNull $AceCacheRoot
$candidates = New-Object System.Collections.Generic.List[object]
$messages = New-Object System.Collections.Generic.List[string]

Write-Output "OpenStudio storage cleanup audit"
Write-Output ("Mode: " + ($(if ($Apply) { "APPLY" } else { "DRY RUN" })))
Write-Output ("OpenStudio root: " + $OpenStudioRoot)
Write-Output ("ACE cache root: " + $AceCacheRoot)
Write-Output ""

if ($null -eq $openStudioResolved) {
    Write-Output "OpenStudio root does not exist. Nothing to clean there."
} else {
    $sitePackages = Join-Path $openStudioResolved "stem-runtime\Lib\site-packages"
    if (Test-Path -LiteralPath $sitePackages) {
        Get-ChildItem -LiteralPath $sitePackages -Force -Directory |
            Where-Object { $_.Name.StartsWith("~") } |
            ForEach-Object {
                $candidates.Add((New-CleanupCandidate `
                    -Path $_.FullName `
                    -BaseRoot $sitePackages `
                    -Reason "Stale pip backup package folder in stem-runtime" `
                    -Kind "stale-runtime-backup"))
            }
    }

    $logsRoot = Join-Path $openStudioResolved "logs"
    if (Test-Path -LiteralPath $logsRoot) {
        $cutoff = (Get-Date).AddDays(-[Math]::Max(0, $MinLogAgeDays))
        Get-ChildItem -LiteralPath $logsRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            ForEach-Object {
                $candidates.Add((New-CleanupCandidate `
                    -Path $_.FullName `
                    -BaseRoot $logsRoot `
                    -Reason "Log/artifact older than $MinLogAgeDays days" `
                    -Kind "old-log"))
            }
    }
}

if ($IncludeLegacyAceCache) {
    $legacyAce = Join-Path $AceCacheRoot "checkpoints"
    $diffusersAce = Join-Path $AceCacheRoot "diffusers"
    $probeUsesDiffusers = Test-ProbeDefaultUsesDiffusers
    if ($null -ne $aceCacheResolved -and
        (Test-Path -LiteralPath $legacyAce) -and
        (Test-Path -LiteralPath $diffusersAce) -and
        $probeUsesDiffusers) {
        $candidates.Add((New-CleanupCandidate `
            -Path $legacyAce `
            -BaseRoot $AceCacheRoot `
            -Reason "Legacy ACE-Step checkpoints cache; Diffusers cache is present and probe default is diffusers" `
            -Kind "legacy-ace-cache"))
    } else {
        $messages.Add("Legacy ACE cache was requested but skipped because checkpoints, diffusers, or probe verification was missing.")
    }
} else {
    $messages.Add("Legacy ACE checkpoints cache not included. Add -IncludeLegacyAceCache after verifying Diffusers generation works.")
}

$totalBytes = [int64]0
foreach ($candidate in $candidates) {
    $totalBytes += [int64]$candidate.Bytes
}

Write-Output ("Candidates: {0}" -f $candidates.Count)
Write-Output ("Reclaimable: {0}" -f (Format-Size $totalBytes))
Write-Output ""

foreach ($candidate in ($candidates | Sort-Object Kind, Path)) {
    Write-Output ("[{0}] {1} | {2} | {3}" -f $candidate.Kind, (Format-Size $candidate.Bytes), $candidate.Reason, $candidate.Path)
}

foreach ($message in $messages) {
    Write-Output $message
}

if (-not $Apply) {
    Write-Output ""
    Write-Output "Dry run only. Re-run with -Apply to remove the listed candidates."
    exit 0
}

Write-Output ""
Write-Output "Applying cleanup..."
foreach ($candidate in $candidates) {
    if (-not (Test-PathUnderRoot -Path $candidate.Path -Root $candidate.BaseRoot)) {
        throw "Refusing to remove candidate outside expected root: $($candidate.Path)"
    }
    if (Test-Path -LiteralPath $candidate.Path) {
        Remove-Item -LiteralPath $candidate.Path -Recurse -Force
        Write-Output ("Removed: {0}" -f $candidate.Path)
    }
}
Write-Output ("Cleanup complete. Requested reclaim: {0}" -f (Format-Size $totalBytes))
