param([Parameter(Mandatory=$true)][string]$Output,[int]$Port=9351)
$report=[ordered]@{port=$Port;expectedBrowserArguments=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;expectedProfile=$env:WEBVIEW2_USER_DATA_FOLDER;proxyConfigured=[bool]($env:HTTP_PROXY -or $env:HTTPS_PROXY);listeners=@();browserFlags=@();endpoints=@()}
$report.listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue|Select-Object LocalAddress,LocalPort,OwningProcess)
$report.browserFlags=@(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" -ErrorAction SilentlyContinue|ForEach-Object{
    $flags=[regex]::Matches([string]$_.CommandLine,'--remote-debugging-[^ ]+')|ForEach-Object Value
    [pscustomobject]@{id=$_.ProcessId;parent=$_.ParentProcessId;debuggingFlags=@($flags)}
})
foreach($address in @('127.0.0.1','localhost','[::1]')){
    try{$response=Invoke-WebRequest -Uri ('http://'+$address+':'+$Port+'/json/version') -TimeoutSec 3 -NoProxy;$report.endpoints+=@{address=$address;status=$response.StatusCode;content=$response.Content}}
    catch{$report.endpoints+=@{address=$address;error=$_.Exception.Message}}
}
$report|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $Output -Encoding UTF8
