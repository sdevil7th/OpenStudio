param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$FrontendPayload,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$OriginalProject,
    [string]$AppPath,
    [int]$TimeoutSeconds = 2400,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
foreach ($inputPath in @($ProjectPath, $FrontendPayload, $OriginalProject)) {
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Missing qualification input: $inputPath" }
}
if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot 'build') --config Debug
    if ($LASTEXITCODE -ne 0) { throw 'Debug build failed.' }
}
if (-not $AppPath) { $AppPath = Join-Path $repoRoot 'build\OpenStudio_artefacts\Debug\OpenStudio.exe' }
$before = (Get-FileHash -LiteralPath $OriginalProject -Algorithm SHA256).Hash.ToLowerInvariant()
$copyHash = (Get-FileHash -LiteralPath $ProjectPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($before -ne $copyHash) { throw 'The copied project does not match the original.' }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$reportPath = Join-Path $OutputRoot 'project_qualification_result.json'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Resolve-Path -LiteralPath $AppPath).Path
$startInfo.Arguments = "--qualify-project-headless `"$ProjectPath`" --project-qualification-payload `"$FrontendPayload`" --output-dir `"$OutputRoot`" --report `"$reportPath`""
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$lastCompleted = -1
while (-not $process.WaitForExit(1000)) {
    if ([DateTime]::UtcNow -gt $deadline) { $process.Kill(); throw 'Saved-project qualification timed out.' }
    $progressPath = Join-Path $OutputRoot 'progress.json'
    if (Test-Path -LiteralPath $progressPath) {
        # Progress is advisory and can be replaced while we read it. A sharing
        # violation or partial snapshot must not abandon the still-running child.
        # The final result after process exit remains the mandatory gate below.
        try {
            $progress = Get-Content -LiteralPath $progressPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        } catch {
            Write-Verbose "Progress snapshot temporarily unavailable: $($_.Exception.Message)"
            continue
        }
        $completed = @($progress.completedRenders).Count
        if ($completed -ne $lastCompleted) {
            $lastCompleted = $completed
            Write-Host "Completed native project renders: $completed"
        }
    }
}
if (-not (Test-Path -LiteralPath $reportPath)) { throw "Native qualification did not write a report: $reportPath" }
$result = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$after = (Get-FileHash -LiteralPath $OriginalProject -Algorithm SHA256).Hash.ToLowerInvariant()
$unchanged = $before -eq $after
$result | Add-Member -NotePropertyName originalProjectBeforeSha256 -NotePropertyValue $before -Force
$result | Add-Member -NotePropertyName originalProjectAfterSha256 -NotePropertyValue $after -Force
$result | Add-Member -NotePropertyName originalProjectUnchanged -NotePropertyValue $unchanged -Force
$result | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host "Saved-project qualification: $($result.objectiveGateStatus), original unchanged: $unchanged"
Write-Host "Report: $reportPath"
if ($process.ExitCode -ne 0 -or $result.objectiveGateStatus -ne 'pass' -or -not $unchanged) { exit 2 }
exit 0
