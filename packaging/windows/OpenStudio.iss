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
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
