param(
    [Parameter(Mandatory=$true)][string]$BundlePath,
    [string]$OutputDir = 'output/support-msix-qa'
)
# Disposable identity, no Store upload, certificate installation or policy changes.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = (Resolve-Path -LiteralPath $BundlePath).Path
$work = Join-Path ([IO.Path]::GetFullPath($OutputDir)) ([guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'package'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'OpenStudioSupport.exe') -Destination $stage
Copy-Item -LiteralPath (Join-Path $source 'support-runtime') -Destination $stage -Recurse
$fixture = Join-Path $work 'Fixture.cs'
Set-Content -LiteralPath $fixture -Value 'class Fixture { static void Main() { System.Threading.Thread.Sleep(500); } }'
& "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:winexe "/out:$stage/OpenStudio.exe" $fixture
if ($LASTEXITCODE -ne 0) { throw 'Failed to build isolated DAW placeholder' }
[xml]$manifest = (Get-Content (Join-Path $repoRoot 'packaging/msix/AppxManifest.xml.in') -Raw).Replace('@VERSION@', '0.0.0.0')
$identity = 'OpenStudioQA' + [guid]::NewGuid().ToString('N')
$manifest.Package.Identity.Name = $identity
# The main DAW is a placeholder; do not register a competing .osproj association.
foreach ($app in $manifest.Package.Applications.Application) {
    foreach ($extension in @($app.ChildNodes | Where-Object LocalName -eq 'Extensions')) { [void]$app.RemoveChild($extension) }
}
$developerMode = (Get-ItemProperty 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/AppModelUnlock' -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense -eq 1
$admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$developerMode -and !$admin) { throw 'MSIX qualification needs existing Developer Mode or an administrator test runner; no policy was changed.' }
if (!$developerMode) { $manifest.Package.Identity.Publisher = 'CN=OpenStudioSupportQA, OID.2.25.311729368913984317654407730594956997722=1' }
$manifest.Save((Join-Path $stage 'AppxManifest.xml'))
$assets = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Path $assets | Out-Null
Add-Type -AssemblyName System.Drawing
$icon = [Drawing.Image]::FromFile((Join-Path $repoRoot 'assets/icon-1024x1024.png'))
try {
    foreach ($entry in @(@('StoreLogo',50), @('Square44x44Logo',44), @('Square150x150Logo',150))) {
        $bitmap = [Drawing.Bitmap]::new([int]$entry[1], [int]$entry[1]); $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.DrawImage($icon, 0, 0, [int]$entry[1], [int]$entry[1]); $bitmap.Save((Join-Path $assets ($entry[0]+'.png')), [Drawing.Imaging.ImageFormat]::Png) }
        finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $icon.Dispose() }
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin" -Directory |
    Where-Object Name -Match '^10\.0\.\d+\.0$' | Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64' } | Where-Object { Test-Path (Join-Path $_ 'makeappx.exe') } | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK MakeAppx is required' }
$archive = Join-Path $work 'SupportQualification.msix'
& "$sdk/makeappx.exe" pack /d $stage /p $archive /h SHA256 /o | Tee-Object -FilePath (Join-Path $work 'makeappx.log') -Append | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'MSIX validation/packing failed' }
$expanded = Join-Path $work 'roundtrip'
& "$sdk/makeappx.exe" unpack /p $archive /d $expanded /o | Tee-Object -FilePath (Join-Path $work 'makeappx.log') -Append | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'MSIX unpack failed' }
foreach ($file in Get-ChildItem $stage -Recurse -File) {
    $copy = Join-Path $expanded $file.FullName.Substring($stage.Length+1)
    if ((Get-FileHash $copy).Hash -ne (Get-FileHash $file.FullName).Hash) { throw 'MSIX payload changed during round trip' }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupportPackageActivation {
  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] private class Manager {}
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint pid);
    [PreserveSig] int ActivateForFile(IntPtr a, IntPtr b, IntPtr c, out uint pid);
    [PreserveSig] int ActivateForProtocol(IntPtr a, IntPtr b, out uint pid);
  }
  public static uint Launch(string id, string args) {
    var manager = (IManager)new Manager(); uint pid;
    try { Marshal.ThrowExceptionForHR(manager.ActivateApplication(id,args,0,out pid)); return pid; }
    finally { Marshal.ReleaseComObject(manager); }
  }
}
'@
$registered = $null
try {
    if ($developerMode) { Add-AppxPackage -Register (Join-Path $expanded 'AppxManifest.xml') }
    else { Add-AppxPackage -Path $archive -AllowUnsigned }
    $registered = Get-AppxPackage -Name $identity
    if (!$registered) { throw 'Test package was not registered' }
    $apps = @(Get-StartApps | Where-Object AppID -Like ($registered.PackageFamilyName+'!*'))
    if (!($apps.AppID -contains ($registered.PackageFamilyName+'!OpenStudioSupport'))) { throw 'Support Start menu entry missing' }
    $before = @(Get-Process OpenStudioSupport -ErrorAction SilentlyContinue).Id
    $mainId = [SupportPackageActivation]::Launch($registered.PackageFamilyName+'!OpenStudio', '')
    $main = Get-Process -Id $mainId -ErrorAction SilentlyContinue
    if ($main -and !$main.WaitForExit(30000)) { Stop-Process -Id $mainId; throw 'DAW placeholder timed out' }
    $after = @(Get-Process OpenStudioSupport -ErrorAction SilentlyContinue).Id
    if (@($after | Where-Object { $_ -notin $before }).Count) { throw 'Support started without explicit activation' }
    $report = Join-Path $work 'installed-support.json'
    $supportId = [SupportPackageActivation]::Launch($registered.PackageFamilyName+'!OpenStudioSupport', ('--self-test "'+$report+'"'))
    $support = Get-Process -Id $supportId -ErrorAction SilentlyContinue
    if ($support -and !$support.WaitForExit(90000)) { Stop-Process -Id $supportId; throw 'Packaged support timed out' }
    $result = Get-Content $report -Raw | ConvertFrom-Json
    if ($result.status -ne 'pass' -or $result.packageIdentity -notlike "$identity`_*") { throw "Packaged support identity/self-test failed: $report" }
    @{ status='pass'; msixRoundTrip='pass'; startMenuActivation='pass'; idleOnInstallAndDAWLaunch='pass'; storeCertification='not_asserted'; scope='Production support payload and manifest; isolated identity and dummy DAW' } |
        ConvertTo-Json | Set-Content (Join-Path $work 'qualification.json')
} finally {
    $registered = Get-AppxPackage -Name $identity
    if ($registered) { Remove-AppxPackage -Package $registered.PackageFullName }
}
if (Get-AppxPackage -Name $identity) { throw 'Test package cleanup failed' }
Write-Output "PASS MSIX pack/unpack, registration, Start menu activation, package identity, no implicit support launch, unregister: $work"
