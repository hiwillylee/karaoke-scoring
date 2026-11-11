; installer.iss — Inno Setup 設定，產出點兩下就能安裝的 .exe
; 由 build_windows.ps1 呼叫，不需要手動執行。

#define MyAppName "唱歌評分"
#ifndef MyAppVersion
  #define MyAppVersion "2.2.0"
#endif

[Setup]
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Karaoke Scoring
DefaultDirName={autopf}\KaraokeScoring
DefaultGroupName={#MyAppName}
OutputDir={#MyOutputDir}
OutputBaseFilename={#MyAppName}-{#MyAppVersion}-安裝檔
SetupIconFile={#MyIcon}
Compression=lzma2/fast
SolidCompression=no
; 套件裡有大量檔案，用比較大的區塊會快很多
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppName}.exe

[Languages]
Name: "chinesetraditional"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "建立桌面捷徑"; GroupDescription: "附加工作:"

[InstallDelete]
; 升級時先清掉舊版的程式檔。Inno Setup 預設只覆蓋、不刪除，舊版多出來的檔案
; （例如 CUDA 版 torch 的 DLL、舊的 .dist-info、torch_directml）會跟新版混在一起，
; 讓 torch 載入失敗。使用者的曲庫與設定在 %LOCALAPPDATA%\KaraokeScoring，不受影響。
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\lib"
Type: filesandordirs; Name: "{app}\python"

[Files]
Source: "{#MyStageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"
Name: "{group}\移除 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppName}.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppName}.exe"; Description: "立即啟動 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Messages]
chinesetraditional.WelcomeLabel2=接下來會把 [name/ver] 安裝到這台電腦。%n%n程式自己帶了所需的一切，不需要另外安裝 Python 或其他軟體。%n%n安裝檔案較大（含語音分離模型），請預留足夠的磁碟空間。
