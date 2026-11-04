param(
    [Parameter(Mandatory=$true)][string]$PackagePath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Certification output must be a new directory to exclude stale reports.' }
New-Item -ItemType Directory -Path $output | Out-Null
$report = Join-Path $output 'wack.xml'
$summary = @{ status='blocked'; packageSha256=(Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash; published=$false }
try {
    $admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (!$admin) { throw 'WACK requires an administrator test session; no elevation or policy change was attempted.' }
    if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'WACK requires an active user session, not Session 0.' }
    if (Get-AppxPackage -Name SouravDas.OpenStudio) { throw 'Use a disposable test account without an existing OpenStudio Store installation.' }
    $kit = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/App Certification Kit/appcert.exe'
    if (!(Test-Path -LiteralPath $kit)) { throw 'Windows App Certification Kit is not installed on this runner.' }
    $reset = Start-Process -FilePath $kit -ArgumentList 'reset' -PassThru -Wait -WindowStyle Hidden
    if ($reset.ExitCode -ne 0) { throw "WACK reset failed: $($reset.ExitCode)" }
    $summary.status = 'fail'
    $test = Start-Process -FilePath $kit -ArgumentList @('test', '-appxpackagepath', ('"{0}"' -f $package), '-reportoutputpath', ('"{0}"' -f $report)) -PassThru -Wait -WindowStyle Hidden
    $summary.kitExitCode = $test.ExitCode
    if (!(Test-Path -LiteralPath $report)) { throw 'WACK did not produce an XML report.' }
    [xml]$xml = Get-Content -LiteralPath $report -Raw
    $overall = $xml.DocumentElement.GetAttribute('OVERALL_RESULT')
    $summary.overallResult = $overall
    $tests = @($xml.SelectNodes('/REPORT/REQUIREMENTS/REQUIREMENT/TEST'))
    $required = @($tests | Where-Object { $_.GetAttribute('OPTIONAL') -ine 'TRUE' })
    $summary.requiredTestCount = $required.Count
    $summary.requiredIssues = @($required | Where-Object { $_.SelectSingleNode('RESULT').InnerText -ine 'PASS' } | ForEach-Object {
        @{ name=$_.GetAttribute('NAME'); result=$_.SelectSingleNode('RESULT').InnerText; messages=@($_.SelectNodes('MESSAGES/MESSAGE') | ForEach-Object { $_.GetAttribute('TEXT') }) }
    })
    $summary.optionalIssues = @($tests | Where-Object { $_.GetAttribute('OPTIONAL') -ieq 'TRUE' -and $_.SelectSingleNode('RESULT').InnerText -ine 'PASS' } | ForEach-Object {
        @{ name=$_.GetAttribute('NAME'); result=$_.SelectSingleNode('RESULT').InnerText; messageCount=@($_.SelectNodes('MESSAGES/MESSAGE')).Count }
    })
    $summary.requiredTestsStatus = if ($required.Count -gt 0 -and $summary.requiredIssues.Count -eq 0 -and $test.ExitCode -eq 0 -and $xml.DocumentElement.GetAttribute('PARTIAL_RUN') -ieq 'FALSE') { 'pass' } else { 'not_passed' }
    # Keep the aggregate gate strict. Informational findings are preserved for
    # review, not silently converted into a Store certification pass.
    if ($test.ExitCode -ne 0 -or $overall -ine 'PASS' -or $summary.requiredTestsStatus -ne 'pass') {
        throw "WACK did not pass: result '$overall', required tests '$($summary.requiredTestsStatus)', exit $($test.ExitCode). Review the retained XML."
    }
    $summary.status = 'pass'
} catch {
    $summary.reason = $_.Exception.Message
    throw
} finally {
    $summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'summary.json') -Encoding utf8
}
