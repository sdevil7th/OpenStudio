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

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCR; Subkey: ".osproj"; ValueType: string; ValueName: ""; ValueData: "OpenStudio.Project"; Flags: uninsdeletevalue
Root: HKCR; Subkey: ".s13"; ValueType: string; ValueName: ""; ValueData: "OpenStudio.Project"; Flags: uninsdeletevalue
Root: HKCR; Subkey: "OpenStudio.Project"; ValueType: string; ValueName: ""; ValueData: "OpenStudio Project"; Flags: uninsdeletekey
Root: HKCR; Subkey: "OpenStudio.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey
Root: HKCR; Subkey: "OpenStudio.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent; Check: CanLaunchInstalledApp

[Code]
var
  CanLaunchInstalledAppValue: Boolean;
  StartupSelfTestReportPath: string;

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

function RunPrerequisiteInstaller(const FilePath, Parameters, FriendlyName: string): Boolean;
var
  ResultCode: Integer;
begin
  if not FileExists(FilePath) then
  begin
    MsgBox(
      FriendlyName + ' installer was not found at:' + #13#10 + FilePath + #13#10#13#10 +
      'Rebuild the installer with prerequisite staging enabled.',
      mbCriticalError,
      MB_OK
    );
    Result := False;
    exit;
  end;

  if not Exec(FilePath, Parameters, '', SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
  begin
    MsgBox('Failed to start ' + FriendlyName + ' installer.', mbCriticalError, MB_OK);
    Result := False;
    exit;
  end;

  Result := ResultCode = 0;
end;

procedure InstallOrRepairPrerequisites();
var
  WebView2InstallerPath: string;
  VCRedistInstallerPath: string;
begin
  WebView2InstallerPath := ExpandConstant('{app}\prereqs\windows\{#WebView2Bootstrapper}');
  VCRedistInstallerPath := ExpandConstant('{app}\prereqs\windows\{#VCRedistInstaller}');

  SetInstallStatus('Installing runtime dependencies...', 'Repairing Microsoft Visual C++ Redistributable');
  if not RunPrerequisiteInstaller(VCRedistInstallerPath, '/install /passive /norestart', 'Microsoft Visual C++ Redistributable') then
  begin
    CanLaunchInstalledAppValue := False;
    MsgBox(
      'OpenStudio could not install or repair the Microsoft Visual C++ Redistributable automatically.' + #13#10#13#10 +
      'Please repair or install it manually, then relaunch OpenStudio.',
      mbCriticalError,
      MB_OK
    );
    exit;
  end;

  SetInstallStatus('Installing runtime dependencies...', 'Repairing Microsoft Edge WebView2 Runtime');
  if not RunPrerequisiteInstaller(WebView2InstallerPath, '/silent /install', 'Microsoft Edge WebView2 Runtime') then
  begin
    CanLaunchInstalledAppValue := False;
    MsgBox(
      'OpenStudio could not install or repair the Microsoft Edge WebView2 Runtime automatically.' + #13#10#13#10 +
      'Please install or repair WebView2 Runtime manually, then relaunch OpenStudio.',
      mbCriticalError,
      MB_OK
    );
  end;
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

  if CanLaunchInstalledAppValue and (not RunStartupSelfTest()) then
    CanLaunchInstalledAppValue := False;
end;

function CanLaunchInstalledApp(): Boolean;
begin
  Result := CanLaunchInstalledAppValue;
end;
