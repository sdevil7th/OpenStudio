param([ValidateSet('Debug', 'Release', 'ASan')][string]$Configuration = 'Debug', [switch]$SkipBuild, [switch]$ExerciseEditors)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot 'build') --config $Configuration
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
}
$app = Join-Path $repoRoot "build/OpenStudio_artefacts/$Configuration/OpenStudio.exe"
$run = Join-Path $repoRoot ('output/review/isolation-' + $Configuration + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $run | Out-Null
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $app
$start.Arguments = '--isolated-plugin-self-test "' + $run + '"'
if ($ExerciseEditors) { $start.Arguments += ' --exercise-isolated-editors' }
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $start
if (-not $process.Start()) { throw 'Could not launch isolated regression.' }
$outTask = $process.StandardOutput.ReadToEndAsync()
$errTask = $process.StandardError.ReadToEndAsync()
try {
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw "Isolation fixture timed out: $run" }
    $outTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $run 'stdout.log')
    $errTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $run 'stderr.log')
    if ($process.ExitCode -ne 0) { throw "Isolation fixture exited $($process.ExitCode): $run" }
    $report = Get-Content -Raw -LiteralPath (Join-Path $run 'result.json') | ConvertFrom-Json
    if (-not $report.passed) { throw "Isolation contracts failed: $run" }
    @{ configuration = $Configuration; executableSha256 = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash;
       checks = $report.checks.Count; status = 'pass'; subjectiveAudio = 'not_asserted'; thirdPartyCompatibility = 'not_asserted' } |
        ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $run 'qualification.json')
    Write-Host "Isolation: $($report.checks.Count) checks passed. Evidence: $run"
} finally { $process.Dispose() }
