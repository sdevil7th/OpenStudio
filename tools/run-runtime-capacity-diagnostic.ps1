param(
    [ValidateSet('Debug', 'Release')] [string]$Configuration = 'Release',
    [ValidateRange(1, 10)] [int]$Runs = 3
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repoRoot "build/OpenStudio_artefacts/$Configuration/OpenStudio.exe"
if (-not (Test-Path -LiteralPath $app)) { throw "Build $Configuration first." }
$directory = Join-Path $repoRoot ('output/review/capacity-' + $Configuration + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $directory | Out-Null
$identity = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash
for ($index = 1; $index -le $Runs; $index++) {
    $reportPath = Join-Path $directory "run-$index.json"
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $app
    $start.Arguments = '--automated-regression-headless --report "' + $reportPath + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Child-only settings: never alter the user's ordinary live-monitoring launch.
    $start.EnvironmentVariables['OPENSTUDIO_RT_SAFETY_FIXTURES_ONLY'] = '1'
    $start.EnvironmentVariables['OPENSTUDIO_CAPACITY_BENCHMARK'] = '1'
    $process = [System.Diagnostics.Process]::Start($start)
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Capacity diagnostic timed out.' }
        $outTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory "run-$index.stdout.log")
        $errTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory "run-$index.stderr.log")
        if ($process.ExitCode -ne 0) { throw "Capacity diagnostic exited $($process.ExitCode)." }
        $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $reportPath | ConvertFrom-Json
        if (-not $report.overallPass) { throw 'Signal/contract invariants failed; timings are not a substitute.' }
        Write-Host "Run $index signal invariants passed. Timings are diagnostic_only: $reportPath"
    } finally { $process.Dispose() }
}
@{ configuration = $Configuration; executableSha256 = $identity; runs = $Runs;
   performance = 'diagnostic_only'; fullMixRecordingCapacity = 'not_asserted' } |
    ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'qualification.json')
Write-Host "Capacity evidence: $directory"
