param(
    [string]$JobPath,
    [string]$SourceAudioPath,
    [string]$ReferenceAudioPath,
    [string]$NotesJsonPath,
    [string]$FramesJsonPath,
    [string]$TrackId = "pitch-regression-track-1",
    [string]$ClipId = "pitch-regression-clip-1",
    [ValidateSet("single", "full_clip_hq", "note_hq")]
    [string]$RenderMode = "note_hq",
    [double]$GlobalFormantSemitones = 0,
    [double]$TargetShiftSemitones = [double]::NaN,
    [double]$WindowStart = -1,
    [double]$WindowEnd = -1,
    [string]$Label = "pitch-headless-regression",
    [string]$AppPath,
    [string]$OutputRoot,
    [ValidateSet("default", "pitch_only_vocal_source_filter_hq")]
    [string]$RendererBranch = "default",
    [int]$TimeoutSeconds = 180,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-AppPath {
    if ($AppPath -and (Test-Path $AppPath)) {
        return (Resolve-Path $AppPath).Path
    }

    $candidates = @(
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Debug\OpenStudio.exe"),
        (Join-Path $repoRoot "build-check\OpenStudio_artefacts\Release\OpenStudio.exe"),
        (Join-Path $repoRoot "build\OpenStudio_artefacts\Release\OpenStudio.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    throw "OpenStudio.exe not found. Build first or pass -AppPath."
}

function New-RunDirectory {
    $root = if ($OutputRoot) { $OutputRoot } else { Join-Path $repoRoot "tmp_pitch_runs" }
    $safeLabel = ($Label -replace '[^A-Za-z0-9._-]', '_')
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $dir = Join-Path $root "${stamp}_${safeLabel}"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function Convert-ToJsonLiteral {
    param($Value)

    if ($null -eq $Value) {
        return "null"
    }
    if ($Value -is [string]) {
        $escaped = $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
        return '"' + $escaped + '"'
    }
    if ($Value -is [bool]) {
        return $(if ($Value) { "true" } else { "false" })
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
        return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, "{0}", $Value)
    }
    return ($Value | ConvertTo-Json -Compress -Depth 80)
}

function New-HeadlessJob {
    param([Parameter(Mandatory = $true)][string]$RunDirectory)

    if (-not $SourceAudioPath) {
        throw "Provide -SourceAudioPath or -JobPath."
    }
    if (-not $NotesJsonPath) {
        throw "Provide -NotesJsonPath or -JobPath."
    }
    if (-not (Test-Path $SourceAudioPath)) {
        throw "Source audio not found: $SourceAudioPath"
    }
    if (-not (Test-Path $NotesJsonPath)) {
        throw "Notes JSON not found: $NotesJsonPath"
    }
    if ($FramesJsonPath -and -not (Test-Path $FramesJsonPath)) {
        throw "Frames JSON not found: $FramesJsonPath"
    }

    $notesJson = (Get-Content -Raw -Path $NotesJsonPath).Trim()
    $fields = [ordered]@{
        jobType = "render"
        sourceAudioPath = (Resolve-Path $SourceAudioPath).Path
        referenceAudioPath = if ($ReferenceAudioPath -and (Test-Path $ReferenceAudioPath)) { (Resolve-Path $ReferenceAudioPath).Path } else { $ReferenceAudioPath }
        trackId = $TrackId
        clipId = $ClipId
        renderMode = $RenderMode
        globalFormantSemitones = $GlobalFormantSemitones
        resultJsonPath = (Join-Path $RunDirectory "pitch_regression_result.json")
        label = $Label
    }

    if (-not [double]::IsNaN($TargetShiftSemitones)) {
        $fields.targetShiftSemitones = $TargetShiftSemitones
    }
    if ($WindowStart -ge 0 -and $WindowEnd -gt $WindowStart) {
        $fields.windowStartSec = $WindowStart
        $fields.windowEndSec = $WindowEnd
    }

    $jobPathOut = Join-Path $RunDirectory "pitch_regression_job.json"
    $items = @()
    foreach ($key in $fields.Keys) {
        $items += ('  "{0}": {1}' -f $key, (Convert-ToJsonLiteral $fields[$key]))
    }
    $items += ('  "notes": {0}' -f $notesJson)
    if ($FramesJsonPath) {
        $framesJson = (Get-Content -Raw -Path $FramesJsonPath).Trim()
        $items += ('  "frames": {0}' -f $framesJson)
    }
    $jobJson = "{`n" + ($items -join ",`n") + "`n}"
    Set-Content -Path $jobPathOut -Value $jobJson -Encoding UTF8
    return $jobPathOut
}

if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot "build") --config Debug
    if ($LASTEXITCODE -ne 0) {
        throw "Debug build failed."
    }
}

$runDir = New-RunDirectory
if (-not $JobPath) {
    $JobPath = New-HeadlessJob -RunDirectory $runDir
} else {
    if (-not (Test-Path $JobPath)) {
        throw "Job file not found: $JobPath"
    }
    $JobPath = (Resolve-Path $JobPath).Path
}

$resolvedAppPath = Resolve-AppPath
$processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processStartInfo.FileName = $resolvedAppPath
$processStartInfo.Arguments = "--pitch-regression-headless `"$JobPath`""
$processStartInfo.UseShellExecute = $false
$processStartInfo.CreateNoWindow = $true
$processStartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$processStartInfo.Environment["OPENSTUDIO_PITCH_DEBUG"] = "1"
$processStartInfo.Environment["OPENSTUDIO_PITCH_APP_FINAL_CAPTURE_DISABLE"] = "1"
if ($RendererBranch -and $RendererBranch -ne "default") {
    $processStartInfo.Environment["OPENSTUDIO_PITCH_RENDERER_BRANCH"] = $RendererBranch
}

$process = [System.Diagnostics.Process]::Start($processStartInfo)
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw "Headless pitch regression timed out after $TimeoutSeconds seconds."
}
if ($process.ExitCode -ne 0) {
    Write-Warning "Headless pitch regression exited with code $($process.ExitCode). Reading result if available."
}

$job = Get-Content -Raw -Path $JobPath | ConvertFrom-Json
$resultPath = $job.resultJsonPath
if (-not (Test-Path $resultPath)) {
    throw "Headless pitch regression did not write result JSON: $resultPath"
}

$result = Get-Content -Raw -Path $resultPath | ConvertFrom-Json
Write-Host "Headless pitch regression result: $resultPath"
Write-Host "Objective gate status: $($result.objectiveGateStatus)"
Write-Host "Subjective quality: $($result.subjectiveQuality)"
Write-Host "Completion claim: $($result.completionClaim)"
if ($result.outputFile) {
    Write-Host "Output file: $($result.outputFile)"
}
if ($result.checks) {
    $result.checks | ForEach-Object {
        Write-Host ("[{0}] {1} - {2}" -f $_.status, $_.id, $_.detail)
    }
}

if ($result.objectiveGateStatus -eq "fail") {
    exit 2
}
exit 0
