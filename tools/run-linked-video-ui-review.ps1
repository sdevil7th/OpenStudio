param([string]$AppPath='build/OpenStudio_artefacts/Debug/OpenStudio.exe',[string]$Output='output/playwright/linked-video-20261117',[Parameter(Mandatory=$true)][string]$Source,[int]$Port=9351)
$ErrorActionPreference='Stop'
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'Review port is occupied.'}
$app=(Resolve-Path -LiteralPath $AppPath).Path
$sourcePath=(Resolve-Path -LiteralPath $Source).Path
$reviewOutput=[IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Output))
New-Item -ItemType Directory -Force -Path $reviewOutput | Out-Null
$previousArgs=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;$previousProfile=$env:WEBVIEW2_USER_DATA_FOLDER;$previousPackaged=$env:OPENSTUDIO_FORCE_PACKAGED_UI
$owned=$null
try{
    Import-Module (Join-Path $PSScriptRoot 'OwnedDesktopProcess.psm1') -Force
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $reviewOutput ('profile-'+[guid]::NewGuid().ToString('N'))
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port='+$Port
    $env:OPENSTUDIO_FORCE_PACKAGED_UI='1'
    $owned=Start-OwnedDesktopProcess -FilePath $app -ArgumentList @('--ui-performance-review','--report',(Join-Path $reviewOutput 'app.json'))
    & node (Join-Path $PSScriptRoot 'linked-video-ui-review.mjs') --port $Port --app $app --output $reviewOutput --source $sourcePath
    if($LASTEXITCODE -ne 0){throw 'Packaged linked-video UI review failed.'}
    if(-not $owned.WaitForExit(15000)){throw 'Review app did not exit normally.'}
}catch{
    & (Join-Path $PSScriptRoot 'collect-webview-review-diagnostics.ps1') -Output (Join-Path $reviewOutput 'connection-diagnostics.json') -Port $Port
    throw
}finally{
    if($owned){$owned.Dispose()}
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$previousArgs;$env:WEBVIEW2_USER_DATA_FOLDER=$previousProfile;$env:OPENSTUDIO_FORCE_PACKAGED_UI=$previousPackaged
}
