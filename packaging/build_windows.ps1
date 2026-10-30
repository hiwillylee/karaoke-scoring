# build_windows.ps1 — 在 Windows 上打包成點兩下安裝的 .exe
#
# 產出的安裝檔自己帶著 Python、所有套件、ffmpeg 與 Demucs 權重，
# 使用者不需要安裝 Python 或任何其他東西。
#
# 事前需要（都是免費的）：
#   1. uv          winget install astral-sh.uv
#   2. Inno Setup  winget install JRSoftware.InnoSetup
#      （沒有 Inno Setup 也可以，會改成輸出免安裝的 zip）
#
# 用法（在專案根目錄開 PowerShell）：
#   packaging\build_windows.ps1                 # 預設：NVIDIA CUDA 版
#   packaging\build_windows.ps1 -Backend cpu    # 純 CPU，體積小很多
#   packaging\build_windows.ps1 -Backend xpu    # Intel 顯示卡
#
# 關於顯示卡加速：同一份 PyTorch 只能內含一種 GPU 後端，CUDA 版與 XPU 版
# 是不同的 wheel。程式執行時會自動偵測、跑不動就退回 CPU，所以選錯不會壞掉，
# 只是該張卡不會被加速。

[CmdletBinding()]
param(
  [ValidateSet('cuda', 'cpu', 'xpu', 'directml')]
  [string]$Backend = 'cuda',
  [string]$CudaTag = 'cu126',
  [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Join-Path $PSScriptRoot '..')
$Proj = (Get-Location).Path
$AppName = '唱歌評分'
$Build = Join-Path $Proj 'build-win'
$Stage = Join-Path $Build 'stage'

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "找不到 $cmd。$hint"
  }
}

Write-Host '==> 檢查建置環境'
Need 'uv' '請先安裝：winget install astral-sh.uv'

Write-Host '==> 準備 CPython 3.12'
uv python install 3.12
$PyBin = (uv python find 3.12).Trim()
$PyRoot = Split-Path $PyBin -Parent
if (-not (Test-Path (Join-Path $PyRoot 'python.exe'))) { $PyRoot = Split-Path $PyRoot -Parent }
Write-Host "    Python：$PyRoot"

if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Write-Host "==> 建立打包用的虛擬環境（後端：$Backend）"
$BuildVenv = Join-Path $Build 'venv'
uv venv --python 3.12 $BuildVenv
$env:VIRTUAL_ENV = $BuildVenv

switch ($Backend) {
  'cuda'     { uv pip install torch torchaudio --index-url "https://download.pytorch.org/whl/$CudaTag" }
  'xpu'      { uv pip install torch torchaudio --index-url 'https://download.pytorch.org/whl/xpu' }
  'cpu'      { uv pip install torch torchaudio --index-url 'https://download.pytorch.org/whl/cpu' }
  'directml' {
    # torch-directml 會鎖定特定的 torch 版本，所以讓它自己帶
    uv pip install torch-directml
  }
}
uv pip install demucs torchcrepe librosa soundfile numpy scipy cryptography segno 'yt-dlp[default]'

Write-Host '==> 確認後端真的可用'
$check = & (Join-Path $BuildVenv 'Scripts\python.exe') -c @"
import torch
print('torch', torch.__version__)
print('cuda', torch.cuda.is_available())
print('xpu', bool(getattr(torch, 'xpu', None) and torch.xpu.is_available()))
"@
Write-Host $check
if ($Backend -eq 'cuda' -and ($check -join "`n") -notmatch 'cuda True') {
  Write-Warning "這台機器上偵測不到 CUDA，可能是沒有 NVIDIA 顯示卡或驅動太舊。`n            打包出來的檔案在有 N 卡的機器上仍然可用，但這裡無法驗證。"
}

Write-Host '==> 複製 Python 執行環境'
Copy-Item -Recurse -Force $PyRoot (Join-Path $Stage 'python')

Write-Host '==> 複製套件'
$SitePkgs = Join-Path $BuildVenv 'Lib\site-packages'
Copy-Item -Recurse -Force $SitePkgs (Join-Path $Stage 'lib')

Write-Host '==> 精簡不需要的檔案'
Get-ChildItem -Path (Join-Path $Stage 'lib') -Recurse -Directory -Filter '__pycache__' -EA SilentlyContinue |
  Remove-Item -Recurse -Force -EA SilentlyContinue
foreach ($d in 'torch\include', 'torch\test') {
  $p = Join-Path $Stage "lib\$d"
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Get-ChildItem -Path (Join-Path $Stage 'lib') -Recurse -Include '*.lib', '*.pdb' -EA SilentlyContinue |
  Remove-Item -Force -EA SilentlyContinue

Write-Host '==> 複製程式與網頁資源'
$AppDir = Join-Path $Stage 'app'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
foreach ($item in 'server.py', 'analyze.py', 'launcher.py', 'library.py', 'fetcher.py', 'tunnel.py', 'index.html', 'js', 'css', 'config', 'assets') {
  Copy-Item -Recurse -Force (Join-Path $Proj $item) (Join-Path $AppDir $item)
}

Write-Host '==> 附上第三方授權聲明'
# ffmpeg／mutagen／lameenc／soxr 是 GPL／LGPL 授權，散佈時要附上授權全文，
# 詳見 THIRD_PARTY_LICENSES.md。
$LicDir = Join-Path $AppDir 'licenses'
New-Item -ItemType Directory -Force -Path $LicDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $Proj 'packaging\licenses\*') $LicDir
Copy-Item -Force (Join-Path $Proj 'THIRD_PARTY_LICENSES.md') (Join-Path $LicDir 'THIRD_PARTY_LICENSES.md')
Copy-Item -Force (Join-Path $Proj 'THIRD_PARTY_LICENSES.md') (Join-Path $Stage '第三方軟體授權聲明.md')

Write-Host '==> 下載並內附 ffmpeg 與 ffprobe'
$BinDir = Join-Path $AppDir 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$FfZip = Join-Path $Build 'ffmpeg.zip'
# BtbN 在 GitHub Releases 上的靜態連結建置（一樣是 GPL，跟原本 gyan.dev 同一個授權類別，
# 授權聲明已涵蓋），走 GitHub CDN。gyan.dev 本身頻寬很差，實測常常個位數 KB/s，
# 改走這裡一份 162MB 的壓縮包幾秒內就能抓完。用 curl.exe（支援續傳、比
# Invoke-WebRequest 對大檔案穩定很多）。
if (Test-Path $FfZip) { Remove-Item -Force $FfZip }
& curl.exe -L --retry 5 --retry-delay 3 -o $FfZip 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $FfZip) -or (Get-Item $FfZip).Length -lt 1MB) {
  throw "ffmpeg 下載失敗（curl exit $LASTEXITCODE）"
}
Expand-Archive -Path $FfZip -DestinationPath (Join-Path $Build 'ffmpeg') -Force
$FfExe = Get-ChildItem -Path (Join-Path $Build 'ffmpeg') -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
Copy-Item $FfExe.FullName (Join-Path $BinDir 'ffmpeg.exe')
# ffprobe 一定要一起包，不能只有 ffmpeg。Demucs 讀非 wav 的音檔（YouTube 抓下來
# 幾乎都是 webm／m4a）會先呼叫 ffprobe 探測格式（demucs/audio.py），少了它
# 只會回報「FFmpeg is not installed」這種誤導性的訊息，導致每首歌分離都失敗
# ——但用 wav 測試完全測不出來，因為 wav 走的是另一條不需要 ffprobe 的路徑。
$FpExe = Get-ChildItem -Path (Join-Path $Build 'ffmpeg') -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
if (-not $FpExe) { throw '下載回來的 ffmpeg 壓縮包裡沒有 ffprobe.exe' }
Copy-Item $FpExe.FullName (Join-Path $BinDir 'ffprobe.exe')

Write-Host '==> 下載 Demucs 權重並內附'
$env:HF_HOME = Join-Path $AppDir 'models'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
& (Join-Path $BuildVenv 'Scripts\python.exe') -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('   權重就緒')"

Write-Host '==> 產生啟動用的 .exe'
uv pip install pyinstaller
$StubPy = Join-Path $Build 'stub.py'
@'
"""點兩下啟動：指好內附資源的位置，交給內附的 Python 執行 launcher.py。"""
import os, subprocess, sys
from pathlib import Path

root = Path(sys.executable).resolve().parent
env = dict(os.environ)
env["KARAOKE_APP_ROOT"] = str(root / "app")
env["PYTHONPATH"] = str(root / "lib")
env["PYTHONDONTWRITEBYTECODE"] = "1"
python = root / "python" / "pythonw.exe"
if not python.exists():
    python = root / "python" / "python.exe"
sys.exit(subprocess.call([str(python), "-s", "-E", str(root / "app" / "launcher.py")], env=env))
'@ | Set-Content -Encoding UTF8 $StubPy

# 圖示：用專案裡的產生器做出 .ico
& (Join-Path $BuildVenv 'Scripts\python.exe') (Join-Path $Proj 'packaging\make_icon.py') `
  (Join-Path $Build 'iconset') --ico (Join-Path $Build 'icon.ico')

& (Join-Path $BuildVenv 'Scripts\pyinstaller.exe') --onefile --noconsole `
  --name $AppName --icon (Join-Path $Build 'icon.ico') `
  --distpath $Stage --workpath (Join-Path $Build 'work') --specpath $Build $StubPy

Write-Host '==> 產生安裝檔'
$Iscc = Get-Command 'ISCC.exe' -EA SilentlyContinue
if (-not $Iscc) {
  $guess = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  if (Test-Path $guess) { $Iscc = $guess } 
} else { $Iscc = $Iscc.Source }

if ($Iscc) {
  & $Iscc "/DMyAppVersion=$Version" "/DMyStageDir=$Stage" "/DMyOutputDir=$Build" `
          "/DMyIcon=$(Join-Path $Build 'icon.ico')" (Join-Path $Proj 'packaging\installer.iss')
  Write-Host "`n==> 完成：$Build\唱歌評分-$Version-安裝檔.exe"
} else {
  Write-Warning '找不到 Inno Setup（ISCC.exe），改輸出免安裝 zip。'
  Write-Warning '要產生安裝檔請先執行：winget install JRSoftware.InnoSetup'
  $Zip = Join-Path $Build "$AppName-$Version-免安裝版.zip"
  Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -Force
  Write-Host "`n==> 完成：$Zip"
}
