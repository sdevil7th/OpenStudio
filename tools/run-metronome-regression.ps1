param(
    [ValidateSet('Debug', 'Release', 'ASan')] [string]$Configuration = 'Debug',
    [string]$Label = 'qualification',
    [switch]$SkipBuild,
    [switch]$AllowFailure
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot 'build') --config $Configuration
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
}
$app = Join-Path $repoRoot "build/OpenStudio_artefacts/$Configuration/OpenStudio.exe"
$safeLabel = $Label -replace '[^a-zA-Z0-9_-]', '_'
$directory = Join-Path $repoRoot ('output/review/metronome-' + $Configuration + '-' + $safeLabel + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $directory | Out-Null
$reportPath = Join-Path $directory 'report.json'
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $app
$start.Arguments = '--automated-regression-headless --report "' + $reportPath + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables['OPENSTUDIO_METRONOME_FIXTURES_ONLY'] = '1'
$process = [System.Diagnostics.Process]::Start($start)
$outTask = $process.StandardOutput.ReadToEndAsync()
$errTask = $process.StandardError.ReadToEndAsync()
try {
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Metronome fixture timed out.' }
    $outTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'stdout.log')
    $errTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'stderr.log')
    $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath | ConvertFrom-Json
    Write-Host "Metronome evidence: $reportPath"
    $report.suites | Where-Object { -not $_.pass } | Format-Table id, detail -Wrap
    $report.timings | Format-Table
    if ((-not $report.overallPass -or $process.ExitCode -ne 0) -and -not $AllowFailure) {
        throw 'Metronome signal/transport contract failed.'
    }
} finally { $process.Dispose() }
