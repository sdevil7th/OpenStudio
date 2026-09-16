param([switch]$RunWindowLifecycle, [switch]$RunStoreQuery)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-AppxPackage -Name SouravDas.OpenStudio
if (!$package) { throw 'Register/install the OpenStudio MSIX first. See docs/release-runbook.md#microsoft-store-distribution.' }
$run = Join-Path $repoRoot ('output/review/store-installed-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $run | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenStudioStoreActivation {
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  private class ApplicationActivationManager {}
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    [PreserveSig] int ActivateForFile(IntPtr a, IntPtr b, IntPtr c, out uint pid);
    [PreserveSig] int ActivateForProtocol(IntPtr a, IntPtr b, out uint pid);
  }
  public static uint Launch(string id, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint pid;
    try { Marshal.ThrowExceptionForHR(manager.ActivateApplication(id, arguments, 0, out pid)); return pid; }
    finally { Marshal.ReleaseComObject(manager); }
  }
}
'@
$aumid = $package.PackageFamilyName + '!OpenStudio'
function Invoke-PackageFixture([string]$Name, [string]$Arguments) {
    $report = Join-Path $run ($Name + '.json')
    $processId = [OpenStudioStoreActivation]::Launch($aumid, $Arguments.Replace('{report}', $report))
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and !$process.WaitForExit(180000)) {
        # Only terminate the test instance launched above.
        Stop-Process -Id $processId -Force
        throw "Packaged fixture timed out: $Name"
    }
    if (!(Test-Path -LiteralPath $report)) { throw "Packaged fixture did not produce $report" }
    $text = Get-Content -LiteralPath $report -Raw
    if ($Name -eq 'startup') { return @{ success = $text -match '(?m)^shellReady=true\r?$' } }
    return $text | ConvertFrom-Json
}
$identity = Invoke-PackageFixture 'identity' '--store-package-self-test "{report}"'
if (!$identity.pass) { throw 'Packaged identity/update contract failed.' }
$startup = Invoke-PackageFixture 'startup' '--startup-self-test --report "{report}"'
if (!$startup.success) { throw 'Packaged startup prerequisite test failed.' }
if ($RunStoreQuery) {
    $query = Invoke-PackageFixture 'store-query' '--store-update-query-self-test "{report}"'
    if (!$query.pass) { throw "Store API query did not succeed: $($query.status.message). Evidence: $run/store-query.json. A development registration does not prove Store association or upgrade delivery." }
}
if ($RunWindowLifecycle) {
    $lifecycle = Invoke-PackageFixture 'windows' '--window-lifecycle-harness --report "{report}"'
    if (!$lifecycle.success) { throw 'Packaged window lifecycle failed.' }
    foreach ($name in @('main_frontend_ready', 'mixer_frontend_ready', 'mixer_reopened_frontend_ready',
                        'midi_frontend_ready', 'midi_reopened_frontend_ready', 'plugin_frontend_ready', 'plugin_reopened_frontend_ready')) {
        if (!@($lifecycle.checks | Where-Object { $_.id -eq $name -and $_.status -eq 'pass' }).Count) { throw "Missing boot-ready: $name" }
    }
}
Write-Output "Packaged tests passed: $run"
Write-Output 'Hardware, live OAuth, optional AI, clean-machine dependency and Store upgrade tests remain separate.'
