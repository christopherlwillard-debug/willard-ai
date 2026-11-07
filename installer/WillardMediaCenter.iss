; Build on Windows with Inno Setup after scripts/windows/build-release.mjs stages
; build\windows. The installer intentionally does not include PostgreSQL or
; FFmpeg: PostgreSQL owns user data and FFmpeg remains an optional tool.
#define MyAppName "Willard Media Center"
#define MyAppPublisher "Willard Media Center"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define ReleaseDir "..\build\windows"

[Setup]
AppId={{C8A6D0E6-8B1D-4AC0-9DB6-8E9B0D2A65EF}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Willard Media Center
DefaultGroupName={#MyAppName}
OutputBaseFilename=WillardMediaCenter-{#MyAppVersion}-Setup
OutputDir=..\build\installer
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\icons\willard.ico
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile=willard.ico
DisableProgramGroupPage=yes
ChangesAssociations=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

; Remove only packaged application payload directories before copying the new
; version. User data, .env, logs, backup credentials, and updates live under
; LOCALAPPDATA and are deliberately outside {app}.
[InstallDelete]
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\api-runtime"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\icons"
Type: files; Name: "{app}\version.json"
Type: files; Name: "{app}\payload-manifest.json"

[Files]
Source: "{#ReleaseDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{localappdata}\Willard Media Center"
Name: "{localappdata}\Willard Media Center\logs"
Name: "{localappdata}\Willard Media Center\updates"

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\desktop\WillardMediaCenter.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\icons\willard.ico"; Comment: "Start your local Willard Media Center"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\desktop\WillardMediaCenter.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\icons\willard.ico"; Tasks: desktopicon; Comment: "Start your local Willard Media Center"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\desktop\WillardMediaCenter.ps1"""; WorkingDir: "{app}"; Description: "Launch Willard Media Center"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\web"
Type: filesandordirs; Name: "{app}\api-runtime"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\icons"

[Code]
function StopWillardServices(RequireLauncher: Boolean): String;
var
  ResultCode: Integer;
  Launcher: String;
begin
  Result := '';
  Launcher := ExpandConstant('{app}\desktop\WillardMediaCenter.ps1');
  if not FileExists(Launcher) then begin
    if RequireLauncher then begin
      Result := 'Willard Media Center cannot verify that its services are stopped because the installed shutdown helper is missing. Reinstall or repair the same installation to restore its launcher, then retry. The existing installation was left unchanged.';
    end;
    exit;
  end;
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + Launcher + '" -Stop',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
    Result := 'Willard Media Center could not start its shutdown helper. Close the application and try again.';
    exit;
  end;
  if ResultCode <> 0 then begin
    Result := 'Willard Media Center did not stop cleanly. The existing installation was left unchanged; close running Media Center processes and try again.';
    exit;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExistingRuntime: String;
begin
  ExistingRuntime := ExpandConstant('{app}\runtime\node.exe');
  Result := StopWillardServices(FileExists(ExistingRuntime));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  StopError: String;
begin
  if CurUninstallStep = usUninstall then begin
    StopError := StopWillardServices(True);
    if StopError <> '' then begin
      Log(StopError);
      SuppressibleMsgBox(StopError, mbError, MB_OK, IDOK);
      Abort;
    end;
  end;
end;
