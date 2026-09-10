#define MyAppName "OpenStudio"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.1"
#endif
#ifndef MyAppPublisher
  #define MyAppPublisher "OpenStudio"
#endif
#ifndef MyAppExeName
  #define MyAppExeName "OpenStudio.exe"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\build\OpenStudio_artefacts\Release"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist\windows"
#endif
#define WebView2Bootstrapper "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
#define VCRedistInstaller "vc_redist.x64.exe"

[Setup]
AppId={{B8E63C80-6F66-4C32-AF3B-6AA9D9A2F5B6}
AppName={#MyAppName}
AppVerName={#MyAppName} {#MyAppVersion}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf64}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
SetupLogging=yes
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename=OpenStudio-Setup-x64
ChangesAssociations=yes
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}
VersionInfoProductTextVersion={#MyAppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
; Keep debugging evidence in the matching symbol archive, outside the installer.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "*.pdb,*.ilk,*.log,*.dmp"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCR; Subkey: ".osproj"; ValueType: string; ValueName: ""; ValueData: "OpenStudio.Project"; Flags: uninsdeletevalue
Root: HKCR; Subkey: "OpenStudio.Project"; ValueType: string; ValueName: ""; ValueData: "OpenStudio Project"; Flags: uninsdeletekey
Root: HKCR; Subkey: "OpenStudio.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey
Root: HKCR; Subkey: "OpenStudio.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: CanLaunchInstalledApp

[Code]
var
  CanLaunchInstalledAppValue: Boolean;
  StartupSelfTestReportPath: string;
  PrerequisiteRestartRequired: Boolean;
  PrerequisiteLogDirectory: string;
  LastPrerequisiteResult: Integer;

procedure SetInstallStatus(const StatusText, DetailText: string);
begin
  WizardForm.StatusLabel.Caption := StatusText;
  WizardForm.FilenameLabel.Caption := DetailText;
  WizardForm.StatusLabel.Update;
  WizardForm.FilenameLabel.Update;
  WizardForm.Repaint;
end;

function ValidateInstalledShellPayload(): Boolean;
var
  MissingItems: string;
begin
  MissingItems := '';

  if not FileExists(ExpandConstant('{app}\OpenStudio.exe')) then
    MissingItems := MissingItems + #13#10 + ' - OpenStudio.exe';
  if not FileExists(ExpandConstant('{app}\webui\index.html')) then
    MissingItems := MissingItems + #13#10 + ' - webui\index.html';

  Result := MissingItems = '';

  if not Result then
    MsgBox(
      'OpenStudio installed, but required shell files are missing:' + MissingItems + #13#10#13#10 +
      'Please reinstall OpenStudio or rebuild the installer before launching it.',
      mbCriticalError,
      MB_OK
    );
end;

function VCRuntimeIsSufficient(const InstallerPath: string): Boolean;
var
  RequiredVersion, InstalledVersion: Int64;
  Installed, Major, Minor, Build, Revision: Cardinal;
  Root: Integer;
  RegistryRoot: Integer;
  Key: string;
begin
  Result := False;
  if not GetPackedVersion(InstallerPath, RequiredVersion) then exit;
  Key := 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64';
  for Root := 0 to 1 do
  begin
    if Root = 0 then RegistryRoot := HKLM64 else RegistryRoot := HKLM32;
    if RegQueryDWordValue(RegistryRoot, Key, 'Major', Major) and
       RegQueryDWordValue(RegistryRoot, Key, 'Minor', Minor) and
       RegQueryDWordValue(RegistryRoot, Key, 'Bld', Build) and
       RegQueryDWordValue(RegistryRoot, Key, 'Rbld', Revision) and
       RegQueryDWordValue(RegistryRoot, Key, 'Installed', Installed) then
    begin
      if (Installed = 1) and (Major <= 65535) and (Minor <= 65535) and
         (Build <= 65535) and (Revision <= 65535) then
      begin
        InstalledVersion := PackVersionComponents(Major, Minor, Build, Revision);
        Result := ComparePackedVersion(InstalledVersion, RequiredVersion) >= 0;
        Log('VC++ installed=' + VersionToStr(InstalledVersion) + '; required=' + VersionToStr(RequiredVersion));
        if Result then exit;
      end;
    end;
  end;
end;

function MachineWebView2Installed(): Boolean;
var
  Version: string;
begin
  { A machine-wide installation must work for the original user even when UAC
    credentials belong to another administrator. Do not rely on that admin's HKCU. }
  Result := RegQueryStringValue(HKLM32,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

function RunPrerequisiteInstaller(const FilePath, Parameters, FriendlyName: string): Boolean;
begin
  LastPrerequisiteResult := -1;
  if not FileExists(FilePath) then
    Log(FriendlyName + ' installer missing: ' + FilePath)
  else if not Exec(FilePath, Parameters, '', SW_SHOWNORMAL, ewWaitUntilTerminated, LastPrerequisiteResult) then
    Log('Could not start ' + FriendlyName + ': ' + SysErrorMessage(LastPrerequisiteResult));
  Log(FriendlyName + ' exit code: ' + IntToStr(LastPrerequisiteResult));
  SaveStringToFile(PrerequisiteLogDirectory + '\prerequisites.log',
    GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' ' + FriendlyName +
    ' exit code=' + IntToStr(LastPrerequisiteResult) + #13#10, True);
  if (LastPrerequisiteResult = 3010) or (LastPrerequisiteResult = 1641) then
    PrerequisiteRestartRequired := True;
  Result := (LastPrerequisiteResult = 0) or (LastPrerequisiteResult = 3010) or (LastPrerequisiteResult = 1641);
end;

function EnsurePrerequisite(const FilePath, Parameters, FriendlyName, ManualURL: string; IsVC: Boolean): Boolean;
var
  Installed, Started: Boolean;
  Choice: Integer;
begin
  Result := False;
  while True do
  begin
    if IsVC then Installed := VCRuntimeIsSufficient(FilePath)
    else Installed := MachineWebView2Installed();
    if Installed then begin Result := True; exit; end;
    SetInstallStatus('Installing runtime dependencies...', 'Installing ' + FriendlyName);
    Started := RunPrerequisiteInstaller(FilePath, Parameters, FriendlyName);
    if IsVC then Installed := VCRuntimeIsSufficient(FilePath)
    else Installed := MachineWebView2Installed();
    { Version-conflict codes are successful only if the required runtime is verified. }
    if Installed then begin Result := True; exit; end;
    if Started and ((LastPrerequisiteResult = 3010) or (LastPrerequisiteResult = 1641)) then begin Result := True; exit; end;
    Choice := MsgBox('OpenStudio could not verify ' + FriendlyName + '.' + #13#10#13#10 +
      'Installer result: ' + IntToStr(LastPrerequisiteResult) + #13#10 +
      'Logs: ' + PrerequisiteLogDirectory + #13#10#13#10 +
      'Check the log, then choose Retry. You can also install the runtime from:' + #13#10 +
      ManualURL + #13#10#13#10 + 'Setup requests administrator permission automatically. OpenStudio itself does not need administrator access.',
      mbError, MB_RETRYCANCEL);
    if Choice <> IDRETRY then exit;
  end;
end;

procedure InstallOrRepairPrerequisites();
var
  VCRedistInstallerPath, WebView2InstallerPath: string;
begin
  PrerequisiteLogDirectory := ExpandConstant('{commonappdata}\OpenStudio\InstallerLogs');
  if not ForceDirectories(PrerequisiteLogDirectory) then PrerequisiteLogDirectory := ExpandConstant('{tmp}');
  VCRedistInstallerPath := ExpandConstant('{app}\prereqs\windows\{#VCRedistInstaller}');
  WebView2InstallerPath := ExpandConstant('{app}\prereqs\windows\{#WebView2Bootstrapper}');
  CanLaunchInstalledAppValue := EnsurePrerequisite(VCRedistInstallerPath,
    '/install /passive /norestart /log "' + PrerequisiteLogDirectory + '\vc-redist.log"',
    'Microsoft Visual C++ Redistributable', 'https://aka.ms/vs/17/release/vc_redist.x64.exe', True);
  if CanLaunchInstalledAppValue then
    CanLaunchInstalledAppValue := EnsurePrerequisite(WebView2InstallerPath, '/silent /install',
      'Microsoft Edge WebView2 Runtime', 'https://developer.microsoft.com/microsoft-edge/webview2/', False);
end;

function NeedRestart(): Boolean;
begin
  Result := PrerequisiteRestartRequired;
end;

function RunStartupSelfTest(): Boolean;
var
  ResultCode: Integer;
  SelfTestExecutable: string;
  SelfTestArguments: string;
  ReportText: AnsiString;
begin
  SelfTestExecutable := ExpandConstant('{app}\{#MyAppExeName}');
  StartupSelfTestReportPath := ExpandConstant('{tmp}\OpenStudio_StartupSelfTest.txt');
  DeleteFile(StartupSelfTestReportPath);

  SelfTestArguments := '--startup-self-test --report "' + StartupSelfTestReportPath + '"';

  SetInstallStatus('Validating shell startup...', 'Running OpenStudio startup self-test');

  if not Exec(SelfTestExecutable, SelfTestArguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    CanLaunchInstalledAppValue := False;
    MsgBox('OpenStudio could not start its shell self-test executable.', mbCriticalError, MB_OK);
    Result := False;
    exit;
  end;

  Result := ResultCode = 0;
  if Result then
    exit;

  CanLaunchInstalledAppValue := False;
  ReportText := '';
  if FileExists(StartupSelfTestReportPath) then
    LoadStringFromFile(StartupSelfTestReportPath, ReportText);

  if ReportText <> '' then
  begin
    MsgBox(
      'OpenStudio shell validation failed after installation:' + #13#10#13#10 + ReportText + #13#10#13#10 +
      'OpenStudio will not be launched automatically.',
      mbCriticalError,
      MB_OK
    );
  end
  else
  begin
    MsgBox(
      'OpenStudio shell validation failed after installation and no self-test report was written.' + #13#10#13#10 +
      'OpenStudio will not be launched automatically.',
      mbCriticalError,
      MB_OK
    );
  end;
end;

procedure InitializeWizard();
begin
  CanLaunchInstalledAppValue := True;
  PrerequisiteRestartRequired := False;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then
    exit;

  CanLaunchInstalledAppValue := True;
  SetInstallStatus('Validating installed shell files...', 'Checking OpenStudio executable and packaged frontend');

  if CanLaunchInstalledAppValue and (not ValidateInstalledShellPayload()) then
    CanLaunchInstalledAppValue := False;

  if CanLaunchInstalledAppValue then
    InstallOrRepairPrerequisites();

  if CanLaunchInstalledAppValue and (not PrerequisiteRestartRequired) and (not RunStartupSelfTest()) then
    CanLaunchInstalledAppValue := False;
end;

function CanLaunchInstalledApp(): Boolean;
begin
  Result := CanLaunchInstalledAppValue and (not PrerequisiteRestartRequired);
end;

function InitializeUninstall(): Boolean;
begin
  Result := MsgBox(
    'Uninstalling OpenStudio will also remove its user-scoped app data for a fresh reinstall state.' + #13#10#13#10 +
    'This includes AI runtime files, downloaded models, logs, cached downloads, and OpenStudio settings under Local and Roaming AppData.' + #13#10#13#10 +
    'Project folders outside AppData will not be deleted.' + #13#10#13#10 +
    'Do you want to continue?',
    mbConfirmation,
    MB_YESNO
  ) = IDYES;
end;
