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
#define WebView2Bootstrapper "MicrosoftEdgeWebView2Setup.exe"
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

function HasVersionedSubdirectory(const RootPath: string): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;

  if not DirExists(RootPath) then
    exit;

  if FindFirst(AddBackslash(RootPath) + '*', FindRec) then
  begin
    try
      repeat
        if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
           (FindRec.Name <> '.') and
           (FindRec.Name <> '..') then
        begin
          Result := True;
          exit;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function IsWebView2RuntimeInstalled(): Boolean;
begin
  Result :=
    HasVersionedSubdirectory(ExpandConstant('{commonpf32}\Microsoft\EdgeWebView\Application')) or
    HasVersionedSubdirectory(ExpandConstant('{commonpf64}\Microsoft\EdgeWebView\Application'));
end;

function IsVCRedistInstalled(): Boolean;
var
  Installed: Cardinal;
begin
  Result :=
    RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and
    (Installed = 1);
end;

function ValidateInstalledRuntimePayload(): Boolean;
var
  MissingItems: string;
begin
  MissingItems := '';

  if not FileExists(ExpandConstant('{app}\OpenStudio.exe')) then
    MissingItems := MissingItems + #13#10 + ' - OpenStudio.exe';
  if not FileExists(ExpandConstant('{app}\webui\index.html')) then
    MissingItems := MissingItems + #13#10 + ' - webui\index.html';
  if not DirExists(ExpandConstant('{app}\effects')) then
    MissingItems := MissingItems + #13#10 + ' - effects';
  if not DirExists(ExpandConstant('{app}\scripts')) then
    MissingItems := MissingItems + #13#10 + ' - scripts';
  if not FileExists(ExpandConstant('{app}\models\basic_pitch_nmp.onnx')) then
    MissingItems := MissingItems + #13#10 + ' - models\basic_pitch_nmp.onnx';
  if not FileExists(ExpandConstant('{app}\ffmpeg.exe')) then
    MissingItems := MissingItems + #13#10 + ' - ffmpeg.exe';

  Result := MissingItems = '';

  if not Result then
    MsgBox(
      'OpenStudio installed, but required runtime files are missing:' + MissingItems + #13#10#13#10 +
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

procedure InstallMissingPrerequisites();
var
  WebView2InstallerPath: string;
  VCRedistInstallerPath: string;
begin
  WebView2InstallerPath := ExpandConstant('{app}\prereqs\windows\{#WebView2Bootstrapper}');
  VCRedistInstallerPath := ExpandConstant('{app}\prereqs\windows\{#VCRedistInstaller}');

  if not IsVCRedistInstalled() then
  begin
    if not RunPrerequisiteInstaller(VCRedistInstallerPath, '/install /quiet /norestart', 'Microsoft Visual C++ Redistributable') then
    begin
      CanLaunchInstalledAppValue := False;
      MsgBox(
        'OpenStudio could not install the Microsoft Visual C++ Redistributable automatically.' + #13#10#13#10 +
        'Please repair or install it manually, then relaunch OpenStudio.',
        mbCriticalError,
        MB_OK
      );
      exit;
    end;
  end;

  if not IsWebView2RuntimeInstalled() then
  begin
    if not RunPrerequisiteInstaller(WebView2InstallerPath, '/silent /install', 'Microsoft Edge WebView2 Runtime') then
    begin
      CanLaunchInstalledAppValue := False;
      MsgBox(
        'OpenStudio could not install the Microsoft Edge WebView2 Runtime automatically.' + #13#10#13#10 +
        'Please install or repair WebView2 Runtime manually, then relaunch OpenStudio.',
        mbCriticalError,
        MB_OK
      );
      exit;
    end;
  end;

  if not IsVCRedistInstalled() then
  begin
    CanLaunchInstalledAppValue := False;
    MsgBox(
      'The Microsoft Visual C++ Redistributable still appears to be missing after installation.' + #13#10#13#10 +
      'OpenStudio will not be launched automatically.',
      mbCriticalError,
      MB_OK
    );
    exit;
  end;

  if not IsWebView2RuntimeInstalled() then
  begin
    CanLaunchInstalledAppValue := False;
    MsgBox(
      'The Microsoft Edge WebView2 Runtime still appears to be missing after installation.' + #13#10#13#10 +
      'OpenStudio will not be launched automatically.',
      mbCriticalError,
      MB_OK
    );
    exit;
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
  InstallMissingPrerequisites();

  if CanLaunchInstalledAppValue and (not ValidateInstalledRuntimePayload()) then
    CanLaunchInstalledAppValue := False;
end;

function CanLaunchInstalledApp(): Boolean;
begin
  Result := CanLaunchInstalledAppValue;
end;
