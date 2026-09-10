param(
    [ValidateSet('Debug', 'Release', 'ASan')] [string]$Configuration = 'Debug',
    [switch]$SkipBuild,
    [switch]$SkipCrashTests
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
    & cmake --build (Join-Path $repoRoot 'build') --config $Configuration
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
}
$app = Join-Path $repoRoot "build/OpenStudio_artefacts/$Configuration/OpenStudio.exe"
if (-not (Test-Path -LiteralPath $app)) { throw "Missing app: $app" }
$run = Join-Path $repoRoot ('output/review/runtime-' + $Configuration + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $run | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
function Invoke-Fixture([string]$Name, [string]$Arguments, [bool]$ExpectedCrash = $false, [int]$ExpectedExit = 0) {
    $directory = Join-Path $run $Name
    New-Item -ItemType Directory -Path $directory | Out-Null
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $app
    $start.Arguments = $Arguments.Replace('{directory}', $directory)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Could not start $Name" }
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    try {
        if (-not $process.WaitForExit(30000)) {
            $process.Kill() # Only this isolated headless fixture, never an existing app.
            throw "Fixture $Name timed out."
        }
        $outTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'stdout.log')
        $errTask.Result | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'stderr.log')
        # 0xE0425354 is the deliberate noncontinuable fixture exception.
        # A different crash or an ASan abort is a failure, not a successful test.
        if (($ExpectedCrash -and $process.ExitCode -ne -532524204) -or (-not $ExpectedCrash -and $process.ExitCode -ne $ExpectedExit)) {
            throw "Unexpected exit code $($process.ExitCode) for $Name; see $directory"
        }
        $results.Add(@{ fixture = $Name; exitCode = $process.ExitCode; status = 'pass' })
    } finally { $process.Dispose() }
    return $directory
}
$native = Invoke-Fixture 'contracts' '--runtime-safety-self-test "{directory}"'
$report = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $native 'result.json') | ConvertFrom-Json
if (-not $report.passed) { throw 'Native contract checks failed.' }
if ($Configuration -eq 'ASan' -and -not $report.addressSanitizer) { throw 'ASan build was not instrumented.' }
Write-Host "Native checks: $($report.checks.Count) passed; ASan=$($report.addressSanitizer)"
if (-not $SkipCrashTests) {
    $interrupted = Invoke-Fixture 'untitled-crash' '--recovery-session-fixture "{directory}" --simulate-crash' $true
    $discovered = Invoke-Fixture 'untitled-discovery' ('--recovery-discovery-fixture "' + $interrupted + '" --report "{directory}/recovery.json"')
    $entries = @(Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $discovered 'recovery.json') | ConvertFrom-Json)
    if ($entries.Count -ne 1 -or $entries[0].projectName -ne 'Interrupted untitled session' -or $entries[0].sourcePath -ne '') { throw 'Crashed untitled session was not discovered.' }
    $cleanSession = Invoke-Fixture 'clean-recovery-session' '--recovery-session-fixture "{directory}"'
    $cleanDiscovery = Invoke-Fixture 'clean-recovery-discovery' ('--recovery-discovery-fixture "' + $cleanSession + '" --report "{directory}/recovery.json"')
    $cleanJson = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $cleanDiscovery 'recovery.json')
    $cleanDocument = ConvertFrom-Json ('{"entries":' + $cleanJson + '}')
    if ($cleanDocument.entries.Count -ne 0) { throw 'Cleanly closed session incorrectly offered recovery.' }
    $recovery = Invoke-Fixture 'recovery-after-crash' '--runtime-safety-self-test "{directory}" --simulate-recovery-crash' $true
    $saved = Get-Content -Raw -LiteralPath (Join-Path $recovery 'session.osproj') | ConvertFrom-Json
    $versions = @(Get-ChildItem -LiteralPath $recovery -Filter 'session.osproj.recovery-*.osproj')
    if ($saved.projectName -ne 'second' -or $versions.Count -ne 3) { throw 'Saved/recovery project lost after process crash.' }
    foreach ($version in $versions) {
        $document = Get-Content -Raw -LiteralPath $version.FullName | ConvertFrom-Json
        if ($document.projectName -notin @('first', 'second')) { throw 'Recovery generation is not loadable after crash.' }
    }
    $quiet = Invoke-Fixture 'diagnostics' '--crash-diagnostics-self-test "{directory}"'
    $hang = Invoke-Fixture 'hang' '--crash-diagnostics-self-test "{directory}" --simulate-hang'
    $hangLog = Get-Content -Raw -LiteralPath (Join-Path $hang 'hang_breadcrumbs.log')
    if ($hangLog -notmatch 'diagnostic, not a crash' -or $hangLog -notmatch 'injected_uncooperative_worker' -or (Get-Item -LiteralPath (Join-Path $hang 'last_hang.dmp')).Length -lt 1000) { throw 'Missing hang evidence.' }
    foreach ($mode in @('shutdown-hang', 'shutdown-dump-failure')) {
        $extra = if ($mode -eq 'shutdown-dump-failure') { ' --simulate-dump-write-failure' } else { '' }
        # 0xE0535154: reporter-enforced committed final Quit, not an arbitrary crash.
        $shutdown = Invoke-Fixture $mode ('--crash-diagnostics-self-test "{directory}" --simulate-shutdown-hang' + $extra) $false -531410604
        $shutdownLog = Get-Content -Raw -LiteralPath (Join-Path $shutdown 'hang_breadcrumbs.log')
        if ($shutdownLog -notmatch 'injected_final_quit_uncooperative_worker') { throw 'Missing final-quit evidence.' }
        if ($mode -eq 'shutdown-hang' -and -not (Test-Path -LiteralPath (Join-Path $shutdown 'last_hang.dmp'))) { throw 'Missing final-quit dump.' }
    }
    $hangCrash = Invoke-Fixture 'hang-then-crash' '--crash-diagnostics-self-test "{directory}" --simulate-hang --simulate-crash' $true
    if (-not (Test-Path -LiteralPath (Join-Path $hangCrash 'last_hang.dmp')) -or -not (Test-Path -LiteralPath (Join-Path $hangCrash 'last_crash.dmp'))) { throw 'Hang evidence interfered with subsequent crash capture.' }
    foreach ($mode in @('external', 'fallback', 'write-failure')) {
        $extra = if ($mode -eq 'fallback') { ' --simulate-reporter-unavailable' } elseif ($mode -eq 'write-failure') { ' --simulate-dump-write-failure' } else { '' }
        $fixture = Invoke-Fixture $mode ('--crash-diagnostics-self-test "{directory}" --simulate-crash' + $extra) $true
        $log = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $fixture 'crash_breadcrumbs.log')
        $dump = Join-Path $fixture 'last_crash.dmp'
        if ($mode -eq 'write-failure') {
            if ($log -notmatch 'dumpSucceeded=false' -or (Get-Content -Raw -LiteralPath $dump) -ne 'previous dump preserved') { throw 'Failed dump did not preserve prior evidence.' }
        } else {
            if ($log -notmatch 'dumpSucceeded=true' -or (Get-Item -LiteralPath $dump).Length -lt 1000) { throw "Missing valid $mode dump." }
            $expectedMode = if ($mode -eq 'fallback') { 'in-process-fallback' } else { 'external' }
            if ($log -notmatch "mode=$expectedMode") { throw "Unexpected reporter mode for $mode" }
        }
    }
}
$binary = Get-Item -LiteralPath $app
@{ configuration = $Configuration; executable = $app; executableSha256 = (Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash;
   executableWriteTimeUtc = $binary.LastWriteTimeUtc.ToString('o'); fixtures = $results;
   subjectiveAudio = 'not_asserted'; hardwareDrivers = 'not_asserted' } |
    ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $run 'qualification.json')
Write-Host "Runtime safety evidence: $run"
